// Behavioural test for the popover's hover state machine.
//
// The unit extracts the REAL effect body out of the built client bundle —
// the counters plus the `setInterval` call — and runs it against a fake chip
// with a captured callback, so the closure evolves exactly as in the browser.
// It proves the decisions, not the shape of the source:
//
//   - a chip already hovered at mount (new session / FLIP landing) must NOT
//     open the popover by itself             ← shipped once as a regression;
//   - leave then re-enter opens it after two confirming ticks;
//   - leaving closes it after two misses, so an edge wobble cannot flicker;
//   - a panel left open hard-stops on its own, with no outside click;
//   - a re-entered pointer inside the cooldown cannot immediately reopen;
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
    extractPoll(bundle),
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
    /** Run `n` ticks without changing the pointer. */
    idle(n = 1) { for (let i = 0; i < n; i += 1) captured() },
  }
}

test('the poll body is present and extractable', () => {
  assert.match(bundle, /let wasOver/)
  assert.ok(extractPoll(bundle).includes('setInterval'))
})

test('a chip hovered at mount never opens by itself (new-session phantom)', () => {
  const d = driver(true)
  d.idle(30)
  assert.equal(d.calls.opened, 0, 'a resting pointer must not open the popover')
})

test('leaving and re-entering opens after two confirming ticks', () => {
  const d = driver(true)
  d.move(false, 8)                    // pointer leaves; cooldown burns down
  assert.equal(d.calls.opened, 0)
  d.move(true, 1)                     // re-enter: armed, tick 1
  assert.equal(d.calls.opened, 0, 'the first tick must not open (dwell)')
  d.move(true, 1)                     // tick 2
  assert.equal(d.calls.opened, 1, 'the second confirming tick opens')
  assert.equal(d.open, true)
})

test('leaving closes after two misses, so an edge wobble cannot flicker', () => {
  const d = driver(false)
  d.move(true, 8)
  assert.equal(d.open, true)
  d.move(false, 1)                    // one miss: tolerated
  assert.equal(d.open, true, 'a single miss must not close (no flicker)')
  d.move(false, 1)                    // second miss: close
  assert.equal(d.open, false, 'move-away closes')
  assert.equal(d.calls.closed, 1)
})

test('a panel left open hard-stops on its own, with no outside click', () => {
  const d = driver(false)
  d.move(true, 8)
  assert.equal(d.open, true)
  d.idle(70)                          // pointer parked on the chip, hover honest
  assert.equal(d.open, false, 'the panel must not strand open')
  assert.equal(d.calls.closed, 1)
})

test('the cooldown after a close blocks an immediate reopen', () => {
  const d = driver(false)
  d.move(true, 8)
  d.move(false, 2)                    // close
  const before = d.calls.opened
  d.move(true, 2)                     // re-enter inside the cooldown
  assert.equal(d.calls.opened, before, 'no reopen during the cooldown')
})

test('a re-mounted anchor re-seeds and cannot inherit a stale transition', () => {
  const d = driver(false)
  d.move(true, 8)
  assert.equal(d.open, true)
  d.move(false, 2)
  const fresh = { hovered: true, matches: () => fresh.hovered }
  d.anchorRef.current = fresh
  d.move(true, 2)
  // Seeded as already-hovered on the new element: no transition, no reopen.
  assert.equal(d.open, false)
})