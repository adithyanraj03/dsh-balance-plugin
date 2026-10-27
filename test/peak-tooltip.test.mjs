// Regression tests for the local-time peak tooltip in the built client bundle.
//
// The requirement: the DeepSeek hover shows its peak windows in the viewer's
// OWN system time with AM/PM tags and a zone label (not UTC), carries a
// countdown to the next billing boundary — always during peak, and within the
// last hour of off-peak — and renders as a styled DSH popover, not the
// unstyled native `title` bubble.
//
// The timezone is pinned to Asia/Kolkata (UTC+5:30) so the expected local
// clock times are exact: the fixed UTC windows 01:00–04:00 and 06:00–10:00
// land at 06:30–09:30 and 11:30–15:30 IST, Mon–Fri.
//
// `lib/client.js` is the artifact the browser loads, so this reads the built
// bundle rather than the TypeScript source. Run `pnpm run build` first.

process.env.TZ = 'Asia/Kolkata'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

/**
 * Extract one `function name(...) { ... }` declaration by brace matching.
 * @param source - the bundle text.
 * @param name - the function name to find.
 * @returns the function's source text.
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`bundle omits ${name}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`)
}

/**
 * Extract a `const NAME = <literal>;` declaration.
 * @param source - the bundle text.
 * @param name - the constant name.
 * @returns the `NAME = value;` text without its `const` keyword.
 */
function extractConst(source, name) {
  const match = new RegExp(`const ${name} = ([^;\\n]+);`).exec(source)
  if (match === null) throw new Error(`bundle omits ${name}`)
  return `${name} = ${match[1]};`
}

/** Load the tooltip's pure parts from the built bundle. */
function loadTooltip() {
  const source = [
    extractConst(bundle, 'HOUR_MS'),
    extractConst(bundle, 'DAY_MS'),
    extractConst(bundle, 'URGENT_MS'),
    extractConst(bundle, 'TEAL_INK'),
    extractConst(bundle, 'PEAK_WINDOWS_UTC'),
    extractFunction(bundle, 'isPeakHour'),
    extractFunction(bundle, 'nextTransition'),
    extractFunction(bundle, 'formatCountdown'),
    extractFunction(bundle, 'localClock'),
    extractFunction(bundle, 'localWeekday'),
    extractFunction(bundle, 'localZoneLabel'),
    extractFunction(bundle, 'utcMondayStart'),
    extractFunction(bundle, 'peakWindowsLocalLabel'),
    extractFunction(bundle, 'tooltipLines'),
    extractFunction(bundle, 'chipTimer'),
  ].join('\n')
  return new Function(`${source}
    return { nextTransition, formatCountdown, peakWindowsLocalLabel, tooltipLines, chipTimer }`)()
}

const { nextTransition, formatCountdown, peakWindowsLocalLabel, tooltipLines, chipTimer } = loadTooltip()

const deepseekOk = (peak) => ({
  kind: 'ok', provider: 'deepseek', symbol: '$', total: '11.97',
  heading: 'DeepSeek', detail: 'Total $11.97 · Granted $0.00 · Topped up $11.97', peak,
})

test('the peak windows read in IST with AM/PM tags and the zone label', () => {
  const label = peakWindowsLocalLabel(new Date('2026-09-07T12:00:00Z'))
  assert.ok(label.includes('Mon–Fri'), `weekday range: ${label}`)
  assert.ok(label.includes('(GMT+5:30)'), `zone label: ${label}`)
  // 01:00–04:00 and 06:00–10:00 UTC are 06:30–09:30 and 11:30–15:30 IST.
  assert.match(label, /6:30\s*AM\s*–\s*9:30\s*AM/i, label)
  assert.match(label, /11:30\s*AM\s*–\s*3:30\s*PM/i, label)
  assert.doesNotMatch(label, /UTC|Beijing/, `the old UTC/Beijing text must be gone: ${label}`)
})

test('peak always counts down to off-peak', () => {
  const lines = tooltipLines(deepseekOk(true), new Date('2026-09-07T02:00:00Z'))
  assert.match(lines[0].text, /Peak billing$/)
  assert.equal(lines[0].countdown, 'off-peak in 2h')
  assert.equal(lines[0].peak, true)
  assert.equal(lines[0].countdownColor, '#2fbfa0', 'teal relief ink while peak drains')
  assert.equal(lines[0].urgent, false)
  assert.match(lines[1].text, /GMT\+5:30/)
  assert.equal(lines[2].detail, true)
  assert.match(lines[2].text, /Total \$11\.97/)
  assert.equal(lines[3].text, 'Click to refresh')
  const hot = tooltipLines(deepseekOk(true), new Date('2026-09-07T03:57:30Z'))
  assert.equal(hot[0].countdown, 'off-peak in 3m')
  assert.equal(hot[0].urgent, true)
})

test('off-peak counts down to peak only within the last hour', () => {
  const close = tooltipLines(deepseekOk(false), new Date('2026-09-07T05:15:00Z'))
  assert.match(close[0].text, /Off-peak · 50% price$/)
  assert.equal(close[0].countdown, 'peak in 45m')
  const far = tooltipLines(deepseekOk(false), new Date('2026-09-07T20:00:00Z'))
  assert.equal(far[0].countdown, undefined)
})

test('the chip timer mirrors the tooltip countdown with relief/warning ink', () => {
  const peak = chipTimer(new Date('2026-09-07T02:00:00Z'))
  assert.equal(peak.text, '2h')
  assert.equal(peak.peak, true)
  assert.equal(peak.urgent, false)
  assert.equal(peak.color, '#2fbfa0', 'teal relief ink while the peak drains')
  const near = chipTimer(new Date('2026-09-07T05:15:00Z'))
  assert.equal(near.text, '45m')
  assert.match(near.color, /error/, 'red while the peak approaches')
  const hot = chipTimer(new Date('2026-09-07T03:57:30Z'))
  assert.equal(hot.text, '3m')
  assert.equal(hot.urgent, true, 'under five minutes waves')
  assert.equal(chipTimer(new Date('2026-09-07T20:00:00Z')), undefined)
  assert.equal(chipTimer(new Date('2026-09-12T12:00:00Z')), undefined)
})

test('the weekend countdown spans to Monday peak', () => {
  const { at, to } = nextTransition(new Date('2026-09-12T12:00:00Z'))
  assert.equal(to, 'peak')
  assert.equal(at.toISOString(), '2026-09-14T01:00:00.000Z')
  const lines = tooltipLines(deepseekOk(false), new Date('2026-09-12T12:00:00Z'))
  // 61 hours out — well past the 1-hour window, so no countdown.
  assert.equal(lines[0].countdown, undefined)
})

test('countdown formatting rounds to minutes and drops empty parts', () => {
  assert.equal(formatCountdown(4_500_000), '1h 15m')
  assert.equal(formatCountdown(2 * 3_600_000), '2h')
  assert.equal(formatCountdown(45 * 60_000), '45m')
  assert.equal(formatCountdown(30_000), '1m')
  assert.equal(formatCountdown(20_000), 'under 1m')
})

test('non-DeepSeek tooltips stay plain', () => {
  const lines = tooltipLines(
    { kind: 'ok', provider: 'openrouter', symbol: '$', total: '9.74', heading: 'OpenRouter', detail: 'Remaining $9.74' },
    new Date('2026-09-07T02:00:00Z'),
  )
  assert.equal(lines[0].text, 'OpenRouter')
  assert.ok(!lines.some((line) => line.text.includes('Peak')), lines.map((line) => line.text).join(' / '))
})

test('the tooltip is a styled DSH popover, not a native title', () => {
  assert.match(bundle, /role: "tooltip"/)
  assert.match(bundle, /--dsw-alias-bg-layer-1/)
  assert.match(bundle, /--dsw-alias-border-l2/)
  // Header countdown and chip timer use fixed-width digits; a hairline
  // separates the content from the footer hint; the accent bar and tinted
  // pill are built with color-mix; the sub-5-minute wave keyframes ship with
  // the bundle.
  assert.match(bundle, /tabular-nums/)
  assert.match(bundle, /--dsw-alias-border-l1/)
  assert.match(bundle, /color-mix\(in srgb/)
  assert.match(bundle, /borderLeft/)
  assert.match(bundle, /@keyframes dsh-balance-wave/)
  // The timer pill's clock mark: sweeping hand + pop keyframes, painted with
  // currentColor so the wave reaches the dial.
  assert.match(bundle, /@keyframes dsh-balance-clock\{/)
  assert.match(bundle, /@keyframes dsh-balance-clock-pop/)
  assert.match(bundle, /stroke: "currentColor"/)
  // The popover right-anchors to the chip so a docked side panel cannot
  // cover it, and caps its width to the room left of the chip.
  assert.match(bundle, /innerWidth - rect\.right/)
  assert.match(bundle, /rect\.right - 8/)
  // The chip elements carry no native title attribute any more.
  assert.doesNotMatch(bundle, /title: `Balance|title: `\$\{state\.title\}|title: "Loading balance/)
})
