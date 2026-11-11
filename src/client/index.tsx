/**
 * dsh-balance, browser half.
 *
 * Renders a balance chip in two seats of the composer. In a running session it
 * sits in the composer dock — the `conversation.composer.dock` slot, the
 * "ambient entries below the composer card" extension point: the status strip
 * under the search bar that carries the activity, usage and context pills —
 * pinned to the right end of that strip, after the context meter. While the
 * session is still blank (the hero screen) it sits in the composer tool row
 * beside the model selector (`conversation.input.right`), and the first send
 * flies it down to the dock. It polls the host route served by the node half
 * (`GET /plugins/balance`), so the API key never reaches the browser.
 *
 * The chip is provider-aware: it reads the *active session's* selected model
 * from the model-directory store (`ctx.modelDirectories`) and asks the host for
 * the balance of the provider that model rides on. A model on the `openrouter`
 * route shows the
 * OpenRouter remaining credits, a `moonshotai` route shows the Moonshot/Kimi
 * available balance, a `zai` route shows the Zhipu/GLM (Z.ai) account balance,
 * and a `minimax` route shows the MiniMax plan remaining. Any other route
 * (including a DeepSeek model, or an unknown route keeping the plugin's
 * original behavior) shows the DeepSeek account balance. The balance shown
 * therefore follows whichever provider the active model is on.
 *
 * States: loading text → amount (click to refresh), or a muted error pill
 * with the reason in a tooltip. Refreshes every minute, on click, whenever the
 * active session changes, AND as soon as the active session's model is switched
 * (via its model-directory store) — so flipping a model in the dropdown flips
 * the chip to that provider's balance immediately. The two seats hand over via
 * a remembered position (FLIP): each instance flies in from where the previous
 * one sat, so the swap on the first send reads as one continuous pill.
 *
 * The status dot has provider meaning: DeepSeek marks its peak/off-peak
 * billing window (green = off-peak, red = peak; peak hours are 01:00–04:00 and
 * 06:00–10:00 UTC). OpenRouter marks remaining credits (green = credits left,
 * red = exhausted), Moonshot/Zhipu/MiniMax mark a positive remaining balance
 * or quota (green = left, red = exhausted).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the conversation SlotMap merge (the
// 'conversation.composer.dock' declaration) so
// PropsRuntime<'conversation.composer.dock'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Cordis plugin name — unused here (the entry name comes from the loader row), kept for symmetry. */
export const name = 'dsh-balance'

/**
 * Required services: the slot registry (provided by the client runtime). The
 * model-directory service (`ctx.modelDirectories`) is read lazily and treated
 * as optional — without it the chip keeps its original DeepSeek behavior.
 */
export const inject = ['slots']

/** How often the chip re-polls the balance (ms). */
const REFRESH_INTERVAL_MS = 60_000

/** Host route served by the node half. */
const BALANCE_ENDPOINT = '/plugins/balance'

/** A provider whose balance the host can serve. */
type BalanceKind = 'deepseek' | 'openrouter' | 'moonshot' | 'zhipu' | 'minimax' | 'alibaba'

/**
 * The minimal model-directory face the chip reads the active session's
 * provider from and subscribes to so it re-polls the moment the model (and thus
 * its provider) changes. This is a structural match on the runtime's
 * `ModelDirectoryResolver` / `ModelDirectory` store, kept dependency-free.
 */
interface ModelDirectoryStoreLike {
  getSnapshot(): { current?: { provider?: string; model?: string } | null }
  subscribe(fn: () => void): () => void
}
interface ModelDirectoryServiceLike {
  directoryFor(sessionId: SessionId): { store: ModelDirectoryStoreLike }
}

/** Wire shape of the host route (normalized upstream payload, provider-specific). */
interface BalanceResponse {
  ok: boolean
  provider?: BalanceKind
  error?: string
  message?: string
  balance?: {
    // DeepSeek shape (host relays the body at the top level).
    is_available?: boolean
    balance_infos?: Array<{
      currency: string
      total_balance: string
      granted_balance: string
      topped_up_balance: string
    }>
    // OpenRouter shape (unwrapped from `data` by the host, from /api/v1/credits).
    total_credits?: number
    total_usage?: number
    // Moonshot shape (unwrapped from `data` by the host, from /v1/users/me/balance).
    available_balance?: number
    voucher_balance?: number
    cash_balance?: number
    // Zhipu shape (unwrapped from `data` by the host, from the account report).
    balance?: number
    availableBalance?: number
    total_balance?: number
    totalBalance?: number
    rechargeAmount?: number
    currency?: string
    // MiniMax shape (host relays the body at the top level, from /v1/token_plan/remains).
    base_resp?: { status_code?: number; status_msg?: string }
    model_remains?: Array<{
      current_interval_usage_count?: number
      current_interval_remaining_count?: number
      current_interval_remains_count?: number
      current_interval_remaining_percent?: number
      current_interval_total_count?: number
      current_subscribe_title?: string
      plan_name?: string
      plan?: string
    }>
    // Alibaba Cloud Model Studio shape (host-built, from the official bl CLI
    // when logged in; `source: 'none'` means night-discount-only mode).
    plan?: string
    source?: string
    usedPercent?: number
    windowLabel?: string
    resetAt?: number
    windows?: Array<{ label?: string; usedPercent?: number; resetAt?: number }>
  }
}

/** The rendered result of one refresh, fully shaped for the chip. */
type DisplayState =
  | { kind: 'loading' }
  | {
      kind: 'ok'
      provider: BalanceKind
      symbol: string
      total: string
      /** Tooltip heading: the provider (or plan) the amount belongs to. */
      heading: string
      /** Tooltip body: the provider's own breakdown line. */
      detail: string
      /** DeepSeek only: whether the fetch landed inside a peak billing window. */
      peak?: boolean
      /** Alibaba only: percent of the plan window's credits already used. */
      usedPercent?: number
      /** Alibaba only: the window the percentage belongs to (`1-month`, …). */
      windowLabel?: string
      /** Alibaba only: epoch ms when that window resets. */
      resetAt?: number
      /** Alibaba only: the active model's discount, in percent off. */
      discount?: number
      /** Alibaba only: whether the discount runs at night or all day. */
      discountScope?: 'night' | 'always'
      dotColor: CSSProperties['background']
    }
  | { kind: 'error'; message: string }

/**
 * Strip the modlens vision plugin's synthetic route prefix before matching.
 *
 * modlens registers `modlens-<upstream>` (and the legacy `deepseek-modlens`)
 * wrapper routes so a text-only model can accept pasted images. Those routes
 * bill the upstream provider's account, so they resolve to that provider's
 * balance kind; without this, selecting a "(modlens vision)" model fell through
 * to DeepSeek and the chip showed a missing-key error instead of the OpenRouter
 * credit the session was actually spending.
 */
function unwrapModlensProvider(provider: string): string {
  const p = provider.toLowerCase()
  if (p === 'deepseek-modlens') return 'deepseek'
  return p.startsWith('modlens-') ? p.slice('modlens-'.length) : p
}

/**
 * Map a provider route id to the balance the plugin serves. These are the
 * routes the plugin knows; a provider route it does not recognize (including a
 * custom provider id) falls back to DeepSeek, so such a session keeps showing
 * the DeepSeek balance rather than failing the chip. The route ids are the DSH
 * pi-ai built-in catalog names; each regional (`-cn`) variant maps to the same
 * kind because the host tries the matching mirror endpoint for that key's site.
 */
function kindForProvider(provider: string, model?: string): BalanceKind {
  const p = unwrapModlensProvider(provider)
  if (p === 'openrouter') return 'openrouter'
  if (p === 'moonshotai' || p === 'moonshotai-cn') return 'moonshot'
  if (p === 'zai' || p === 'zai-coding-cn' || p === 'zhipu') return 'zhipu'
  if (p === 'minimax' || p === 'minimax-cn') return 'minimax'
  if (p === 'alibaba-cloud' || p === 'alibaba' || p === 'dashscope' || p === 'bailian' || p === 'qwen' || p === 'model-studio') return 'alibaba'
  // A known provider id always wins over the model-name hint: DeepSeek sells
  // Qwen-family names on its own platform too, and its balance is the point.
  if (p === 'deepseek') return 'deepseek'
  // Custom openai-compat channels aimed at Model Studio carry an arbitrary
  // provider id; Qwen models only exist there, so the model name identifies them.
  if (model !== undefined && model.toLowerCase().startsWith('qwen')) return 'alibaba'
  return 'deepseek'
}

/**
 * The sessions-list snapshot face this chip reads the open session from. DSH
 * alpha.1 carried the selected id directly as `current`; alpha.2 removed it
 * (the Sessions service now documents that "navigation belongs to view
 * owners"), so the open session is the row the main view retains. Both shapes
 * are matched structurally so the chip runs on either Host.
 */
interface SessionsSnapshotLike {
  current?: SessionId | null
  byId?: Record<string, { id?: SessionId; retainedBy?: { mainView?: number }; blank?: boolean }>
}

/**
 * Resolve the session the user currently has open.
 *
 * alpha.1: the list snapshot's `current`. alpha.2: that field is gone, so fall
 * back to the session retained by the main view — the same derivation
 * `ui-session` and `DocumentTitle` use. Returns undefined when nothing is open,
 * which the chip treats as its DeepSeek fallback (never failing the chip).
 * @param snapshot - the sessions list snapshot supplied by `useSessions`.
 * @returns the open session id, or undefined when none is retained.
 */
function currentSessionId(snapshot: SessionsSnapshotLike): SessionId | undefined {
  if (snapshot.current !== undefined && snapshot.current !== null) return snapshot.current
  return Object.values(snapshot.byId ?? {}).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
}

/**
 * Whether the open session is still blank — no message sent yet, which is
 * exactly the window the Hero composer is on screen. The shell derives its own
 * hero state from this same flag, so the chip's hero seat appears and
 * disappears with the hero itself.
 * @param snapshot - the sessions list snapshot supplied by `useSessions`.
 * @returns true while the open session has no messages.
 */
function sessionIsBlank(snapshot: SessionsSnapshotLike): boolean {
  const id = currentSessionId(snapshot)
  if (id === undefined) return false
  // The live store keys `byId` by session id; tolerate a row that carries its
  // own id under a different key, the same way `currentSessionId` scans values.
  const row = snapshot.byId?.[id] ?? Object.values(snapshot.byId ?? {}).find((candidate) => candidate.id === id)
  return row?.blank === true
}

/**
 * Resolve the balance kind for the active session's model from the shared
 * model-directory store — the same state the composer's model seat writes, so
 * the chip follows the exact selection the session will use next. A missing
 * session, an absent model-directory service, a directory that is not yet
 * resolved (its `current` is `null` until the catalog loads), or any lookup
 * failure falls back to DeepSeek, never failing the chip; the store
 * subscription re-polls once `current` resolves or changes.
 * @param modelDirectories - the session model-selection service, when composed.
 * @param sessionId - the active session, or undefined when none is current.
 * @returns the balance kind to query.
 */
function kindForSession(
  modelDirectories: ModelDirectoryServiceLike | undefined,
  sessionId: SessionId | undefined,
): BalanceKind {
  if (sessionId === undefined || modelDirectories === undefined) return 'deepseek'
  try {
    const current = modelDirectories.directoryFor(sessionId).store.getSnapshot().current
    const provider = current?.provider
    return provider === undefined ? 'deepseek' : kindForProvider(provider, current?.model)
  } catch {
    // e.g. an addressed subagent session with no directory, or a scope not yet bound.
    return 'deepseek'
  }
}

/**
 * The active session's model id, when the directory has resolved one. Used to
 * pick the model-specific Token Plan discount; absent directories and lookup
 * failures yield undefined, which renders the plan without a promo pill.
 */
function modelForSession(
  modelDirectories: ModelDirectoryServiceLike | undefined,
  sessionId: SessionId | undefined,
): string | undefined {
  if (sessionId === undefined || modelDirectories === undefined) return undefined
  try {
    return modelDirectories.directoryFor(sessionId).store.getSnapshot().current?.model
  } catch {
    return undefined
  }
}

/** Currency code → glyph; unknown codes fall back to the code itself. */
function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'CNY': return '¥'
    case 'USD': return '$'
    case 'EUR': return '€'
    case 'GBP': return '£'
    case 'JPY': return '¥'
    default: return `${currency} `
  }
}

/**
 * DeepSeek peak/off-peak billing (official footnote:
 * https://api-docs.deepseek.com/quick_start/pricing). Peak is **Monday–Friday**,
 * Beijing time (UTC+8) 09:00–12:00 and 14:00–18:00 — which is 01:00–04:00 and
 * 06:00–10:00 UTC on the same day. Every other hour, including the whole
 * weekend, is off-peak (half the peak price). Both peak windows fall inside the
 * same UTC day as their Beijing weekday, so the weekend check uses the UTC day.
 * @param now - the instant to classify (defaults to now).
 * @returns whether the instant falls inside a peak window.
 */
export function isPeakHour(now: Date = new Date()): boolean {
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false // Saturday/Sunday are off-peak all day
  const hour = now.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/** The two daily peak windows as UTC hour ranges `[start, end)`, weekdays only. */
const PEAK_WINDOWS_UTC: readonly (readonly [number, number])[] = [[1, 4], [6, 10]]

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * The next peak/off-peak boundary strictly after `now`, with the state it
 * leads into. Weekday windows repeat weekly, so a boundary always exists
 * within seven days; the scan walks day by day and checks each window's
 * edges in chronological order.
 * @param now - the instant to search from (defaults to now).
 * @returns the boundary instant and whether it starts (`'peak'`) or ends
 *   (`'off'`) a peak window.
 */
export function nextTransition(now: Date = new Date()): { readonly at: Date; readonly to: 'peak' | 'off' } {
  const t0 = now.getTime()
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset)
    const day = new Date(dayStart).getUTCDay()
    if (day === 0 || day === 6) continue
    for (const [start, end] of PEAK_WINDOWS_UTC) {
      const startAt = dayStart + start * HOUR_MS
      if (startAt > t0) return { at: new Date(startAt), to: 'peak' }
      const endAt = dayStart + end * HOUR_MS
      if (endAt > t0) return { at: new Date(endAt), to: 'off' }
    }
  }
  return { at: new Date(t0), to: 'off' } // unreachable: a weekday edge is always within 7 days
}

/**
 * Render a duration as a short countdown, e.g. `1h 20m`, `45m`, `2h` or
 * `under 1m`. Minutes are rounded, so the tooltip never shows `0m` for a
 * round hour or a just-started minute.
 * @param ms - milliseconds remaining.
 * @returns the countdown text.
 */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000))
  if (totalMinutes < 1) return 'under 1m'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const rest = hours % 24
    return rest === 0 ? `${days}d` : `${days}d ${rest}h`
  }
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

/** Format an instant in the viewer's system timezone with AM/PM tags. */
function localClock(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }).format(date)
}

/** The short English weekday (`Mon`) of an instant in the viewer's timezone. */
function localWeekday(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date)
}

/** The viewer's timezone as a short offset label, e.g. `GMT+5:30`. */
function localZoneLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'shortOffset' }).formatToParts(new Date())
    const zone = parts.find((part) => part.type === 'timeZoneName')?.value
    if (zone !== undefined && zone.length > 0) return zone
  } catch { /* older Intl: fall through to the manual offset */ }
  const offset = -new Date().getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `GMT${sign}${Math.floor(abs / 60)}${abs % 60 === 0 ? '' : `:${String(abs % 60).padStart(2, '0')}`}`
}

/** Midnight UTC of the Monday of the week containing `now`. */
function utcMondayStart(now: Date): number {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return dayStart - ((now.getUTCDay() + 6) % 7) * DAY_MS
}

/**
 * The peak windows described in the viewer's own system time with AM/PM tags
 * and a zone label — e.g. `Peak Mon–Fri 6:30 AM – 9:30 AM & 11:30 AM – 3:30 PM
 * (GMT+5:30)`. The windows are fixed UTC intervals, so their local clock times
 * repeat every weekday; a representative Monday of the current week is used,
 * which keeps DST-shifted zones honest. The weekday range spans the local
 * weekdays the windows actually touch (negative offsets see them start on
 * Sunday evenings).
 * @param now - the week to describe (defaults to now).
 * @returns the local-time window label.
 */
export function peakWindowsLocalLabel(now: Date = new Date()): string {
  const monday = utcMondayStart(now)
  const at = (dayOffset: number, hour: number) => new Date(monday + dayOffset * DAY_MS + hour * HOUR_MS)
  const firstStart = at(0, 1)
  const lastEnd = at(4, 10)
  const firstDay = localWeekday(firstStart)
  const lastDay = localWeekday(lastEnd)
  const days = firstDay === lastDay ? firstDay : `${firstDay}–${lastDay}`
  const window1 = `${localClock(at(0, 1))} – ${localClock(at(0, 4))}`
  const window2 = `${localClock(at(0, 6))} – ${localClock(at(0, 10))}`
  return `Peak ${days} ${window1} & ${window2} (${localZoneLabel()})`
}

/**
 * Alibaba Cloud Model Studio night discount (official Token Plan terms and the
 * Model Studio CLI blog): every day 22:00–08:00 **Beijing time (UTC+8)**, which
 * is 14:00–24:00 UTC — a single daily window, weekends included. Supported
 * models consume fewer credits inside it; the per-model rates live in
 * {@link alibabaDiscountForModel}.
 * @param now - the instant to classify (defaults to now).
 * @returns whether the instant falls inside the night discount window.
 */
export function isAlibabaNight(now: Date = new Date()): boolean {
  return now.getUTCHours() >= 14
}

/**
 * The next night/day boundary strictly after `now`, with the state it leads
 * into. The window repeats daily, so a boundary always exists within two days.
 * @param now - the instant to search from (defaults to now).
 * @returns the boundary instant and whether it starts (`'night'`) or ends
 *   (`'day'`) the discount window.
 */
export function nextAlibabaTransition(now: Date = new Date()): { readonly at: Date; readonly to: 'night' | 'day' } {
  const t0 = now.getTime()
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset)
    const startAt = dayStart + 14 * HOUR_MS
    if (startAt > t0) return { at: new Date(startAt), to: 'night' }
    const endAt = dayStart + 24 * HOUR_MS
    if (endAt > t0) return { at: new Date(endAt), to: 'day' }
  }
  return { at: new Date(t0), to: 'day' } // unreachable: a daily edge is always within 2 days
}

/**
 * The night discount window in the viewer's own system time with AM/PM tags
 * and a zone label — e.g. `Nights 7:30 PM – 5:30 AM (GMT+5:30)`. The window is
 * a fixed UTC interval, so a representative day of the current week keeps
 * DST-shifted zones honest.
 * @param now - the day to describe (defaults to now).
 * @returns the local-time window label.
 */
export function alibabaNightLocalLabel(now: Date = new Date()): string {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const start = new Date(dayStart + 14 * HOUR_MS)
  const end = new Date(dayStart + 24 * HOUR_MS)
  return `Nights ${localClock(start)} – ${localClock(end)} (${localZoneLabel()})`
}

/**
 * The active model's Token Plan discount, in percent off, and whether it runs
 * only at night or all day. Qwen models take 40% off at night, DeepSeek models
 * served through the plan take 50% off at night, and the qwen4-max-preview
 * launch promo is 80% off around the clock. Models outside the promo list
 * (GLM, Wan, …) get no discount and therefore no countdown pill.
 * @param model - the active model id, when the directory has resolved one.
 * @returns the discount, or undefined when the model is not in the promo.
 */
export function alibabaDiscountForModel(model?: string): { readonly percent: number; readonly scope: 'night' | 'always' } | undefined {
  const m = (model ?? '').toLowerCase()
  if (m.startsWith('qwen4-max-preview')) return { percent: 80, scope: 'always' }
  if (m.startsWith('deepseek')) return { percent: 50, scope: 'night' }
  if (m.startsWith('qwen')) return { percent: 40, scope: 'night' }
  return undefined
}

/**
 * Shape the OpenRouter response into the chip display state. The host serves
 * `total_credits`/`total_usage` (from `/api/v1/credits`), whose difference is
 * the remaining balance in dollars.
 */
function renderOpenRouter(data: BalanceResponse): DisplayState {
  const info = data.balance
  const totalCredits = typeof info?.total_credits === 'number' ? info.total_credits : undefined
  const totalUsage = typeof info?.total_usage === 'number' ? info.total_usage : undefined
  if (totalCredits === undefined || totalUsage === undefined) {
    return { kind: 'error', message: 'No OpenRouter balance info returned' }
  }
  const remaining = Math.max(0, totalCredits - totalUsage)
  const total = remaining.toFixed(2)
  return {
    kind: 'ok',
    provider: 'openrouter',
    symbol: '$',
    total,
    heading: 'OpenRouter',
    detail: `Remaining $${total}`,
    dotColor: remaining > 0
      ? 'var(--dsw-alias-state-success-primary)'
      : 'var(--dsw-alias-state-error-primary)',
  }
}

/** Shape the DeepSeek response into the chip display state (the original behavior). */
function renderDeepSeek(data: BalanceResponse): DisplayState {
  const info = data.balance?.balance_infos?.[0]
  if (info === undefined) return { kind: 'error', message: 'No balance info returned' }
  const symbol = currencySymbol(info.currency)
  const breakdown = `Total ${symbol}${info.total_balance} · Granted ${symbol}${info.granted_balance} · Topped up ${symbol}${info.topped_up_balance}`
  const peak = isPeakHour()
  return {
    kind: 'ok',
    provider: 'deepseek',
    symbol,
    total: info.total_balance,
    heading: 'DeepSeek',
    detail: breakdown,
    peak,
    dotColor: peak
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-state-success-primary)',
  }
}

/**
 * Shape the Moonshot (Kimi) response into the chip display state. The host
 * unwraps `data` and serves `available_balance` (USD, cash + voucher) from
 * `/v1/users/me/balance`.
 */
function renderMoonshot(data: BalanceResponse): DisplayState {
  const info = data.balance
  const available = typeof info?.available_balance === 'number' ? info.available_balance : undefined
  if (available === undefined) return { kind: 'error', message: 'No Moonshot balance info returned' }
  const total = Math.max(0, available).toFixed(2)
  const cash = typeof info?.cash_balance === 'number' ? info.cash_balance : undefined
  const voucher = typeof info?.voucher_balance === 'number' ? info.voucher_balance : undefined
  const breakdown = cash !== undefined && voucher !== undefined
    ? `Cash $${cash.toFixed(2)} · Voucher $${voucher.toFixed(2)}`
    : `Available $${total}`
  return {
    kind: 'ok',
    provider: 'moonshot',
    symbol: '$',
    total,
    heading: 'Moonshot',
    detail: breakdown,
    dotColor: available > 0
      ? 'var(--dsw-alias-state-success-primary)'
      : 'var(--dsw-alias-state-error-primary)',
  }
}

/**
 * Shape the Zhipu / GLM (Z.ai) response into the chip display state. The host
 * unwraps the account-report container, whose balance sits under a variety of
 * names (`balance`, `availableBalance`, `available_balance`, …) with a currency
 * that defaults to CNY. This is a prepaid account amount in the provider's
 * currency, not necessarily dollars.
 */
function renderZhipu(data: BalanceResponse): DisplayState {
  const info = data.balance
  const container = info !== undefined && info !== null && typeof info === 'object' && !Array.isArray(info)
    ? (info as Record<string, unknown>)
    : undefined
  if (container === undefined) return { kind: 'error', message: 'No Zhipu balance info returned' }
  // The report may be a list of resource-pack entries; take the first that
  // names a numeric balance.
  const entries = Array.isArray(container.data)
    ? (container.data as Array<Record<string, unknown>>)
    : [container]
  let remaining: number | undefined
  for (const entry of entries) {
    for (const key of ['available_balance', 'availableBalance', 'balance', 'total_balance', 'totalBalance', 'rechargeAmount']) {
      const value = entry[key]
      if (typeof value === 'number') { remaining = value; break }
    }
    if (remaining !== undefined) break
  }
  if (remaining === undefined) return { kind: 'error', message: 'No Zhipu balance amount returned' }
  const currency = typeof container.currency === 'string' ? container.currency : 'CNY'
  const symbol = currencySymbol(currency)
  const total = Math.max(0, remaining).toFixed(2)
  return {
    kind: 'ok',
    provider: 'zhipu',
    symbol,
    total,
    heading: 'Zhipu',
    detail: `Remaining ${symbol}${total}`,
    dotColor: remaining > 0
      ? 'var(--dsw-alias-state-success-primary)'
      : 'var(--dsw-alias-state-error-primary)',
  }
}

/**
 * Shape the MiniMax response into the chip display state. The host relays the
 * top-level token-plan body; the first `model_remains` entry carries the
 * remaining prompts (MiniMax reports the mislabeled `current_interval_usage_count`
 * as the remainder, with explicit `*_remaining_*` aliases) or a remaining
 * percentage. This is a subscription quota, not a prepaid dollar balance, so
 * the chip renders the count or percent rather than a currency amount.
 */
function renderMiniMax(data: BalanceResponse): DisplayState {
  const info = data.balance
  const entry = info?.model_remains?.[0]
  if (entry === undefined) return { kind: 'error', message: 'No MiniMax plan info returned' }
  const remainingCount = typeof entry.current_interval_remaining_count === 'number'
    ? entry.current_interval_remaining_count
    : typeof entry.current_interval_remains_count === 'number'
      ? entry.current_interval_remains_count
      : typeof entry.current_interval_usage_count === 'number'
        ? entry.current_interval_usage_count
        : undefined
  const remainingPercent = typeof entry.current_interval_remaining_percent === 'number'
    ? entry.current_interval_remaining_percent
    : undefined
  const plan = entry.current_subscribe_title ?? entry.plan_name ?? entry.plan ?? 'MiniMax'
  if (remainingCount !== undefined) {
    const label = remainingPercent !== undefined ? `${remainingCount} (${remainingPercent}%)` : String(remainingCount)
    return {
      kind: 'ok',
      provider: 'minimax',
      symbol: '',
      total: label,
      heading: plan,
      detail: remainingPercent !== undefined
        ? `${remainingCount} prompts remaining (${remainingPercent}%)`
        : `${remainingCount} prompts remaining`,
      dotColor: remainingCount > 0
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-error-primary)',
    }
  }
  if (remainingPercent !== undefined) {
    return {
      kind: 'ok',
      provider: 'minimax',
      symbol: '',
      total: `${remainingPercent}%`,
      heading: plan,
      detail: `${remainingPercent}% remaining`,
      dotColor: remainingPercent > 0
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-error-primary)',
    }
  }
  return { kind: 'error', message: 'No MiniMax remaining value returned' }
}

/**
 * Shape the Alibaba Cloud Model Studio response into the chip display state.
 * The host serves plan facts, not a currency balance: with the official `bl`
 * CLI logged in, the percent of the current window's credits already used and
 * its reset time; without it, the chip runs in night-discount-only mode and
 * says where the credits live. The discount pill comes from the active model.
 */
function renderAlibaba(data: BalanceResponse, model?: string): DisplayState {
  const info = data.balance
  const plan = typeof info?.plan === 'string' ? info.plan : 'Token Plan'
  const used = typeof info?.usedPercent === 'number' ? info.usedPercent : undefined
  const discount = alibabaDiscountForModel(model)
  const resetIn = typeof info?.resetAt === 'number' && info.resetAt > Date.now()
    ? ` · resets in ${formatCountdown(info.resetAt - Date.now())}`
    : ''
  const detail = used !== undefined
    ? `${used.toFixed(2)}% of ${info?.windowLabel ?? 'plan'} credits used${resetIn}`
    : 'Credits live in the Model Studio console'
  return {
    kind: 'ok',
    provider: 'alibaba',
    symbol: '',
    total: used !== undefined ? `${used.toFixed(2)}%` : plan,
    heading: plan,
    detail,
    usedPercent: used,
    windowLabel: info?.windowLabel,
    resetAt: info?.resetAt,
    discount: discount?.percent,
    discountScope: discount?.scope,
    dotColor: used === undefined || used < 90
      ? 'var(--dsw-alias-state-success-primary)'
      : 'var(--dsw-alias-state-error-primary)',
  }
}

/** Choose the provider-aware display state for a host response. */
function displayState(data: BalanceResponse, model?: string): DisplayState {
  switch (data.provider ?? 'deepseek') {
    case 'openrouter': return renderOpenRouter(data)
    case 'moonshot': return renderMoonshot(data)
    case 'zhipu': return renderZhipu(data)
    case 'minimax': return renderMiniMax(data)
    case 'alibaba': return renderAlibaba(data, model)
    case 'deepseek':
    default: return renderDeepSeek(data)
  }
}

/** DeepSeek brand mark (whale), LobeHub 24×24 glyph — fills `currentColor`, so it inherits the chip color. */
const DEEPSEEK_LOGO_PATH = 'M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z'

/** OpenRouter brand mark (route), LobeHub 24×24 glyph — fills `currentColor`. */
const OPENROUTER_LOGO_PATH = 'M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z'

/** Moonshot/Kimi brand mark (Kimi), LobeHub 24×24 glyph — two paths, both fill `currentColor`. */
const MOONSHOT_LOGO_PATHS = [
  'M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z',
  'M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z',
]

/** Zhipu / Z.ai (GLM) brand mark, LobeHub 24×24 glyph — fills `currentColor`. */
const ZHIPU_LOGO_PATH = 'M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z'

/** MiniMax brand mark, LobeHub 24×24 glyph — fills `currentColor`. */
const MINIMAX_LOGO_PATH = 'M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z'

/** Alibaba Cloud brand mark (bracket-and-bar), LobeHub 24×24 glyph — two paths, both fill `currentColor`. */
const ALIBABA_LOGO_PATHS = [
  'M14.752 4.64h5.274C22.242 4.64 24 6.475 24 8.691V15.8a3.947 3.947 0 01-3.974 3.975h-5.274l1.299-1.835 3.822-1.222c.688-.23 1.146-.918 1.146-1.605v-5.81c0-.687-.458-1.375-1.146-1.605L16.05 6.475l-1.3-1.835zM2.98 15.111c0 .688.46 1.376 1.147 1.606l3.822 1.146 1.3 1.835H3.974A3.947 3.947 0 010 15.723V8.69c0-2.216 1.758-4.05 3.975-4.05h5.273L7.95 6.474 4.127 7.697c-.688.23-1.146.918-1.146 1.606v5.808z',
  'M16.051 11.213H8.025v1.835h8.026v-1.835z',
]

/**
 * One or more LobeHub 24×24 brand-mark paths per provider, all filled with
 * `currentColor` so they inherit the chip's muted label color across
 * light/dark themes. Every known provider has a real mark; adding a provider
 * means adding an entry here (and its kind to {@link BalanceKind}).
 */
const PROVIDER_LOGO_PATHS: Record<BalanceKind, string[]> = {
  deepseek: [DEEPSEEK_LOGO_PATH],
  openrouter: [OPENROUTER_LOGO_PATH],
  moonshot: MOONSHOT_LOGO_PATHS,
  zhipu: [ZHIPU_LOGO_PATH],
  minimax: [MINIMAX_LOGO_PATH],
  alibaba: ALIBABA_LOGO_PATHS,
}

/**
 * A small theme-friendly brand glyph for a provider, rendered left of the
 * amount. Each provider's mark fills `currentColor`, so it adapts to the
 * chip's muted label color across light/dark themes.
 */
function ProviderLogo({ provider, size = 14 }: { provider: BalanceKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      style={{ flexShrink: 0, display: 'block' }}
      aria-hidden="true"
    >
      {PROVIDER_LOGO_PATHS[provider].map((d) => <path key={d} d={d} />)}
    </svg>
  )
}

/**
 * CSS order that pins the chip to the right end of the composer dock. The dock
 * renders its slot entries before the context meter ("10%"), so a large order
 * moves the chip's entry after it — the far-right position of the strip.
 */
const DOCK_ORDER = 999

/** Slim pill sized to sit inline with the composer dock's status pills. */
const chipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  // The chip is the row's fixed item: it takes exactly the width its own
  // content asks for, so the dock's gap rhythm stays intact and the pill never
  // stretches against its neighbours.
  width: 'max-content',
  // No margin of its own: the dock owns the row's spacing, and the right-end
  // pinning happens on the slot outlet, not here.
  margin: 0,
  padding: '0 4px',
  // The same text line as the activity/usage/context pills, so the chip reads
  // as one of the strip's items instead of a button dropped onto it.
  height: 20,
  minWidth: 0,
  flexShrink: 0,
  boxSizing: 'border-box',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
}

/** The amount text; the only part of the chip that yields width in a tight foot. */
const amountStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * The status dot. It keeps one size in every state: the chip is never asked to
 * give up its content, so there is no second, mark-and-dot form for it to
 * resize into.
 */
const dotBaseStyle: CSSProperties = {
  flex: 'none',
  width: 8,
  height: 8,
  borderRadius: '50%',
}

/** One line of the hover tooltip; muted lines render in the secondary label tone. */
export interface TooltipLine {
  readonly text: string
  readonly muted?: boolean
  /** DeepSeek heading only: the countdown to the next billing boundary. */
  readonly countdown?: string
  /** DeepSeek heading only: which window the hover instant falls in. */
  readonly peak?: boolean
  /** DeepSeek heading only: countdown ink — green when peak is ending, red when it approaches. */
  readonly countdownColor?: CSSProperties['color']
  /** DeepSeek heading only: under five minutes to the boundary, so the countdown waves. */
  readonly urgent?: boolean
  /** The provider breakdown line, rendered with its first segment emphasized. */
  readonly detail?: boolean
}

/** Below this many milliseconds to the boundary, the countdown starts waving. */
const URGENT_MS = 5 * 60_000

/** The multi-color wave played by a near-zero countdown and chip timer. */
const WAVE_ANIMATION = 'dsh-balance-wave 1.6s ease-in-out infinite'

/** The relief ink the viewer picked: teal for "the peak is draining". */
const TEAL_INK = '#2fbfa0'

/** The clock hand's sweep: a full turn, then a rest, on a slow loop. */
const CLOCK_SWEEP = 'dsh-balance-clock 3.6s cubic-bezier(0.65, 0, 0.35, 1) infinite'

/** The small pop that lands when the hand completes its turn. */
const CLOCK_POP = 'dsh-balance-clock-pop 3.6s ease-in-out infinite'

/**
 * Inject the keyframes once per document: the wave (success → warn → error
 * ink cycling) and the clock (a 360° hand sweep with a settle, plus the pop
 * on the dial). A plugin cannot ship a stylesheet, so the animations live in
 * a single idempotent `<style>` element the first chip mounts.
 */
function ensureWaveKeyframes(): void {
  if (typeof document === 'undefined' || document.getElementById('dsh-balance-keyframes') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-balance-keyframes'
  style.textContent = '@keyframes dsh-balance-wave{0%,100%{color:var(--dsw-alias-state-success-primary)}30%{color:var(--dsw-alias-state-warn-primary)}60%{color:var(--dsw-alias-state-error-primary)}}'
    + '@keyframes dsh-balance-clock{0%{transform:rotate(0deg)}40%{transform:rotate(360deg)}100%{transform:rotate(360deg)}}'
    + '@keyframes dsh-balance-clock-pop{0%,100%{transform:scale(1)}30%{transform:scale(1.14)}45%{transform:scale(1)}}'
  document.head.appendChild(style)
}

/** Whether the viewer asked the platform to avoid motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * Build the tooltip lines for a display state, evaluated at hover time so the
 * countdown is fresh. DeepSeek gets a status heading carrying the countdown to
 * the next billing boundary — always during peak ("off-peak in Xh Ym"), and
 * within the last hour of off-peak ("peak in Xh Ym") — followed by the peak
 * windows in the viewer's own system time with AM/PM tags and a zone label.
 * @param state - the current display state.
 * @param now - the hover instant (defaults to now).
 * @returns the tooltip's lines, heading first.
 */
export function tooltipLines(state: DisplayState, now: Date = new Date()): TooltipLine[] {
  if (state.kind === 'loading') return [{ text: 'Loading balance…' }]
  if (state.kind === 'error') {
    return [
      { text: 'Balance unavailable' },
      { text: state.message, muted: true },
      { text: 'Click to retry', muted: true },
    ]
  }
  const lines: TooltipLine[] = []
  if (state.provider === 'deepseek') {
    const peak = isPeakHour(now)
    const { at, to } = nextTransition(now)
    const ms = at.getTime() - now.getTime()
    const countdown = peak
      ? `off-peak in ${formatCountdown(ms)}`
      : to === 'peak' && ms <= HOUR_MS ? `peak in ${formatCountdown(ms)}` : undefined
    lines.push({
      text: `${state.heading} · ${peak ? 'Peak billing' : 'Off-peak · 50% price'}`,
      countdown,
      peak,
      // The countdown reads as relief or warning, so its ink is the OPPOSITE
      // of the status: teal while the red window drains away, red while it
      // approaches through the last hour of off-peak.
      countdownColor: peak ? TEAL_INK : 'var(--dsw-alias-state-error-primary)',
      urgent: countdown !== undefined && ms <= URGENT_MS,
    })
    lines.push({ text: peakWindowsLocalLabel(now), muted: true })
  } else if (state.provider === 'alibaba') {
    const night = isAlibabaNight(now)
    const { at, to } = nextAlibabaTransition(now)
    const ms = at.getTime() - now.getTime()
    const scope = state.discountScope
    const countdown = scope === 'night'
      ? night
        ? `day in ${formatCountdown(ms)}`
        : to === 'night' && ms <= HOUR_MS ? `−${state.discount}% in ${formatCountdown(ms)}` : undefined
      : undefined
    const status = state.discount === undefined
      ? ''
      : scope === 'always'
        ? ` · −${state.discount}% limited-time`
        : night ? ` · Night −${state.discount}% now` : ` · Nights −${state.discount}%`
    lines.push({
      text: `${state.heading}${status}`,
      countdown,
      peak: countdown !== undefined && !night,
      countdownColor: night ? TEAL_INK : 'var(--dsw-alias-state-error-primary)',
      urgent: countdown !== undefined && ms <= URGENT_MS,
    })
    if (scope !== 'always') lines.push({ text: alibabaNightLocalLabel(now), muted: true })
    if (state.usedPercent !== undefined) {
      const reset = typeof state.resetAt === 'number' && state.resetAt > now.getTime()
        ? ` · resets in ${formatCountdown(state.resetAt - now.getTime())}`
        : ''
      lines.push({ text: `${state.usedPercent.toFixed(2)}% of ${state.windowLabel ?? 'plan'} credits used${reset}`, muted: true })
    } else {
      lines.push({ text: 'Usage % appears once the bl CLI is installed and logged in', muted: true })
    }
  } else {
    lines.push({ text: state.heading })
  }
  lines.push({ text: state.detail, detail: true })
  lines.push({ text: 'Click to refresh', muted: true })
  return lines
}

/** The chip's inline timer, with the tone its ink and wave follow. */
export interface ChipTimer {
  readonly text: string
  readonly peak: boolean
  readonly urgent: boolean
  readonly color: CSSProperties['color']
}

/**
 * The chip's inline timer: the countdown to the next billing boundary, shown
 * beside the dot — always during peak, and in the last hour of off-peak.
 * Undefined otherwise, so quiet off-peak hours and every other provider stay
 * bare. Its ink follows the tooltip's relief/warning rule (teal while peak
 * drains, red while it approaches), and under five minutes it waves. Minute
 * granularity is the point: the chip repaints on the 60s poll, which keeps
 * the timer honest without a second clock.
 * @param now - the render instant (defaults to now).
 * @returns the timer, or undefined when there is nothing to count.
 */
export function chipTimer(now: Date = new Date()): ChipTimer | undefined {
  const peak = isPeakHour(now)
  const { at, to } = nextTransition(now)
  const ms = at.getTime() - now.getTime()
  if (!peak && !(to === 'peak' && ms <= HOUR_MS)) return undefined
  return {
    text: formatCountdown(ms),
    peak,
    urgent: ms <= URGENT_MS,
    color: peak ? TEAL_INK : 'var(--dsw-alias-state-error-primary)',
  }
}

/**
 * The Alibaba chip's inline pill: the model's night discount while the window
 * runs (teal, counting down to daylight), the same discount in red through the
 * last hour before the window opens, and a steady teal `−80%` for all-day
 * launch promos. Models outside the promo list stay bare. Mirrors
 * {@link chipTimer}'s relief/warning ink rule with the window inverted.
 * @param now - the render instant (defaults to now).
 * @param discount - the active model's percent off, when it has one.
 * @param scope - whether the discount runs at night or all day.
 * @returns the timer, or undefined when there is nothing to count.
 */
export function alibabaChipTimer(
  now: Date = new Date(),
  discount?: number,
  scope?: 'night' | 'always',
): ChipTimer | undefined {
  if (discount === undefined) return undefined
  if (scope === 'always') {
    return { text: `−${discount}%`, peak: false, urgent: false, color: TEAL_INK }
  }
  const night = isAlibabaNight(now)
  const { at, to } = nextAlibabaTransition(now)
  const ms = at.getTime() - now.getTime()
  if (night) {
    return { text: `−${discount}% · ${formatCountdown(ms)}`, peak: false, urgent: ms <= URGENT_MS, color: TEAL_INK }
  }
  if (to === 'night' && ms <= HOUR_MS) {
    return { text: `−${discount}% in ${formatCountdown(ms)}`, peak: true, urgent: ms <= URGENT_MS, color: 'var(--dsw-alias-state-error-primary)' }
  }
  return undefined
}

/**
 * The horizontal lane the popover may occupy. It floats `position: fixed`
 * above the app, so it can extend past the conversation column into empty
 * chrome — the chip sits at the column's right edge, so clamping to the
 * column would push every popover left. What it must not do is hide behind
 * a bar: a right side panel or a left sidebar. Walk from the chip's laid-out
 * row up through every ancestor (body included — panels often portal to the
 * top level); a tall, wide sibling bounds the lane when it displaces the
 * column (starts at its edge) or floats over it (`fixed`/`absolute`/`sticky`
 * starting inside it) — the conversation's own static flow, like the message
 * list spanning the full width, must not read as a bar. The nearest edges
 * win; with no bars, the window edges do.
 * @param anchor - the chip's own element.
 * @returns the x the popover's left and right edges must stay inside.
 */
export function popoverBounds(anchor: HTMLElement): { left: number; right: number } {
  const slot = anchor.closest<HTMLElement>('[data-slot]')
  let left = 8
  let right = window.innerWidth - 8
  let node: HTMLElement | null = slot?.parentElement ?? anchor.parentElement
  while (node !== null) {
    const parent: HTMLElement | null = node.parentElement
    if (parent === null) break
    const own = node.getBoundingClientRect()
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue
      const r = sibling.getBoundingClientRect()
      if (r.height <= 200 || r.width <= 100) continue
      const position = getComputedStyle(sibling).position
      const floating = position === 'fixed' || position === 'absolute' || position === 'sticky'
      // Right-docked bar: displacing or overlaying. Static flow that merely
      // spans the width is not a bar.
      if (r.right >= window.innerWidth - 2 && (r.left >= own.right - 1 || (floating && r.left > own.left + 8))) {
        right = Math.min(right, r.left - 8)
      }
      // Left-docked rail: the mirror test.
      if (r.left <= 2 && (r.right <= own.left + 1 || (floating && r.right < own.right - 8))) {
        left = Math.max(left, r.right + 8)
      }
    }
    node = parent
  }
  return { left, right: Math.max(left + 200, right) }
}

/** Hover panel in the DSH popover idiom: elevated layer, hairline border, 12px text. */
const tooltipStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 250,
  maxWidth: 340,
  padding: '9px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 'var(--dsw-radius-md)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.32)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: '17px',
  whiteSpace: 'normal',
  pointerEvents: 'none',
  textAlign: 'left',
  transition: 'left 220ms cubic-bezier(0.22, 0.61, 0.36, 1)',
}

/** Hairline separating the tooltip's content from its footer hint. */
const tooltipDividerStyle: CSSProperties = {
  height: '0.5px',
  margin: '3px 0',
  background: 'var(--dsw-alias-border-l1)',
}

/** The countdown in the tooltip header: pushed right, fixed-width digits so it never jitters. */
const tooltipCountdownStyle: CSSProperties = {
  marginLeft: 'auto',
  paddingLeft: 14,
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 700,
}

/** The timer beside the chip's dot: a small pill, tabular, on the text line. */
const chipTimerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  padding: '0 7px',
  borderRadius: 999,
}

/** Tint wash for the chip timer pill, in the timer's own ink. */
function timerPillStyle(color: string): CSSProperties {
  return {
    color,
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    border: `0.5px solid color-mix(in srgb, ${color} 38%, transparent)`,
  }
}

/** Tinted pill holding the billing status word; `color` is the state token. */
function statusPillStyle(color: string): CSSProperties {
  return {
    padding: '1px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    color,
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    border: `0.5px solid color-mix(in srgb, ${color} 38%, transparent)`,
  }
}

/** The wave animation, unless the viewer opted out of motion. */
function waveStyle(urgent: boolean | undefined): CSSProperties {
  return urgent === true && !prefersReducedMotion() ? { animation: WAVE_ANIMATION } : {}
}

/**
 * The timer pill's clock mark: a hairline dial whose hand sweeps a full
 * turn, rests, and turns again, with a small pop as the hand lands. The
 * stroke is `currentColor`, so the sub-5-minute wave paints the dial too.
 * Under `prefers-reduced-motion` the hand rests at twelve and nothing moves.
 * @returns the glyph element.
 */
function ClockGlyph() {
  const still = prefersReducedMotion()
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{ flex: 'none', overflow: 'visible', ...(still ? {} : { animation: CLOCK_POP }) }}
    >
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.55" />
      <g style={still ? undefined : { transformOrigin: '6px 6px', animation: CLOCK_SWEEP }}>
        <line x1="6" y1="6" x2="6" y2="2.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/**
 * The chip's hover tooltip: a styled panel in the DSH popover idiom — the
 * native `title` attribute renders as an unstyled OS bubble that reads as a
 * glitch against the app chrome. A 3px accent bar on the left carries the
 * billing state (red peak, green off-peak, business blue elsewhere); the
 * header shows the provider mark, the status in a tinted pill, and the
 * countdown on the right in relief/warning ink — waving through the state
 * colors in its final five minutes. The breakdown's first segment is
 * emphasized, and a hairline separates the content from the footer hint. It
 * is portal-mounted to `document.body` and `position: fixed` from the chip's
 * measured rect, so no ancestor's overflow can clip it and no ancestor's
 * transform can hijack its fixed positioning — the Electron desktop shell
 * animates the composer subtree, and a transformed ancestor re-anchors
 * fixed coordinates, which showed the popover clipped at the window edge
 * there. It anchors ABOVE the chip (both seats sit low in
 * the window). Horizontally it centers on the chip — the icon is the pivot
 * — and the free lane between the bars (side panel, sidebar) is passed in:
 * the panel slides the minimum distance to stay inside it, gliding on the
 * `left` transition rather than jumping under a bar.
 * @param props - the display state, the chip's viewport rect, and the lane
 * the popover must stay inside.
 * @returns the tooltip element.
 */
function ChipTooltip({ state, rect, bounds }: { readonly state: DisplayState; readonly rect: DOMRect; readonly bounds: { left: number; right: number } }) {
  const lines = tooltipLines(state)
  // Center the panel on the chip — the icon is the pivot — then shift it the
  // minimum distance to stay inside the lane between the bars, so it only
  // moves when a panel, rail, or the window edge would otherwise occlude it.
  const width = Math.min(340, Math.max(200, bounds.right - bounds.left))
  const center = rect.left + rect.width / 2
  const left = Math.max(bounds.left, Math.min(center - width / 2, bounds.right - width))
  const peakInk = 'var(--dsw-alias-state-error-primary)'
  const offInk = 'var(--dsw-alias-state-success-primary)'
  const accent = state.kind !== 'ok'
    ? 'var(--dsw-alias-state-warn-primary)'
    : state.provider === 'deepseek'
      ? (isPeakHour() ? peakInk : offInk)
      : 'var(--dsw-alias-state-business-primary)'
  return createPortal(
    <div role="tooltip" style={{ ...tooltipStyle, left, bottom: window.innerHeight - rect.top + 6, width, minWidth: Math.min(250, width), borderLeft: `3px solid ${accent}` }}>
      {lines.flatMap((line, index) => {
        const isFooter = index === lines.length - 1
        const node = line.countdown !== undefined ? (
          <span key={index} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {state.kind === 'ok' && <ProviderLogo provider={state.provider} />}
            <span style={statusPillStyle(line.peak === true ? peakInk : offInk)}>{line.text}</span>
            <span style={{ ...tooltipCountdownStyle, color: line.countdownColor, ...waveStyle(line.urgent) }}>
              {line.countdown}
            </span>
          </span>
        ) : line.detail === true ? (
          <span key={index}>
            <span style={{ fontWeight: 600 }}>{line.text.split(' · ')[0]}</span>
            <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>
              {line.text.includes(' · ') ? ` · ${line.text.split(' · ').slice(1).join(' · ')}` : ''}
            </span>
          </span>
        ) : (
          <span key={index} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {index === 0 && state.kind === 'ok' && <ProviderLogo provider={state.provider} />}
            <span
              style={
                isFooter
                  ? { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }
                  : line.muted === true
                    ? { color: 'var(--dsw-alias-label-secondary)' }
                    : { fontWeight: 600 }
              }
            >
              {line.text}
            </span>
          </span>
        )
        // A hairline before the footer line separates content from the hint.
        return isFooter && lines.length > 1
          ? [<div key={`divider-${index}`} style={tooltipDividerStyle} />, node]
          : [node]
      })}
    </div>,
    document.body,
  )
}

/** An element the dock pin styled, with the `order` value to restore on unmount. */
export interface DockPin {
  readonly element: HTMLElement
  readonly previous: string
}

/**
 * Pin the chip to the right end of the composer dock.
 *
 * The slot runtime wraps every list entry in a `[data-slot]` element, and that
 * wrapper — not the chip — is the dock row's flex child, so the order has to go
 * on it. The wrapper may also be transparent (`display: contents`) or absent in
 * an older runtime, in which case the chip's own element is the laid-out child;
 * the order is written on both so the pin holds in every case, and each element
 * hands back the value the caller restores on unmount.
 * @param anchor - the chip's own element.
 * @returns every element that was styled, with its previous `order`.
 */
export function applyDockOrder(anchor: HTMLElement): DockPin[] {
  // `closest` never matches the node itself unless the selector does, so the
  // two arms stay distinct: the slot element when the runtime wraps the entry
  // (current releases), otherwise the anchor alone (older ones).
  const outlet = anchor.closest<HTMLElement>('[data-slot="conversation.composer.dock"]')
  const targets = outlet === null ? [anchor] : [outlet, anchor]
  return targets.map((element) => {
    const previous = element.style.order
    element.style.order = String(DOCK_ORDER)
    return { element, previous }
  })
}

/** Where the chip was last painted, so a remount in the other seat can fly from there. */
interface ChipAnchor { readonly x: number; readonly y: number; readonly at: number }

/**
 * How stale a remembered position may be and still start a flight. A visible
 * hero chip repaints on every refresh tick, so this window — one tick plus a
 * margin — keeps its position flight-eligible for the whole time it is on
 * screen, while a position left behind long ago (a session opened directly
 * into the transcript, a page load) simply paints in place.
 */
const FLIP_WINDOW_MS = REFRESH_INTERVAL_MS + 15_000

/** The flight's duration and curve: short and decelerating, like the dock's own motion. */
const FLIP_TRANSITION = 'transform 280ms cubic-bezier(0.22, 0.61, 0.36, 1)'

let lastChipAnchor: ChipAnchor | undefined

/**
 * Record where the chip is painted, so the instance that takes over in the
 * other seat (hero tool row ⇄ composer dock) starts its flight from here. The
 * two seats are different DOM subtrees, so without this handoff the swap on
 * the first send would read as the pill teleporting.
 * @param element - the chip's own element.
 */
export function rememberChipAnchor(element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  lastChipAnchor = { x: rect.left, y: rect.top, at: Date.now() }
}

/**
 * Fly the chip in from where its previous instance sat (FLIP): translate it to
 * the old position with no transition, flush that offset so it is the
 * transition's start, then release it to its own spot. A fresh mount with no
 * recent sibling, a reduced-motion setting, or a distance under two pixels
 * paints in place instead.
 * @param element - the chip's own element, already laid out in its new seat.
 */
export function flyChipIn(element: HTMLElement): void {
  const from = lastChipAnchor
  if (from === undefined || Date.now() - from.at > FLIP_WINDOW_MS) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const here = element.getBoundingClientRect()
  const dx = from.x - here.left
  const dy = from.y - here.top
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return
  element.style.transition = 'none'
  element.style.transform = `translate(${dx}px, ${dy}px)`
  // Reading a layout property flushes the offset written above, so the
  // transition starts from it instead of collapsing both writes into one frame.
  void element.offsetWidth
  element.style.transition = FLIP_TRANSITION
  element.style.transform = ''
  window.setTimeout(() => { element.style.transition = '' }, 320)
}

/**
 * The balance chip component. Rendered by the slot runtime into either seat —
 * the composer dock (`variant: 'dock'`) or the hero tool row beside the model
 * selector (`variant: 'hero'`) — with the standard session props, which are
 * identical for both slots. `getModelDirectories` is the lazy accessor the
 * wrapper closes over, so the chip still resolves the service when the
 * model-selection plugin activates after this one.
 * @param props - composed slot props plus the seat variant and injected accessor.
 * @returns the chip element, or null when the hero seat has no blank session.
 */
export function BalanceChip({
  variant,
  getModelDirectories,
  useSessions,
}: PropsRuntime<'conversation.composer.dock'> & {
  variant: 'hero' | 'dock'
  getModelDirectories: () => ModelDirectoryServiceLike | undefined
}) {
  const [state, setState] = useState<DisplayState>({ kind: 'loading' })
  const anchorRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ rect: DOMRect; bounds: { left: number; right: number } } | null>(null)
  const activeSession = useSessions(
    (snapshot) => currentSessionId(snapshot as unknown as SessionsSnapshotLike),
  )
  const blank = useSessions(
    (snapshot) => sessionIsBlank(snapshot as unknown as SessionsSnapshotLike),
  )

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const directories = getModelDirectories()
      const kind = kindForSession(directories, activeSession)
      const model = modelForSession(directories, activeSession)
      const res = await fetch(`${BALANCE_ENDPOINT}?kind=${kind}`, { headers: { accept: 'application/json' } })
      const data = (await res.json()) as BalanceResponse
      setState(data.ok ? displayState(data, model) : { kind: 'error', message: data.message ?? data.error ?? 'unavailable' })
    } catch {
      setState({ kind: 'error', message: 'Failed to load' })
    }
  }, [getModelDirectories, activeSession])

  // Poll while visible. The hero instance stays mounted (rendering nothing)
  // once the session gets its first message, and an idle instance has no
  // reason to keep spending requests — the dock instance takes the polling
  // over in the same commit.
  useEffect(() => {
    if (variant === 'hero' && !blank) return
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, REFRESH_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [refresh, variant, blank])

  // Subscribe to the active session's model-directory store so the chip
  // re-polls as soon as the directory resolves and whenever flipping the model
  // in the dropdown changes the current provider, without waiting for the next
  // 60s tick.
  useEffect(() => {
    if (variant === 'hero' && !blank) return
    const modelDirectories = getModelDirectories()
    if (modelDirectories === undefined || activeSession === undefined) return
    let directory: { store: ModelDirectoryStoreLike }
    try {
      directory = modelDirectories.directoryFor(activeSession)
    } catch {
      return // e.g. an addressed subagent session — the timer/direct refresh still cover it.
    }
    let lastProvider = directory.store.getSnapshot().current?.provider
    const onModelChange = (): void => {
      const provider = directory.store.getSnapshot().current?.provider
      if (provider !== lastProvider) {
        lastProvider = provider
        void refresh()
      }
    }
    const unsubscribe = directory.store.subscribe(onModelChange)
    return () => { unsubscribe() }
  }, [getModelDirectories, activeSession, refresh, variant, blank])

  // Pin the chip to the dock's right end, after the context meter. The pin
  // writes `order` on the slot outlet (the dock row's real flex child) and on
  // the anchor, and restores both on unmount so an uninstall leaves the dock
  // exactly as it found it. The hero seat needs no pin — it joins the tool
  // row's own chips in slot order.
  useLayoutEffect(() => {
    if (variant !== 'dock') return
    const anchor = anchorRef.current
    if (anchor === null) return
    const pins = applyDockOrder(anchor)
    return () => {
      for (const { element, previous } of pins) element.style.order = previous
    }
  }, [variant])

  // Hand the chip's position between the two seats: fly in from where the
  // previous instance sat, and leave this position behind for the next one.
  // The hero tool row and the composer dock are different DOM subtrees, so the
  // swap on the first send reads as one continuous pill travelling down.
  useLayoutEffect(() => {
    // The wave keyframes live in one idempotent <style> the first chip mounts.
    ensureWaveKeyframes()
    const anchor = anchorRef.current
    if (anchor === null) return
    flyChipIn(anchor)
    return () => { rememberChipAnchor(anchor) }
  }, [])

  // Keep the remembered position current on every hero paint: the send flips
  // independent stores, and if the seats ever swap in separate commits the
  // dock instance still has the hero's last position to fly from.
  useLayoutEffect(() => {
    if (variant !== 'hero') return
    const anchor = anchorRef.current
    if (anchor !== null) rememberChipAnchor(anchor)
  })

  // The hero seat belongs to the blank session: the moment the first prompt
  // is sent the shell swaps to the composer view, the dock instance takes
  // over, and this one's remembered position becomes its flight's origin.
  if (variant === 'hero' && !blank) return null

  // The tooltip measures the chip on show, so it can float `position: fixed`
  // above the seat without being clipped by ancestor overflow. It centers on
  // the chip and is clamped to the lane between the bars `popoverBounds`
  // finds, so a side panel or sidebar can never cover it: it sits centered
  // normally and slides the minimum distance (smoothly, via the `left`
  // transition) when a bar narrows the lane.
  const showTip = useCallback(() => {
    const anchor = anchorRef.current
    if (anchor === null) return
    setTip({ rect: anchor.getBoundingClientRect(), bounds: popoverBounds(anchor) })
  }, [])
  const hideTip = useCallback(() => { setTip(null) }, [])

  // While the popover is open, a window resize or any layout mutation — a
  // side panel opening, the sidebar collapsing — re-measures the seat and
  // the lane, so the popover glides to the new spot instead of stranding
  // under a bar. Mutations coalesce into one measurement per frame; the
  // next hover re-measures regardless.
  useEffect(() => {
    if (tip === null) return
    const onMove = () => { showTip() }
    let frame = 0
    const onMutation = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => { frame = 0; showTip() })
    }
    window.addEventListener('resize', onMove)
    const observer = new MutationObserver(onMutation)
    observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'], childList: true, subtree: true })
    return () => {
      window.removeEventListener('resize', onMove)
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [tip !== null, showTip])

  // The DeepSeek billing countdown, evaluated on every render (the 60s poll
  // repaints it). Undefined for every other provider and quiet off-peak.
  // Alibaba carries its own night-discount pill on the same seat.
  const timer = state.kind === 'ok'
    ? state.provider === 'deepseek'
      ? chipTimer()
      : state.provider === 'alibaba'
        ? alibabaChipTimer(new Date(), state.discount, state.discountScope)
        : undefined
    : undefined

  return (
    <div ref={anchorRef}>
      {state.kind === 'loading' ? (
        <div
          style={chipStyle}
          aria-busy="true"
          aria-label="Loading balance"
          onMouseEnter={showTip}
          onMouseLeave={hideTip}
          onFocus={showTip}
          onBlur={hideTip}
        >
          <span style={amountStyle}>Loading…</span>
        </div>
      ) : state.kind === 'error' ? (
        <button
          type="button"
          style={chipStyle}
          aria-label={`Balance unavailable — ${state.message}`}
          onMouseEnter={showTip}
          onMouseLeave={hideTip}
          onFocus={showTip}
          onBlur={hideTip}
          onClick={() => { void refresh() }}
        >
          <span style={amountStyle}>Balance —</span>
        </button>
      ) : (
        <button
          type="button"
          style={chipStyle}
          aria-label={`${state.heading} ${state.symbol}${state.total}`}
          onMouseEnter={showTip}
          onMouseLeave={hideTip}
          onFocus={showTip}
          onBlur={hideTip}
          onClick={() => { void refresh() }}
        >
          <ProviderLogo provider={state.provider} />
          {/* The amount is the point of the chip, so it is never dropped for the
              account label's sake. */}
          <span style={amountStyle}>{state.symbol}{state.total}</span>
          <span role="img" aria-label={state.detail} style={{ ...dotBaseStyle, background: state.dotColor }} />
          {/* DeepSeek carries its billing countdown right on the strip, next to
              the dot: a tinted pill with a clock whose hand sweeps and pops —
              teal while the peak drains, red while it approaches, waving
              through the state colors in its final five minutes. */}
          {timer !== undefined && (
            <span style={{ ...chipTimerStyle, ...timerPillStyle(timer.color), ...waveStyle(timer.urgent) }}>
              <ClockGlyph />
              {timer.text}
            </span>
          )}
        </button>
      )}
      {tip !== null && <ChipTooltip state={state} rect={tip.rect} bounds={tip.bounds} />}
    </div>
  )
}

/**
 * Register the chip into the composer dock on the `conversation.composer.dock`
 * slot (declared by the ui-conversation package; registration is an effect that
 * unwinds when this plugin unloads). The wrapper closes over the plugin scope
 * so the chip can read the active model's provider from the model-directory
 * service — resolved lazily, because that service is optional and may
 * activate after this plugin.
 * @param ctx - client plugin context carrying `slots`.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots'], (scope: ClientContext) => {
    // Optional: the model-directory service lets the chip read the active
    // session's provider and re-poll the moment the model changes. Absent in a
    // composition without the model-selection plugin; the chip then keeps its
    // original DeepSeek behavior.
    const getModelDirectories = (): ModelDirectoryServiceLike | undefined =>
      scope.get('modelDirectories') as ModelDirectoryServiceLike | undefined
    // Order 100 keeps the chip behind the chat's own dock entries (activity at
    // 0, usage at 1); the right-end pin is applyDockOrder's job.
    scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
      name: 'conversation.composer.dock',
      id: 'balance',
      order: 100,
    }, (props) => (
      <BalanceChip variant="dock" {...props} getModelDirectories={getModelDirectories} />
    )))
    // The hero tool row beside the model selector: the same chip for a blank
    // session, so a new session shows its balance before the first send — and
    // the pill flies down to the dock when that send swaps the seats.
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'balance',
      order: 100,
    }, (props) => (
      <BalanceChip variant="hero" {...props} getModelDirectories={getModelDirectories} />
    )))
  })
}
