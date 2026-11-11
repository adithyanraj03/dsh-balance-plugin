// Regression test for the popover's open/close mechanism in the built bundle.
//
// The requirement: the desktop shell stops pointer/mouse event propagation
// below document level, so every event-based dismissal (React's delegated
// onMouseLeave, capture-phase pointermove watchers) failed and the panel
// stranded open. The bundle must therefore drive the panel from a poll of the
// chip's CSS `:hover` state, which no JavaScript handler can suppress.
//
// `lib/client.js` is the artifact the browser loads, so this reads the built
// bundle rather than the TypeScript source. Run `pnpm run build` first.

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
  // The poll arms an interval; without one the panel can never re-check.
  assert.match(bundle, /setInterval\(/, 'the hover poll needs an interval')
})

test('no hover-open path survives on mouseenter, which the shell can starve', () => {
  // Opening via mouseenter is exactly what produced phantom opens on a new
  // session; the poll owns opening now.
  assert.doesNotMatch(bundle, /onMouseEnter/, 'mouseenter must not open the popover')
})

test('the phantom-open guard requires a hover transition, not a resting pointer', () => {
  // wasOver is seeded from the mount-time hover state, so a chip appearing
  // under a stationary cursor starts "already over" and cannot transition.
  assert.match(bundle, /wasOver/, 'the poll must track the previous hover state')
  assert.match(bundle, /ticks\s*>=\s*2/, 'opening needs a second confirming tick')
})