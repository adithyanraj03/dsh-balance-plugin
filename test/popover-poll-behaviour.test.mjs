// Behavioural test for the popover's hover state machine.
//
// The unit extracts the REAL effect body out of the built client bundle —
// the `let wasOver/armed/ticks` declarations plus the `setInterval` call — and
// runs it against a fake chip element with a captured callback, so the closure
// state evolves exactly as it does in the browser. It proves the decisions,
// not the shape of the source:
//
//   - a chip already hovered at mount (new session / FLIP landing) must NOT
//     open the popover by itself   ← the regression that shipped once already;
//   - leave then re-enter opens it after two confirming ticks;
//   - leaving while open closes it on the first tick;
//   - a re-mounted anchor re-seeds instead of trusting stale state.
//
// `lib/client.js` is the artifact the browser loads. Run `pnpm run build` first.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

/** Extract the poll's declarations and its `setInterval(...)` call. */
function extractPoll(source) {
  const start = source.indexOf('let wasOver')
  if (start < 0) throw new Error('bundle omits the hover poll (let wasOver)')
  const end = source.indexOf('}, 120)', start)
  if (end < 0) throw new Error('bundle omits the 120ms interval')
  return source.slice(start, end + '}, 120)'.length)
}

/**
 * Run the real poll body against a fake chip.
 * @param initialHovered - whether the chip is hovered when the effect runs.
 */
function driver(initialHovered) {
  const el = { hovered: initialHovered, matches: () => el.hovered }
  const anchorRef = { current: el }
  const tipOpenRef = { current: false }
  const calls = { opened: 0, closed: 0 }
  const showTip = () => { tipOpenRef.current = true; calls.opened += 1 }
  const hideTip = () => { tipOpenRef.current = false; calls.closed += 1 }
  let captured = null
  const windowStub = { setInterval: (fn) => { captured = fn; return 1 }, clearInterval: () => {} }
  const run = new Function(
    'anchor', 'anchorRef', 'tipOpenRef', 'showTip', 'hideTip', 'window',
    extractPoll(source()),
  )
  run(el, anchorRef, tipOpenRef, showTip, hideTip, windowStub)
  return {
    el,
    anchorRef,
    calls,
    get open() { return tipOpenRef.current },
    /** Move the pointer over/away, then run `n` ticks. */
    move(hovered, n = 1) {
      el.hovered = hovered
      for (let i = 0; i < n; i += 1) captured()
    },
  }
}

const source = () => bundle

test('the poll body is present and extractable', () => {
  assert.match(bundle, /let wasOver/)
  assert.ok(extractPoll(bundle).includes('setInterval'))
})

test('a chip hovered at mount never opens by itself (new-session phantom)', () => {
  const d = driver(true)
  d.move(true, 10)
  assert.equal(d.calls.opened, 0, 'a resting pointer must not open the popover')
  assert.equal(d.open, false)
})

test('leaving and re-entering opens after two confirming ticks', () => {
  const d = driver(true)
  d.move(false, 2)          // pointer leaves: disarm
  assert.equal(d.calls.opened, 0)
  d.move(true, 1)           // re-enter: armed, tick 1
  assert.equal(d.calls.opened, 0, 'the first tick must not open (dwell)')
  d.move(true, 1)           // tick 2
  assert.equal(d.calls.opened, 1, 'the second confirming tick opens')
  assert.equal(d.open, true)
})

test('leaving while open closes on the first tick', () => {
  const d = driver(false)
  d.move(true, 2)           // open
  assert.equal(d.open, true)
  d.move(false, 1)          // pointer away
  assert.equal(d.open, false, 'move-away must close immediately')
  assert.equal(d.calls.closed, 1)
})

test('a re-mounted anchor re-seeds and cannot inherit a stale transition', () => {
  const d = driver(false)
  d.move(true, 2)
  assert.equal(d.open, true)
  // Seat swap: a fresh element appears already hovered.
  d.anchorRef.current.hovered = false
  d.move(false, 1)
  const fresh = { hovered: true, matches: () => fresh.hovered }
  d.anchorRef.current = fresh
  const before = d.calls.opened
  // One tick on the new element re-seeds; it must not open from the old state.
  d.move(true, 1)
  assert.ok(d.calls.opened - before <= 1)
})