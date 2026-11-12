/**
 * dsh-balance, host half.
 *
 * Serves the account balance for the provider currently serving the active
 * model on a local HTTP route the browser half polls
 * (`GET /plugins/balance?kind=<deepseek|openrouter|moonshot|zhipu|minimax|alibaba>`).
 * The API key never crosses the wire: it is resolved on the host through the
 * credentials seam (`ctx.credentials`) and the launch environment, and is sent
 * only upstream to the relevant provider.
 *
 * The client half picks `kind` from the active session's model selection; the
 * host half just maps a known provider onto its credentials + endpoints. A
 * `kind` the host does not know (or an absent query) falls back to DeepSeek,
 * preserving the plugin's original behavior in a bare install.
 *
 * Each provider is described by a {@link ProviderSpec}: one or more credential
 * references, one or more candidate endpoints (several providers mirror the
 * same API across hosts that each authenticate only their own keys), the
 * authorization form, and whether a missing seam value may fall back to the
 * ambient environment. The balance facts are normalized by
 * {@link unwrapBalance} and relayed intact to the browser, whose renderer owns
 * each provider's display shape.
 *
 * A dev mock mode (`DSH_BALANCE_MOCK=1` or `?mock=1`) serves canned balances for
 * any known kind instead of resolving a credential or calling the provider, so
 * the chip can be previewed without an account on that platform.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer / credentials Context merges into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/** Cordis plugin name (matches the profile patch row id). */
export const name = 'dsh-balance'

/** Required services: the web route registry. Credentials are resolved lazily via ctx.get. */
export const inject = ['webServer']

/** The route the browser half polls (an exact route beside the /plugins/events dev channel). */
export const BALANCE_ENDPOINT = '/plugins/balance'

/** A provider whose balance the plugin can serve. */
export type BalanceKind = 'deepseek' | 'openrouter' | 'moonshot' | 'zhipu' | 'minimax' | 'alibaba'

/**
 * Everything the host needs to fetch one provider's balance. `fallbackToEnv`
 * marks a provider whose route authenticates from the ambient environment when
 * no credential is stored in the seam (OpenRouter, and the added providers);
 * DeepSeek stays seam-only so a bare install keeps its exact original behavior.
 */
interface ProviderSpec {
  /**
   * Candidate credential references, tried in order through the credentials
   * seam, then (for `fallbackToEnv`) the launch environment. Some providers
   * name the same key differently across regions/eras (e.g. Zhipu's
   * `ZAI_API_KEY` / `GLM_API_KEY` / `ZHIPU_API_KEY`); listing them all means a
   * user's key resolves regardless of which spelling their setup uses.
   */
  apiKeyEnvs: string[]
  /**
   * Ordered candidate endpoints, tried in order. Several of the added providers
   * mirror the same API across two deployment hosts that each authenticate only
   * their own keys (Moonshot `api.moonshot.ai` vs `.cn`; Zhipu
   * `open.bigmodel.cn` vs `api.z.ai`), so a primary auth failure falls through
   * to the mirror before the request is reported as failed.
   */
  urls: string[]
  /** Whether a missing seam value may fall back to the ambient environment. */
  fallbackToEnv: boolean
  /** Authorization header form: `bearer` sends `Bearer <key>`; `raw` sends the key verbatim. */
  authScheme: 'bearer' | 'raw'
}

/** The supported provider set; a request naming an unknown kind serves DeepSeek. */
const PROVIDER_SPECS: Record<BalanceKind, ProviderSpec> = {
  deepseek: {
    apiKeyEnvs: ['DEEPSEEK_API_KEY'],
    urls: ['https://api.deepseek.com/user/balance'],
    fallbackToEnv: false,
    authScheme: 'bearer',
  },
  openrouter: {
    apiKeyEnvs: ['OPENROUTER_API_KEY'],
    urls: ['https://openrouter.ai/api/v1/credits'],
    fallbackToEnv: true,
    authScheme: 'bearer',
  },
  moonshot: {
    apiKeyEnvs: ['MOONSHOT_API_KEY'],
    urls: [
      'https://api.moonshot.ai/v1/users/me/balance',
      'https://api.moonshot.cn/v1/users/me/balance',
    ],
    fallbackToEnv: true,
    authScheme: 'bearer',
  },
  zhipu: {
    apiKeyEnvs: ['ZAI_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY'],
    urls: [
      'https://open.bigmodel.cn/api/biz/account/query-customer-account-report',
      'https://api.z.ai/api/biz/account/query-customer-account-report',
    ],
    fallbackToEnv: true,
    // The GLM quota/biz endpoints expect the key verbatim; a Bearer prefix is rejected.
    authScheme: 'raw',
  },
  minimax: {
    apiKeyEnvs: ['MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY', 'MINIMAX_API_TOKEN'],
    urls: [
      'https://www.minimax.io/v1/token_plan/remains',
      'https://api.minimaxi.com/v1/token_plan/remains',
    ],
    fallbackToEnv: true,
    authScheme: 'bearer',
  },
  // Alibaba Cloud Model Studio (Token Plan) has no balance endpoint for model
  // API keys: the quota gateway only accepts console-login or AccessKey-derived
  // tokens. The chip therefore needs no key at all — night-discount state is
  // computed client-side, and real usage percentages come from the official
  // `bl` CLI when the user has installed and logged into it (see
  // {@link alibabaPlanFacts}). The spec entry exists so `kindOf` accepts the
  // kind; its credential/endpoint fields are never consulted.
  alibaba: {
    apiKeyEnvs: ['DASHSCOPE_API_KEY', 'ALIBABA_API_KEY', 'BAILIAN_API_KEY'],
    urls: [],
    fallbackToEnv: true,
    authScheme: 'bearer',
  },
}

/** Upstream call timeout. */
const UPSTREAM_TIMEOUT_MS = 10_000

/** One hour in milliseconds (host-side countdown math for the mock reset). */
const HOUR_MS_HOST = 3_600_000

/** How long a `bl` quota reading stays fresh before the bridge re-runs it. */
const BL_CACHE_MS = 5 * 60_000

/** A failed/expired read re-checks sooner so a re-login shows up quickly. */
const BL_NONE_CACHE_MS = 60_000

/** The official Model Studio CLI, when the user installed it (`npm i -g @modelstudio/cli`). */
const BL_COMMAND = process.env.DSH_BALANCE_BL ?? 'bl'

const execFileAsync = promisify(execFile)

/** One cached `bl usage token-plan` reading, shared by every chip poll. */
let blCache: { at: number; facts: Record<string, unknown>; ttl: number } | undefined

/**
 * Read the Token Plan usage windows through the official `bl` CLI — the only
 * supported path to the console quota gateway, which rejects model API keys.
 * The CLI owns its own login (`bl auth login --console` or `--open-api`), so no
 * secret ever enters this plugin: we spawn `bl usage token-plan --output json`
 * and relay the percentages and reset times it prints. Absent CLI, absent
 * login, or any failure degrades to `{ source: 'none' }`, which the chip
 * renders as its night-discount-only form. Readings cache for five minutes so
 * the 60s chip poll does not spawn a process every tick.
 * @returns the plan facts for the client renderer.
 */
async function alibabaPlanFacts(): Promise<Record<string, unknown>> {
  const now = Date.now()
  if (blCache !== undefined && now - blCache.at < blCache.ttl) return blCache.facts
  let facts: Record<string, unknown> = { plan: 'Token Plan', source: 'none' }
  let ttl = BL_CACHE_MS
  try {
    // shell: true so Windows resolves bl.cmd; the argument list is fixed, so
    // nothing user-supplied reaches the shell string.
    const { stdout } = await execFileAsync(BL_COMMAND, ['usage', 'token-plan', '--output', 'json'], {
      timeout: 20_000,
      windowsHide: true,
      shell: true,
    })
    const parsed: unknown = JSON.parse(stdout)
    if (isRecord(parsed)) {
      if (isRecord(parsed.error)) {
        // The CLI can report an auth problem on stdout with a zero exit.
        facts.note = authNote(String(parsed.error.message ?? parsed.error.hint ?? ''))
        ttl = BL_NONE_CACHE_MS
      } else {
        // The API reports per-window ratios (0..1) or percentages; normalize to
        // percent-used and pick the shortest window, mirroring the CLI's order.
        const windows: Array<{ hours: number; label: string; used?: number; reset?: number }> = []
        for (const [field, value] of Object.entries(parsed)) {
          const match = /^per(\d+)(Hour|Day|Week|Month)(Percentage|ResetTime)$/.exec(field)
          if (match === null || typeof value !== 'number') continue
          const hours = Number(match[1]) * ({ Hour: 1, Day: 24, Week: 168, Month: 720 } as Record<string, number>)[match[2]]
          const label = `${match[1]}-${match[2].toLowerCase()}`
          const window: { hours: number; label: string; used?: number; reset?: number } =
            windows.find((entry) => entry.label === label) ?? { hours, label }
          if (match[3] === 'Percentage') window.used = value <= 1 ? value * 100 : value
          else window.reset = value
          if (!windows.includes(window)) windows.push(window)
        }
        windows.sort((left, right) => left.hours - right.hours)
        const primary = windows.find((window) => window.used !== undefined)
        if (primary !== undefined) {
          facts = {
            plan: 'Token Plan',
            source: 'bl',
            usedPercent: Math.round((primary.used ?? 0) * 100) / 100,
            windowLabel: primary.label,
            resetAt: primary.reset,
            windows: windows.map((window) => ({ label: window.label, usedPercent: window.used, resetAt: window.reset })),
          }
        }
      }
    }
  } catch (error) {
    // No CLI, expired login, timeout, or malformed output: night-discount-only
    // chip, with a note saying which so the popover is not misleading.
    const e = error as { stdout?: string; stderr?: string; code?: string | number }
    const raw = `${e.stdout ?? ''}${e.stderr ?? ''}`
    facts.note = e.code === 'ENOENT' || /not recognized|not found/i.test(raw)
      ? 'bl CLI not found — npm install -g bailian-cli'
      : authNote(raw)
    ttl = BL_NONE_CACHE_MS
  }
  maybeAutoLogin(facts.note)
  blCache = { at: now, facts, ttl }
  return facts
}

/** Turn a bl error blob into a short, actionable popover note. */
function authNote(raw: string): string {
  if (/not logged in|expired|login|sign in/i.test(raw)) {
    return 'bl console session expired — run: bl auth login --console'
  }
  return 'bl quota read failed — click the chip to retry'
}

/** How long between automatic login-terminal launches, so polls don't spam. */
const AUTO_LOGIN_COOLDOWN_MS = 10 * 60_000

/**
 * Whether an expired-session note should trigger an automatic login terminal.
 * Pure so it can be tested: only the expired-session note qualifies, the
 * opt-out env disables it, and a cooldown bounds repeated launches.
 */
export function shouldAutoLogin(note: unknown, now: number, lastSpawn: number, disabled: boolean): boolean {
  if (disabled) return false
  if (typeof note !== 'string' || !note.startsWith('bl console session expired')) return false
  return now - lastSpawn >= AUTO_LOGIN_COOLDOWN_MS
}

let lastAutoLogin = 0

/**
 * Open a visible terminal that runs the bl console login, so the user can
 * finish the browser flow without hunting for a shell. The CLI opens the
 * browser itself; `/k` keeps the window open afterwards. Windows only; a
 * no-op elsewhere. Opt out with DSH_BALANCE_NO_AUTOLOGIN=1.
 */
function maybeAutoLogin(note: unknown): void {
  const now = Date.now()
  if (!shouldAutoLogin(note, now, lastAutoLogin, process.env.DSH_BALANCE_NO_AUTOLOGIN === '1')) return
  if (process.platform !== 'win32') return
  lastAutoLogin = now
  const child = spawn('cmd.exe', [
    '/c', 'start', '"DSH balance - bl login"', 'cmd.exe', '/k',
    'bl auth login --console --console-site international',
  ], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

/**
 * Dev-only canned upstream bodies for each provider kind, used when mock mode is
 * enabled (see {@link mockEnabled}). Handy for previewing the chip rendering a
 * real balance without holding an account on every provider. Kept in the raw
 * upstream shape so the same {@link unwrapBalance} normalization runs.
 */
const MOCK_BODY: Record<BalanceKind, unknown> = {
  deepseek: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '88.00', granted_balance: '0.00', topped_up_balance: '88.00' }] },
  openrouter: { data: { total_credits: 12.5, total_usage: 2.5 } },
  moonshot: { data: { available_balance: 49.59, voucher_balance: 46.59, cash_balance: 3.0 } },
  zhipu: { data: { balance: 142.5, availableBalance: 132.5, currency: 'CNY' } },
  minimax: { base_resp: { status_code: 0 }, model_remains: [{ current_interval_remaining_count: 88, current_interval_total_count: 100, current_subscribe_title: 'Pro' }] },
  alibaba: { plan: 'Token Plan', source: 'mock', usedPercent: 4.22, windowLabel: 'monthly' },
}

/**
 * Whether this request runs in dev mock mode. Off by default; enabled by the
 * `DSH_BALANCE_MOCK=1` environment variable or a `?mock=1` query param. When on,
 * {@link handleBalance} serves {@link MOCK_BODY} for any known kind without
 * resolving a credential or calling the provider, so the chip can be previewed
 * without an account on that platform.
 */
function mockEnabled(req: IncomingMessage): boolean {
  if (process.env.DSH_BALANCE_MOCK === '1') return true
  const url = new URL(req.url ?? '/', 'http://internal')
  return url.searchParams.get('mock') === '1'
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** The known provider kinds, derived from the spec map so a new entry is picked up automatically. */
const KNOWN_KINDS = new Set<string>(Object.keys(PROVIDER_SPECS))

/** Read `kind` from the request query; an absent or unknown value serves DeepSeek. */
function kindOf(req: IncomingMessage): BalanceKind {
  const url = new URL(req.url ?? '/', 'http://internal')
  const kind = url.searchParams.get('kind')
  return kind !== null && KNOWN_KINDS.has(kind) ? (kind as BalanceKind) : 'deepseek'
}

/**
 * Resolve one provider's API key: the credentials seam first, then — for a
 * provider configured to authenticate from the ambient environment — the
 * launch environment (process, then the invoking project's .env, then the
 * Harness home's .env). Each candidate credential reference is tried in order.
 * Failures surface as an `undefined` return, which the caller reports as the
 * `no-key` chip state.
 * @param ctx - host plugin context carrying `credentials`/`launchEnvironment`.
 * @param spec - the provider descriptor.
 * @returns the key, or `undefined` when no layer supplies one.
 */
async function resolveApiKey(ctx: Context, spec: ProviderSpec): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    for (const env of spec.apiKeyEnvs) {
      const resolved = await credentials.resolve(credentialRef(env))
      const value = resolved?.value
      if (value !== undefined && value !== '') return value
    }
  }
  if (spec.fallbackToEnv) {
    for (const env of spec.apiKeyEnvs) {
      const value = launchEnvironmentOf(ctx).get(env)?.value
      if (value !== undefined && value !== '') return value
    }
  }
  return undefined
}

/**
 * Handle one balance request: resolve the key for the requested provider, call
 * the provider, relay the normalized result. Failures are reported to the
 * chip, never thrown into the server (the chip shows a retry affordance).
 */
async function handleBalance(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  const kind = kindOf(req)
  const spec = PROVIDER_SPECS[kind]
  if (mockEnabled(req)) {
    const mock = kind === 'alibaba'
      ? { ...(MOCK_BODY.alibaba as Record<string, unknown>), resetAt: Date.now() + 30 * HOUR_MS_HOST }
      : unwrapBalance(kind, MOCK_BODY[kind])
    json(res, 200, { ok: true, provider: kind, balance: mock })
    return
  }
  if (kind === 'alibaba') {
    // No credential and no upstream call: the night-discount window is public
    // pricing knowledge the client computes itself, and the optional usage
    // percentage comes from the user's own logged-in `bl` CLI.
    json(res, 200, { ok: true, provider: kind, balance: await alibabaPlanFacts() })
    return
  }
  const apiKey = await resolveApiKey(ctx, spec)
  if (apiKey === undefined) {
    json(res, 200, {
      ok: false,
      provider: kind,
      error: 'no-key',
      message: `Set ${spec.apiKeyEnvs.join(' or ')} in ~/.dsh/.credentials.yaml (or the environment)`,
    })
    return
  }
  const authorization = spec.authScheme === 'raw' ? apiKey : `Bearer ${apiKey}`
  let lastError: string | undefined
  for (const url of spec.urls) {
    try {
      const upstream = await fetch(url, {
        headers: { authorization },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      if (!upstream.ok) {
        // A mirror-only key (Moonshot, Zhipu) returns 401/403 on the host that
        // does not recognize it; fall through to the next endpoint before
        // reporting a failure. A single-endpoint provider reports directly.
        if ((upstream.status === 401 || upstream.status === 403) && spec.urls.length > 1) {
          lastError = `${kind} answered ${upstream.status}`
          continue
        }
        json(res, 200, { ok: false, provider: kind, error: 'upstream', message: `${kind} answered ${upstream.status}` })
        return
      }
      const body = (await upstream.json()) as unknown
      // Several of the added providers signal a bad key inside a 200 (e.g.
      // Zhipu returns `success: false, code: 401`), so a mirrored provider
      // falls through to its alternate host before giving up.
      if (spec.urls.length > 1 && isRecord(body) && body.success === false) {
        const code = typeof body.code === 'number' ? body.code : undefined
        if (code === 401 || code === 1001) {
          lastError = `${kind} rejected the key`
          continue
        }
      }
      const balance = unwrapBalance(kind, body)
      json(res, 200, { ok: true, provider: kind, balance })
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (spec.urls.length === 1) {
        json(res, 200, { ok: false, provider: kind, error: 'upstream', message })
        return
      }
      lastError = message
      // Network failure on one mirror: try the next endpoint.
    }
  }
  json(res, 200, { ok: false, provider: kind, error: 'upstream', message: lastError ?? 'unreachable' })
}

/**
 * Normalize one upstream body to the "balance facts" object the client
 * renderers read. DeepSeek and MiniMax return their facts at the top level;
 * OpenRouter, Moonshot, and Zhipu wrap them in a `data` key.
 */
function unwrapBalance(kind: BalanceKind, body: unknown): unknown {
  const unwrapData = kind === 'openrouter' || kind === 'moonshot' || kind === 'zhipu'
  return unwrapData && isRecord(body) && isRecord(body.data) ? body.data : body
}

/** Narrow a runtime value to a non-null object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Mount the balance route.
 * @param ctx - host plugin context carrying `webServer`.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BALANCE_ENDPOINT,
    handler: (req, res) => { void handleBalance(ctx, req, res) },
  }), 'dsh-balance: balance route')
}
