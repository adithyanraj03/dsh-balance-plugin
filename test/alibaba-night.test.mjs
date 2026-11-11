// Regression tests for the Alibaba Cloud Model Studio night-discount chip in
// the built client bundle.
//
// The requirement: the Token Plan night window (22:00–08:00 Beijing time,
// UTC+8 — i.e. 14:00–24:00 UTC, every day) drives a per-model discount pill
// (Qwen −40%, DeepSeek-on-plan −50%, qwen4-max-preview −80% all day), with the
// same relief/warning ink rule as DeepSeek's peak pill but inverted: teal
// while the discount runs, red through the last hour before it opens, waving
// under five minutes. The popover names the window in the viewer's own system
// time and shows the bl CLI's usage percentage when the host served one.
//
// The timezone is pinned to Asia/Kolkata (UTC+5:30) so the local window label
// is exact: 14:00–24:00 UTC lands at 7:30 PM – 5:30 AM IST.
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

/** Extract one `function name(...) { ... }` declaration by brace matching. */
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

/** Extract a `const NAME = <literal>;` declaration. */
function extractConst(source, name) {
  const match = new RegExp(`const ${name} = ([^;\\n]+);`).exec(source)
  if (match === null) throw new Error(`bundle omits ${name}`)
  return `${name} = ${match[1]};`
}

/** Load the night-discount pure parts from the built bundle. */
function loadNight() {
  const source = [
    extractConst(bundle, 'HOUR_MS'),
    extractConst(bundle, 'DAY_MS'),
    extractConst(bundle, 'URGENT_MS'),
    extractConst(bundle, 'TEAL_INK'),
    extractFunction(bundle, 'formatCountdown'),
    extractFunction(bundle, 'localClock'),
    extractFunction(bundle, 'localWeekday'),
    extractFunction(bundle, 'localZoneLabel'),
    extractFunction(bundle, 'isAlibabaNight'),
    extractFunction(bundle, 'nextAlibabaTransition'),
    extractFunction(bundle, 'alibabaNightLocalLabel'),
    extractFunction(bundle, 'alibabaDiscountForModel'),
    extractFunction(bundle, 'alibabaChipTimer'),
    extractFunction(bundle, 'renderAlibaba'),
    extractFunction(bundle, 'tooltipLines'),
  ].join('\n')
  return new Function(`${source}
    return { isAlibabaNight, nextAlibabaTransition, alibabaNightLocalLabel,
             alibabaDiscountForModel, alibabaChipTimer, renderAlibaba, tooltipLines, TEAL_INK }`)()
}

const at = (iso) => new Date(iso)

test('the night window is 14:00-24:00 UTC every day, weekends included', () => {
  const { isAlibabaNight } = loadNight()
  assert.equal(isAlibabaNight(at('2026-11-11T13:59:00Z')), false)
  assert.equal(isAlibabaNight(at('2026-11-11T14:00:00Z')), true)
  assert.equal(isAlibabaNight(at('2026-11-11T23:59:00Z')), true)
  assert.equal(isAlibabaNight(at('2026-11-12T00:00:00Z')), false)
  // Sunday inside the window: unlike DeepSeek peaks, nights have no weekend rule.
  assert.equal(isAlibabaNight(at('2026-11-15T15:00:00Z')), true)
})

test('the next boundary alternates night start and day end', () => {
  const { nextAlibabaTransition } = loadNight()
  const morning = nextAlibabaTransition(at('2026-11-11T10:00:00Z'))
  assert.equal(morning.at.toISOString(), '2026-11-11T14:00:00.000Z')
  assert.equal(morning.to, 'night')
  const inside = nextAlibabaTransition(at('2026-11-11T15:00:00Z'))
  assert.equal(inside.at.toISOString(), '2026-11-12T00:00:00.000Z')
  assert.equal(inside.to, 'day')
  const lateNight = nextAlibabaTransition(at('2026-11-11T23:30:00Z'))
  assert.equal(lateNight.at.toISOString(), '2026-11-12T00:00:00.000Z')
  assert.equal(lateNight.to, 'day')
})

test('the window label uses the viewer local clock with AM/PM and zone', () => {
  const { alibabaNightLocalLabel } = loadNight()
  const label = alibabaNightLocalLabel(at('2026-11-11T10:00:00Z'))
  assert.match(label, /^Nights 7:30\s*PM\s*–\s*5:30\s*AM \(GMT\+5:30\)$/i, label)
})

test('per-model discounts follow the Token Plan promo list', () => {
  const { alibabaDiscountForModel } = loadNight()
  assert.deepEqual(alibabaDiscountForModel('qwen3.8-max'), { percent: 40, scope: 'night' })
  assert.deepEqual(alibabaDiscountForModel('qwen3.8-flash'), { percent: 40, scope: 'night' })
  assert.deepEqual(alibabaDiscountForModel('deepseek-v4.1-flash-1017'), { percent: 50, scope: 'night' })
  assert.deepEqual(alibabaDiscountForModel('qwen4-max-preview'), { percent: 80, scope: 'always' })
  assert.equal(alibabaDiscountForModel('glm-5.3'), undefined)
  assert.equal(alibabaDiscountForModel(undefined), undefined)
})

test('the chip pill is teal inside the window, red in the last hour before it', () => {
  const { alibabaChipTimer, TEAL_INK } = loadNight()
  const inside = alibabaChipTimer(at('2026-11-11T15:00:00Z'), 40, 'night')
  assert.equal(inside.text, '−40% · 9h')
  assert.equal(inside.color, TEAL_INK)
  assert.equal(inside.peak, false)
  const soon = alibabaChipTimer(at('2026-11-11T13:30:00Z'), 40, 'night')
  assert.equal(soon.text, '−40% in 30m')
  assert.equal(soon.peak, true)
  assert.equal(soon.color, 'var(--dsw-alias-state-error-primary)')
  const urgent = alibabaChipTimer(at('2026-11-11T13:57:00Z'), 50, 'night')
  assert.equal(urgent.urgent, true)
  // Quiet daytime hours carry no pill at all.
  assert.equal(alibabaChipTimer(at('2026-11-11T10:00:00Z'), 40, 'night'), undefined)
  // The all-day launch promo is a steady teal pill, no countdown.
  const always = alibabaChipTimer(at('2026-11-11T10:00:00Z'), 80, 'always')
  assert.equal(always.text, '−80%')
  assert.equal(always.color, TEAL_INK)
  // Models outside the promo list stay bare.
  assert.equal(alibabaChipTimer(at('2026-11-11T15:00:00Z'), undefined, undefined), undefined)
})

test('the renderer shows the bl percentage when present and the console note otherwise', () => {
  const { renderAlibaba } = loadNight()
  const resetAt = Date.now() + 30 * 3_600_000
  const withUsage = renderAlibaba({
    ok: true,
    provider: 'alibaba',
    balance: { plan: 'Token Plan', source: 'bl', usedPercent: 4.22, windowLabel: '1-month', resetAt },
  }, 'qwen3.8-max')
  assert.equal(withUsage.kind, 'ok')
  assert.equal(withUsage.total, '4.22%')
  assert.equal(withUsage.heading, 'Token Plan')
  assert.match(withUsage.detail, /4\.22% of 1-month credits used · resets in 1d 6h/)
  assert.equal(withUsage.discount, 40)
  assert.equal(withUsage.discountScope, 'night')
  const bare = renderAlibaba({ ok: true, provider: 'alibaba', balance: { plan: 'Token Plan', source: 'none' } }, 'glm-5.3')
  assert.equal(bare.total, 'Token Plan')
  assert.equal(bare.detail, 'Credits live in the Model Studio console')
  assert.equal(bare.discount, undefined)
})

test('the popover names the night status, the local window and the usage line', () => {
  const { tooltipLines, renderAlibaba } = loadNight()
  const state = renderAlibaba({
    ok: true,
    provider: 'alibaba',
    balance: { plan: 'Token Plan', source: 'bl', usedPercent: 4.22, windowLabel: '1-month', resetAt: at('2026-11-11T16:00:00Z').getTime() },
  }, 'qwen3.8-max')
  const night = tooltipLines(state, at('2026-11-11T15:00:00Z'))
  assert.equal(night[0].text, 'Token Plan · Night −40% now')
  assert.equal(night[0].countdown, 'day in 9h')
  assert.match(night[1].text, /^Nights 7:30\s*PM\s*–\s*5:30\s*AM \(GMT\+5:30\)$/i, night[1].text)
  assert.match(night[2].text, /4\.22% of 1-month credits used · resets in 1h/)
  const day = tooltipLines(state, at('2026-11-11T13:30:00Z'))
  assert.equal(day[0].text, 'Token Plan · Nights −40%')
  assert.equal(day[0].countdown, '−40% in 30m')
  const noBl = tooltipLines(
    renderAlibaba({ ok: true, provider: 'alibaba', balance: { source: 'none' } }, 'qwen3.8-max'),
    at('2026-11-11T15:00:00Z'),
  )
  assert.ok(noBl.some((line) => line.text.includes('bl CLI')))
})
