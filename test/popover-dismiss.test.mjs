// Regression test for the popover's pointer-position dismissal helper in the
// built client bundle.
//
// The requirement: moving the pointer away from the chip AND the card closes
// the popover even when the desktop webview swallows mouseleave boundary
// events (seat repaints on a new session). The dismissal effect compares
// pointer positions against both rects, so the rect test must include edges
// and exclude everything outside.
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

const pointerInsideRect = new Function(`${extractFunction(bundle, 'pointerInsideRect')}
  return pointerInsideRect`)()

const rect = { left: 100, right: 200, top: 50, bottom: 90 }

test('pointer positions inside the rect, edges included, keep the popover open', () => {
  assert.equal(pointerInsideRect(150, 70, rect), true)
  assert.equal(pointerInsideRect(100, 50, rect), true)
  assert.equal(pointerInsideRect(200, 90, rect), true)
})

test('pointer positions outside the rect dismiss the popover', () => {
  assert.equal(pointerInsideRect(99, 70, rect), false)
  assert.equal(pointerInsideRect(201, 70, rect), false)
  assert.equal(pointerInsideRect(150, 49, rect), false)
  assert.equal(pointerInsideRect(150, 91, rect), false)
  assert.equal(pointerInsideRect(0, 0, rect), false)
})
