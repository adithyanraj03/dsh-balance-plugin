// Regression tests for the composer seats in the built client bundle.
//
// The requirement: the balance chip sits at the RIGHT end of the status strip
// below the composer — after the activity, usage and context pills — while a
// session is running, and in the composer tool row beside the model selector
// while the session is still blank (the hero screen). The first send swaps the
// seats, and the pill must FLY between them rather than teleport.
//
// Two subtleties these tests guard:
//
// 1. The slot runtime wraps every list entry in a `[data-slot]` element, and
//    that wrapper — not the chip — is the dock row's flex child. Writing
//    `order` on the chip itself would do nothing, so the pin writes it on the
//    outlet AND the anchor (covering a transparent or absent wrapper in older
//    runtimes) and hands back the previous values for the unmount cleanup.
// 2. The two seats are different DOM subtrees, so the handoff is a remembered
//    position: each instance flies in from where the previous one sat (FLIP),
//    and a stale anchor, a reduced-motion setting, or a sub-2px hop paints in
//    place instead.
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
const bundle = readFileSync(BUNDLE, 'utf8')

/** The minimum an element needs for the pin: a writable `style.order`. */
function element(order = '') {
  return { style: { order } }
}

/** A chip element the flight can measure: a fixed position, flushable layout. */
function chipElement(left = 0, top = 0) {
  return {
    style: {},
    offsetWidth: 10,
    getBoundingClientRect: () => ({ left, top }),
  }
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
  const source = [
    extractConst(bundle, 'DOCK_ORDER'),
    extractFunction(bundle, 'applyDockOrder'),
  ].join('\n')
  return new Function(`${source}
    return { applyDockOrder, DOCK_ORDER }`)()
}

/** Load the flight's parts, with hooks over the module-private anchor. */
function loadFlight() {
  const source = [
    extractConst(bundle, 'REFRESH_INTERVAL_MS'),
    extractConst(bundle, 'FLIP_WINDOW_MS'),
    extractConst(bundle, 'FLIP_TRANSITION'),
    'let lastChipAnchor;',
    extractFunction(bundle, 'rememberChipAnchor'),
    extractFunction(bundle, 'flyChipIn'),
  ].join('\n')
  return new Function(`${source}
    return {
      rememberChipAnchor,
      flyChipIn,
      FLIP_WINDOW_MS,
      FLIP_TRANSITION,
      peekAnchor: () => lastChipAnchor,
      setAnchor: (value) => { lastChipAnchor = value },
    }`)()
}

const { applyDockOrder, DOCK_ORDER } = loadPin()
const { rememberChipAnchor, flyChipIn, FLIP_WINDOW_MS, FLIP_TRANSITION, peekAnchor, setAnchor } = loadFlight()

// The flight reads `window` for the motion preference and its cleanup timer.
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  setTimeout: () => 0,
}

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

test('rememberChipAnchor records the element\'s top-left', () => {
  setAnchor(undefined)
  rememberChipAnchor(chipElement(100, 50))
  const anchor = peekAnchor()
  assert.equal(anchor.x, 100)
  assert.equal(anchor.y, 50)
  assert.ok(anchor.at <= Date.now())
})

test('a fresh mount with no remembered position paints in place', () => {
  setAnchor(undefined)
  const chip = chipElement(300, 50)
  flyChipIn(chip)
  assert.ok(!('transform' in chip.style))
})

test('the chip flies in from the remembered position', () => {
  setAnchor({ x: 100, y: 50, at: Date.now() })
  const chip = chipElement(300, 50)
  flyChipIn(chip)
  // FLIP end state: released to its own spot with the flight's transition
  // still attached (the timer clears it after the flight).
  assert.equal(chip.style.transform, '')
  assert.equal(chip.style.transition, FLIP_TRANSITION)
})

test('a stale anchor paints in place', () => {
  setAnchor({ x: 100, y: 50, at: Date.now() - FLIP_WINDOW_MS - 1000 })
  const chip = chipElement(300, 50)
  flyChipIn(chip)
  assert.ok(!('transform' in chip.style))
})

test('reduced motion paints in place', () => {
  globalThis.window.matchMedia = () => ({ matches: true })
  try {
    setAnchor({ x: 100, y: 50, at: Date.now() })
    const chip = chipElement(300, 50)
    flyChipIn(chip)
    assert.ok(!('transform' in chip.style))
  } finally {
    globalThis.window.matchMedia = () => ({ matches: false })
  }
})

test('a sub-2px hop paints in place', () => {
  setAnchor({ x: 300, y: 51, at: Date.now() })
  const chip = chipElement(300, 50)
  flyChipIn(chip)
  assert.ok(!('transform' in chip.style))
})

test('the chip registers on both composer seats behind the chat\'s own entries', () => {
  assert.match(bundle, /slots\.inject\("conversation\.composer\.dock"/)
  assert.match(bundle, /slots\.inject\("conversation\.input\.right"/)
  assert.match(bundle, /name: "conversation\.composer\.dock",\s*id: "balance",\s*order: 100/)
  assert.match(bundle, /name: "conversation\.input\.right",\s*id: "balance",\s*order: 100/)
  // The sidebar foot is gone entirely — no half-migrated registration.
  assert.doesNotMatch(bundle, /sidebar\.footer\.action/)
})

test('the hero seat belongs to the blank session', () => {
  // The gate that hides the tool-row chip the moment the first send lands:
  // the session summary's `blank` flag, the same one the shell derives its
  // hero state from.
  assert.match(bundle, /variant === "hero" && !blank/)
})

test('the chip is a compact strip pill, not the old 32px sidebar box', () => {
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
  assert.doesNotMatch(bundle, /compact|COMPACT|cramped|CRAMPED/)
  // Both amount spans are plain children: no `&&` guard in front of either.
  assert.match(bundle, /jsxs\)\("span", \{\s*style: amountStyle,\s*children: \[view\.symbol, view\.total\]/)
  assert.match(bundle, /jsx\)\("span", \{\s*style: amountStyle,\s*children: "Balance —"/)
})
