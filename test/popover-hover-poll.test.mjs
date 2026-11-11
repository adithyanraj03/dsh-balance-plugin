// Structural test for the popover's open/close mechanism in the built bundle.
//
// The desktop shell stops pointer/mouse event propagation below document
// level, so every event-based dismissal (React's delegated onMouseLeave, a
// capture-phase pointermove watcher) failed and the panel stranded open. The
// bundle must therefore drive the panel from a poll of the chip's CSS
// `:hover` state, which no JavaScript handler can suppress.
//
// The behaviour itself is covered by popover-poll-behaviour.test.mjs; this
// file guards the shape so a refactor cannot quietly reintroduce an
// event-driven open, or drop the safeguards.
//
// `lib/client.js` is the artifact the browser loads. Run `pnpm run build` first.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

test('the popover state machine polls :hover instead of trusting events', () => {
  // The bundler may emit either quote style.
  assert.match(bundle, /matches\(["']:hover["']\)/, 'the chip must poll its :hover state')
  assert.match(bundle, /setInterval\(/, 'the hover poll needs an interval')
})

test('no hover-open path survives on mouseenter, which the shell can starve', () => {
  assert.doesNotMatch(bundle, /onMouseEnter/, 'mouseenter must not open the popover')
})

test('the phantom-open guard requires a hover transition, not a resting pointer', () => {
  assert.match(bundle, /let wasOver/, 'the poll must track the previous hover state')
  assert.match(bundle, /armed/, 'a transition must arm opening')
})

test('both safeguards survive: miss tolerance and the self-dismiss', () => {
  assert.match(bundle, /missTicks/, 'closing must tolerate an edge wobble')
  assert.match(bundle, /heldTicks/, 'an open panel must have a hard stop')
})