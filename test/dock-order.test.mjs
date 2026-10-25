// Regression test for the composer-dock pin in the built client bundle.
//
// The requirement: the balance chip sits at the RIGHT end of the status strip
// below the composer — after the activity, usage and context pills. The dock
// renders its slot entries before the context meter, so the chip's entry has to
// carry a large CSS `order` to land after it.
//
// The subtlety the pin exists for: the slot runtime wraps every list entry in
// a `[data-slot]` element, and that wrapper — not the chip — is the dock row's
// flex child. Writing `order` on the chip itself would do nothing. The pin
// therefore writes it on the outlet AND the anchor (covering a transparent or
// absent wrapper in older runtimes) and hands back the previous values so the
// unmount cleanup restores the dock exactly as it found it.
//
// `lib/client.js` is the artifact the browser loads, so this reads the built
// bundle rather than the TypeScript source — a fix applied only to `src/` would
// still ship the bug. Run `pnpm run build` first (CI builds before it verifies).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(ROOT, 'lib/client.js')

/** The minimum an element needs for the pin: a writable `style.order`. */
function element(order = '') {
  return { style: { order } }
}

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

/** Load the pin's parts from the built bundle. */
function loadPin() {
  const bundle = readFileSync(BUNDLE, 'utf8')
  const source = [
    extractConst(bundle, 'DOCK_ORDER'),
    extractFunction(bundle, 'applyDockOrder'),
  ].join('\n')
  return new Function(`${source}
    return { applyDockOrder, DOCK_ORDER }`)()
}

const { applyDockOrder, DOCK_ORDER } = loadPin()

test('the pin orders past the context meter', () => {
  assert.ok(DOCK_ORDER > 1, 'the order must clear the dock\'s own entries')
})

test('a wrapped entry gets the order on the slot outlet and the anchor', () => {
  // The DOM shape current releases render: the anchor inside a
  // `[data-slot="conversation.composer.dock"]` wrapper, which is the dock row's
  // real flex child.
  const outlet = element()
  const anchor = element()
  anchor.closest = (selector) => (selector === '[data-slot="conversation.composer.dock"]' ? outlet : null)

  const pins = applyDockOrder(anchor)
  assert.deepEqual(pins.map((pin) => pin.element), [outlet, anchor])
  assert.equal(outlet.style.order, String(DOCK_ORDER))
  assert.equal(anchor.style.order, String(DOCK_ORDER))
})

test('an unwrapped entry still gets pinned through the anchor alone', () => {
  // Older runtimes may render the entry directly, where `closest` finds nothing
  // and the anchor itself is the dock row's flex child.
  const anchor = element()
  anchor.closest = () => null

  const pins = applyDockOrder(anchor)
  assert.deepEqual(pins.map((pin) => pin.element), [anchor])
  assert.equal(anchor.style.order, String(DOCK_ORDER))
})

test('cleanup restores the order each element had before', () => {
  const outlet = element('5')
  const anchor = element()
  anchor.closest = () => outlet

  const pins = applyDockOrder(anchor)
  assert.equal(pins[0].previous, '5')
  assert.equal(pins[1].previous, '')
  // What the chip's unmount effect does with the pins:
  for (const { element: node, previous } of pins) node.style.order = previous
  assert.equal(outlet.style.order, '5')
  assert.equal(anchor.style.order, '')
})

test('the chip registers on the composer dock behind the chat\'s own entries', () => {
  const bundle = readFileSync(BUNDLE, 'utf8')
  assert.match(bundle, /slots\.inject\("conversation\.composer\.dock"/)
  assert.match(bundle, /name: "conversation\.composer\.dock",\s*id: "balance",\s*order: 100/)
  // The sidebar foot is gone entirely — no half-migrated registration.
  assert.doesNotMatch(bundle, /sidebar\.footer\.action/)
})

test('the chip is a compact strip pill, not the old 32px sidebar box', () => {
  const bundle = readFileSync(BUNDLE, 'utf8')
  const chip = /const chipStyle = \{([\s\S]*?)\n\t\t\};/.exec(bundle)?.[1]
  assert.ok(chip !== undefined, 'chip style not found in the bundle')
  // Same text line as the activity/usage/context pills, no box of its own.
  assert.match(chip, /height: 20/)
  assert.match(chip, /borderRadius: 6/)
  assert.match(chip, /fontSize: 12/)
  // No margin: the dock owns the row's spacing and the outlet owns the pin.
  assert.match(chip, /margin: 0,/)
  assert.doesNotMatch(chip, /margin: "0 auto"|marginTop|marginBottom/)
})

test('the amount is rendered unconditionally, in every chip state', () => {
  // The rule this test exists for: the amount is never conditional on the
  // row's width. A previous revision dropped it for a compact mark-and-dot
  // form, which hid the balance in the app's default window.
  const bundle = readFileSync(BUNDLE, 'utf8')
  assert.doesNotMatch(bundle, /compact|COMPACT|cramped|CRAMPED/)
  // Both amount spans are plain children: no `&&` guard in front of either.
  assert.match(bundle, /jsxs\)\("span", \{\s*style: amountStyle,\s*children: \[state\.symbol, state\.total\]/)
  assert.match(bundle, /jsx\)\("span", \{\s*style: amountStyle,\s*children: "Balance —"/)
})
