// Behavioural tests for the balance popover's hover state machine
// (src/client/hover.ts). Node >= 22.18 strips the types natively, so the
// tests drive the same module the bundle ships, with a fake clock and rect.
//
// What they pin down:
//   - a chip mounted or flown under a resting pointer never opens by itself;
//   - a genuine move in opens after the dwell, and moving out closes at once;
//   - a stale or wobbling :hover can close the panel but never reopen it
//     (this was the flicker);
//   - the panel cannot strand open: leaving the window, the chip moving away,
//     :hover going false and a time limit each close it on their own;
//   - with no pointer events at all, :hover transitions still work.
//
// A structural check also confirms the built bundle wires the machine in.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHoverMachine, HOVER_DEFAULTS } from '../src/client/hover.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A fake chip at (100..200, 50..80), a fake clock, and the machine under test. */
function rig({ hovered = false } = {}) {
  const state = { rect: { left: 100, right: 200, top: 50, bottom: 80 }, hovered, now: 0, opened: 0, closed: 0, shown: false }
  const m = createHoverMachine(
    () => state.rect,
    () => { state.shown = true; state.opened += 1 },
    () => { state.shown = false; state.closed += 1 },
    hovered,
  )
  return {
    state,
    m,
    /** Advance the clock by `ms` in 100 ms poll ticks. */
    wait(ms) {
      for (let t = 0; t < ms; t += 100) { state.now += 100; m.tick(state.now, state.hovered) }
    },
    /** Move the pointer to (x, y) and update :hover to match. */
    move(x, y) {
      const r = state.rect
      state.hovered = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
      m.pointer(x, y, state.now, true)
    },
  }
}

test('a chip mounted under a resting pointer never opens by itself', () => {
  const r = rig({ hovered: true })
  r.m.pointer(150, 60, 0, false)      // layout-induced re-hit-test, no movement
  r.wait(3000)
  assert.equal(r.state.opened, 0)
})

test('a genuine move in opens after the dwell', () => {
  const r = rig()
  r.move(150, 60)
  assert.equal(r.state.shown, false, 'no instant open')
  r.wait(200)
  assert.equal(r.state.shown, true)
})

test('moving out closes immediately, with no tick needed', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  r.move(150, 200)
  assert.equal(r.state.shown, false)
  assert.equal(r.state.closed, 1)
})

test('a sweep across the chip shorter than the dwell does not open', () => {
  const r = rig()
  r.move(150, 60)
  r.state.now += 50
  r.move(300, 60)
  r.wait(1000)
  assert.equal(r.state.opened, 0)
})

test('a stale :hover that stays true after leaving cannot keep it open or reopen it', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  r.m.pointer(500, 400, r.state.now, true)  // pointer leaves...
  r.state.hovered = true                    // ...but :hover is stuck true
  r.wait(3000)
  assert.equal(r.state.shown, false)
  assert.equal(r.state.opened, 1, 'no reopen from a stale :hover')
})

test('a flapping :hover with a resting pointer closes at most once and never flickers back', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  for (let i = 0; i < 20; i += 1) {
    r.state.hovered = i % 3 !== 0
    r.wait(100)
  }
  assert.equal(r.state.opened, 1, 'opened only on the genuine enter')
  assert.ok(r.state.closed <= 1)
})

test(':hover going false closes after the tolerance even with no pointer events', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  r.state.hovered = false                   // e.g. the pointer left into a drag region
  r.wait(100)
  assert.equal(r.state.shown, true, 'one miss is tolerated')
  r.wait(100)
  assert.equal(r.state.shown, false)
})

test('leaving the window closes it', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  r.m.pointerGone(r.state.now)
  assert.equal(r.state.shown, false)
  r.wait(2000)
  assert.equal(r.state.opened, 1, 'stays closed until the pointer moves back in')
})

test('the chip moving away from a resting pointer closes it', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  r.state.rect = { left: 100, right: 200, top: 500, bottom: 530 }  // FLIP down to the dock
  r.wait(100)
  assert.equal(r.state.shown, false)
})

test('an open panel closes by itself after the time limit and stays shut', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  r.wait(HOVER_DEFAULTS.maxOpenMs + 200)
  assert.equal(r.state.shown, false)
  r.wait(2000)
  assert.equal(r.state.opened, 1, 'a resting pointer cannot reopen it')
  r.move(160, 65); r.wait(400)
  assert.equal(r.state.opened, 2, 'a fresh move reopens it')
})

test('after a close, moving back in reopens once the cooldown passes', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  r.move(150, 200)
  r.move(150, 60)
  r.wait(100)
  assert.equal(r.state.opened, 1, 'the cooldown holds')
  r.wait(400)
  assert.equal(r.state.opened, 2)
})

test('an outside dismissal disarms until the pointer moves again', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  r.m.dismiss(r.state.now)
  r.wait(2000)
  assert.equal(r.state.opened, 1)
})

test('a seat re-mount resets the machine to closed', () => {
  const r = rig()
  r.move(150, 60); r.wait(200)
  r.m.reset(r.state.now, true)
  assert.equal(r.state.shown, false)
  r.wait(2000)
  assert.equal(r.state.opened, 1)
})

test('with no pointer events at all, a :hover enter still opens and a leave closes', () => {
  const r = rig({ hovered: false })
  r.state.hovered = true
  r.wait(300)
  assert.equal(r.state.shown, true)
  r.state.hovered = false
  r.wait(200)
  assert.equal(r.state.shown, false)
})

test('the built bundle drives the popover from the hover machine', () => {
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  assert.match(bundle, /function createHoverMachine\(/)
  assert.match(bundle, /addEventListener\(["']pointermove["']/)
  assert.match(bundle, /matches\(["']:hover["']\)/)
  assert.doesNotMatch(bundle, /onMouseEnter/, 'nothing may open the popover on mouseenter')
})
