// Simulate the DSH browser module table to verify lib/client.js evaluates,
// registers with __ModuleLoader__, exports the plugin contract, applies into
// both composer seats (conversation.composer.dock and conversation.input.right),
// and the registered entries are the balance chip.
import { readFileSync } from 'node:fs'

/** The client-module entry id: the DSH node half derives it from the package name. */
const PACKAGE_ID = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

let handoff = null
globalThis.window = {
  __ModuleLoader__: {
    load: (h) => { handoff = h },
  },
  // The chip's refresh effect arms a timer; capture it without running it.
  setInterval: () => 0,
  clearInterval: () => {},
}

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// The bundle executes in this realm; `window` resolves via globalThis.
;(0, eval)(code)

if (handoff === null) throw new Error('bundle did not call __ModuleLoader__.load')
if (handoff.id !== PACKAGE_ID) throw new Error(`wrong id: ${handoff.id}`)

// Stub the two external platform modules the bundle requires. react provides
// hook no-ops that CAPTURE effects so the chip's refresh path can be driven
// below; jsx-runtime returns inert descriptors.
const effects = []
const reactStub = {
  useCallback: (fn) => fn,
  useEffect: (fn) => { effects.push(fn) },
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial) => [initial, () => {}],
}
const jsxRuntimeStub = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
}
const requireStub = (id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return jsxRuntimeStub
  throw new Error(`unexpected external require: ${id}`)
}

const mod = handoff.factory(requireStub)
console.log('exports:', Object.keys(mod).sort().join(', '))
if (mod.name !== 'dsh-balance') throw new Error('name mismatch')
if (JSON.stringify(mod.inject) !== JSON.stringify(['slots'])) throw new Error('inject mismatch')
if (typeof mod.apply !== 'function') throw new Error('apply missing')
if (typeof mod.BalanceChip !== 'function') throw new Error('BalanceChip missing')

// DeepSeek peak/off-peak window (official: api-docs.deepseek.com/quick_start/pricing):
// peak is Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing (UTC+8) = 01:00–04:00 and
// 06:00–10:00 UTC; weekends are off-peak all day.
if (typeof mod.isPeakHour !== 'function') throw new Error('isPeakHour missing')
const peakAt = (iso) => mod.isPeakHour(new Date(iso))
const peakCases = [
  ['2026-09-07T01:00:00Z', true, 'Monday 01:00 UTC (09:00 Beijing) is peak'],
  ['2026-09-07T02:00:00Z', true, 'Monday 02:00 UTC is peak'],
  ['2026-09-07T06:00:00Z', true, 'Monday 06:00 UTC (14:00 Beijing) is peak'],
  ['2026-09-07T04:00:00Z', false, 'Monday 04:00 UTC (12:00 Beijing) is off-peak'],
  ['2026-09-07T05:00:00Z', false, 'Monday 05:00 UTC (13:00 Beijing) is off-peak'],
  ['2026-09-11T09:00:00Z', true, 'Friday 09:00 UTC (17:00 Beijing) is peak'],
  ['2026-09-11T10:00:00Z', false, 'Friday 10:00 UTC (18:00 Beijing) is off-peak'],
  ['2026-09-12T02:00:00Z', false, 'Saturday 02:00 UTC is off-peak all day'],
  ['2026-09-13T07:00:00Z', false, 'Sunday 07:00 UTC is off-peak all day'],
]
for (const [iso, expected, label] of peakCases) {
  const actual = peakAt(iso)
  if (actual !== expected) throw new Error(`peak-hour mismatch for ${label}: got ${actual}`)
}
console.log(`peak-hour assertions: PASS (${peakCases.length} cases, incl. weekend off-peak)`)

// nextTransition: the boundary scan must agree with the peak windows.
if (typeof mod.nextTransition !== 'function') throw new Error('nextTransition missing')
const transitionCases = [
  ['2026-09-07T02:00:00Z', '2026-09-07T04:00:00.000Z', 'off', 'Monday 02:00 UTC (peak) → 04:00 off-peak'],
  ['2026-09-07T05:00:00Z', '2026-09-07T06:00:00.000Z', 'peak', 'Monday 05:00 UTC (gap) → 06:00 peak'],
  ['2026-09-07T11:00:00Z', '2026-09-08T01:00:00.000Z', 'peak', 'Monday 11:00 UTC → Tuesday 01:00 peak'],
  ['2026-09-11T10:30:00Z', '2026-09-14T01:00:00.000Z', 'peak', 'Friday 10:30 UTC → Monday 01:00 peak (weekend)'],
  ['2026-09-12T12:00:00Z', '2026-09-14T01:00:00.000Z', 'peak', 'Saturday noon → Monday 01:00 peak'],
  ['2026-09-07T04:00:00Z', '2026-09-07T06:00:00.000Z', 'peak', 'exactly at 04:00 → next edge is 06:00 peak'],
]
for (const [iso, wantAt, wantTo, label] of transitionCases) {
  const got = mod.nextTransition(new Date(iso))
  if (got.at.toISOString() !== wantAt || got.to !== wantTo) throw new Error(`transition mismatch for ${label}: got ${got.at.toISOString()} ${got.to}`)
}
console.log(`next-transition assertions: PASS (${transitionCases.length} cases)`)

// Countdown formatting and the tooltip's line structure.
if (mod.formatCountdown(4_500_000) !== '1h 15m') throw new Error('countdown h+m')
if (mod.formatCountdown(2 * 3_600_000) !== '2h') throw new Error('countdown h')
if (mod.formatCountdown(45 * 60_000) !== '45m') throw new Error('countdown m')
if (mod.formatCountdown(30_000) !== '1m') throw new Error('countdown 30s rounds to 1m')
if (mod.formatCountdown(20_000) !== 'under 1m') throw new Error('countdown under 1m')
const deepseekOk = (peak) => ({ kind: 'ok', provider: 'deepseek', symbol: '$', total: '11.97', heading: 'DeepSeek', detail: 'Total $11.97 · Granted $0.00 · Topped up $11.97', peak })
const peakTip = mod.tooltipLines(deepseekOk(true), new Date('2026-09-07T02:00:00Z'))
if (!peakTip[0].text.includes('Peak billing') || peakTip[0].countdown !== 'off-peak in 2h' || peakTip[0].peak !== true) throw new Error(`peak tooltip: ${JSON.stringify(peakTip[0])}`)
// Relief/warning ink: teal while peak drains, red while it approaches.
if (peakTip[0].countdownColor !== '#2fbfa0') throw new Error(`peak countdown ink: ${peakTip[0].countdownColor}`)
if (peakTip[0].urgent !== false || peakTip[2].detail !== true) throw new Error(`peak tooltip flags: ${JSON.stringify(peakTip)}`)
if (!/Peak .*\d/.test(peakTip[1].text) || !/\(GMT|UTC\)/.test(peakTip[1].text)) throw new Error(`window label: ${peakTip[1].text}`)
const offTip = mod.tooltipLines(deepseekOk(false), new Date('2026-09-07T05:15:00Z'))
if (!offTip[0].text.includes('Off-peak') || offTip[0].countdown !== 'peak in 45m') throw new Error(`off-peak tooltip: ${JSON.stringify(offTip[0])}`)
if (!offTip[0].countdownColor.includes('error')) throw new Error(`off-peak countdown ink: ${offTip[0].countdownColor}`)
const hotTip = mod.tooltipLines(deepseekOk(true), new Date('2026-09-07T03:57:30Z'))
if (hotTip[0].urgent !== true || hotTip[0].countdown !== 'off-peak in 3m') throw new Error(`urgent tooltip: ${JSON.stringify(hotTip[0])}`)
const farTip = mod.tooltipLines(deepseekOk(false), new Date('2026-09-07T20:00:00Z'))
if (farTip[0].countdown !== undefined) throw new Error(`far off-peak must not count down: ${JSON.stringify(farTip[0])}`)
const orTip = mod.tooltipLines({ kind: 'ok', provider: 'openrouter', symbol: '$', total: '9.74', heading: 'OpenRouter', detail: 'Remaining $9.74' }, new Date('2026-09-07T02:00:00Z'))
if (orTip[0].text !== 'OpenRouter' || orTip[0].countdown !== undefined || orTip.some((line) => line.text.includes('Peak'))) throw new Error('openrouter tooltip must stay plain')
// The chip's inline timer mirrors the tooltip's countdown rules, with the
// relief/warning ink and the sub-5-minute urgency.
const ctPeak = mod.chipTimer(new Date('2026-09-07T02:00:00Z'))
if (ctPeak.text !== '2h' || ctPeak.peak !== true || ctPeak.urgent !== false || ctPeak.color !== '#2fbfa0') throw new Error(`chip timer peak: ${JSON.stringify(ctPeak)}`)
const ctNear = mod.chipTimer(new Date('2026-09-07T05:15:00Z'))
if (ctNear.text !== '45m' || ctNear.peak !== false || !ctNear.color.includes('error')) throw new Error(`chip timer near peak: ${JSON.stringify(ctNear)}`)
const ctHot = mod.chipTimer(new Date('2026-09-07T03:57:30Z'))
if (ctHot.text !== '3m' || ctHot.urgent !== true) throw new Error(`chip timer urgent: ${JSON.stringify(ctHot)}`)
if (mod.chipTimer(new Date('2026-09-07T20:00:00Z')) !== undefined) throw new Error('chip timer quiet off-peak')
console.log('tooltip assertions: PASS (relief/warning ink, urgent wave, local windows, chip timer, plain providers)')

// Apply with a fake slot registry and a fake plugin scope exposing the optional
// model-directory service lazily (the real service registers after this plugin).
const injected = []
const injectedCbs = []
const registrations = []
let fakeModelDirectories
const slots = {
  inject: (key, cb) => { injected.push(key); injectedCbs.push(cb) },
  register: (opts, component) => { registrations.push({ opts, component }); return () => {} },
}
const ctx = {
  inject: (services, cb) => {
    if (JSON.stringify(services) !== JSON.stringify(['slots'])) throw new Error(`unexpected inject order: ${services}`)
    return cb({
      slots,
      get: (name) => {
        // modelDirectories is an optional service; the plugin tolerates absence.
        if (name === 'modelDirectories') return fakeModelDirectories
        throw new Error(`unexpected get: ${name}`)
      },
    })
  },
}
mod.apply(ctx)
console.log('slots.inject called with:', injected)
if (injected.length !== 2 || injected[0] !== 'conversation.composer.dock' || injected[1] !== 'conversation.input.right') throw new Error('slot injection mismatch')

const disposers = injectedCbs.map((cb) => cb())
console.log('register opts:', JSON.stringify(registrations.map((reg) => reg.opts)))
const dockReg = registrations.find((reg) => reg.opts.name === 'conversation.composer.dock')
const heroReg = registrations.find((reg) => reg.opts.name === 'conversation.input.right')
if (dockReg === undefined || heroReg === undefined) throw new Error('both seats must register')
for (const reg of registrations) {
  if (reg.opts.id !== 'balance' || reg.opts.order !== 100) throw new Error(`register opts mismatch: ${JSON.stringify(reg.opts)}`)
}
if (!disposers.every((disposer) => typeof disposer === 'function')) throw new Error('register must return a disposer')

// The registered entry is the chip wrapper: invoking it with the standard
// `useSessions` seat returns an element (a jsx descriptor whose `type` is the
// BalanceChip component).
const el = dockReg.component({ useSessions: () => undefined })
console.log('registered entry render type:', typeof el.type)
if (typeof el.type !== 'function') throw new Error('the registered entry should render a component')

// Drive the chip's refresh path directly: render BalanceChip with a fake
// model-directory store, run the captured effects, and read the `kind` the chip
// requested. This is the regression guard for the original bug — the provider
// must come from the model-directory store, never a nonexistent connection API.
const fetched = []
globalThis.fetch = async (url) => {
  fetched.push(String(url))
  return { json: async () => ({ ok: false, error: 'test', message: 'test' }) }
}
async function requestedKind({ provider, absent = false, throws = false, noSession = false, snapshot, variant = 'dock' }) {
  effects.length = 0
  fetched.length = 0
  fakeModelDirectories = absent ? undefined : {
    directoryFor: () => {
      if (throws) throw new Error('no directory')
      return {
        store: {
          getSnapshot: () => ({ current: provider === undefined ? null : { provider, model: 'm' } }),
          subscribe: () => () => {},
        },
      }
    },
  }
  mod.BalanceChip({
    variant,
    // `snapshot` drives the chip's OWN session selector over a real snapshot
    // shape; otherwise the seat is stubbed with a fixed session id.
    useSessions: snapshot === undefined
      ? () => (noSession ? undefined : 'session-1')
      : (selector) => selector(snapshot),
    getModelDirectories: () => fakeModelDirectories,
  })
  for (const effect of effects) effect()
  await new Promise((resolve) => setImmediate(resolve))
  const url = fetched[0]
  return url === undefined ? undefined : new URL(url, 'http://internal').searchParams.get('kind')
}

const kindCases = [
  [{ provider: 'openrouter' }, 'openrouter', 'OpenRouter session resolves the OpenRouter balance'],
  [{ provider: 'moonshotai-cn' }, 'moonshot', 'regional Moonshot route maps to the Moonshot balance'],
  [{ provider: 'zai' }, 'zhipu', 'Z.ai route maps to the Zhipu balance'],
  [{ provider: 'minimax-cn' }, 'minimax', 'regional MiniMax route maps to the MiniMax balance'],
  [{ provider: 'deepseek-official' }, 'deepseek', 'DeepSeek route keeps the DeepSeek balance'],
  [{ provider: 'some-custom-route' }, 'deepseek', 'unknown route falls back to DeepSeek'],
  [{ provider: undefined }, 'deepseek', 'unresolved directory falls back to DeepSeek'],
  [{ provider: 'openrouter', absent: true }, 'deepseek', 'absent model-directory service falls back to DeepSeek'],
  [{ provider: 'openrouter', throws: true }, 'deepseek', 'unresolvable session directory falls back to DeepSeek'],
  [{ provider: 'openrouter', noSession: true }, 'deepseek', 'no active session falls back to DeepSeek'],
  // DSH 0.1.6-alpha.2 removed the sessions snapshot's `current` field
  // ("navigation belongs to view owners"), so the open session must be derived
  // from main-view retention. Without that the chip resolves no session and
  // falls back to DeepSeek in every session, masking the provider detection
  // above — the reported "Balance —" regression.
  [{ provider: 'openrouter', snapshot: { current: 'session-alpha1', byId: {} } }, 'openrouter', 'alpha.1 snapshot resolves the session from `current`'],
  [{ provider: 'openrouter', snapshot: { byId: { s: { id: 'session-1', retainedBy: { mainView: 1 } } } } }, 'openrouter', 'alpha.2 snapshot resolves the session from main-view retention'],
  [{ provider: 'openrouter', snapshot: { byId: { s: { id: 'session-1', retainedBy: { mainView: 2 } } } } }, 'openrouter', 'main-view retention is a count, not a boolean'],
  [{ provider: 'openrouter', snapshot: { byId: { s: { id: 'session-1', retainedBy: {} } } } }, 'deepseek', 'a snapshot with no main-view retention falls back to DeepSeek'],
  [{ provider: 'openrouter', snapshot: {} }, 'deepseek', 'an empty snapshot falls back to DeepSeek'],
  // The hero seat belongs to the blank session only: it polls while the
  // session has no messages and goes silent the moment the first send lands,
  // leaving the dock instance to take over.
  [{ provider: 'openrouter', variant: 'hero', snapshot: { byId: { s: { id: 'session-1', retainedBy: { mainView: 1 }, blank: true } } } }, 'openrouter', 'hero seat polls for a blank session'],
  [{ provider: 'openrouter', variant: 'hero', snapshot: { byId: { s: { id: 'session-1', retainedBy: { mainView: 1 }, blank: false } } } }, undefined, 'hero seat goes silent once the session has messages'],
]
for (const [input, expected, label] of kindCases) {
  const actual = await requestedKind(input)
  if (actual !== expected) throw new Error(`kind mismatch for ${label}: got ${actual}, want ${expected}`)
}
console.log(`provider-kind assertions: PASS (${kindCases.length} cases, incl. OpenRouter regression)`)
console.log('PASS: client bundle contract, slot registration, entry render, and provider resolution are sound')
