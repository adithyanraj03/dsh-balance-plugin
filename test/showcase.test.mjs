// Regression tests for the provider showcase: the rotation the chip runs when
// the session's model has no billable provider (a local or custom model).
//
// Requirements:
//   - only explicit provider ids count as "known"; a local/custom id must NOT
//     resolve to a balance (that guess is what showed Alibaba for local Qwen);
//   - the rotation leads with Alibaba and cycles the six supported providers;
//   - each card can surface the provider's next billing-window change;
//   - the rotation skips providers without a usable card and never spins when
//     none is usable.
//
// `lib/client.js` is the artifact the browser loads. Run `pnpm run build` first.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

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

function extractConst(source, name) {
  // Non-greedy to the first semicolon so multi-line array literals work too.
  const match = new RegExp(`const ${name} = ([\\s\\S]*?);`).exec(source)
  if (match === null) throw new Error(`bundle omits ${name}`)
  return `${name} = ${match[1]};`
}

function load() {
  const source = [
    extractConst(bundle, 'HOUR_MS'),
    extractConst(bundle, 'DAY_MS'),
    extractConst(bundle, 'PEAK_WINDOWS_UTC'),
    extractConst(bundle, 'SHOWCASE_ORDER'),
    extractFunction(bundle, 'unwrapModlensProvider'),
    extractFunction(bundle, 'knownProviderKind'),
    extractFunction(bundle, 'formatCountdown'),
    extractFunction(bundle, 'nextTransition'),
    extractFunction(bundle, 'nextAlibabaTransition'),
    extractFunction(bundle, 'nextChangeLabel'),
    extractFunction(bundle, 'nextShowcaseIndex'),
  ].join('\n')
  return new Function(`${source}
    return { SHOWCASE_ORDER, knownProviderKind, nextChangeLabel, nextShowcaseIndex }`)()
}

const at = (iso) => new Date(iso)

test('only explicit provider ids are known; local and custom ids are not', () => {
  const { knownProviderKind } = load()
  assert.equal(knownProviderKind('deepseek'), 'deepseek')
  assert.equal(knownProviderKind('alibaba-cloud'), 'alibaba')
  assert.equal(knownProviderKind('modlens-openrouter'), 'openrouter')
  assert.equal(knownProviderKind('ollama'), null)
  assert.equal(knownProviderKind('local'), null)
  assert.equal(knownProviderKind('lmstudio'), null)
  assert.equal(knownProviderKind('my-relay'), null)
})

test('the showcase leads with Alibaba and covers the six providers', () => {
  const { SHOWCASE_ORDER } = load()
  assert.equal(SHOWCASE_ORDER[0], 'alibaba')
  assert.deepEqual([...SHOWCASE_ORDER].sort(), ['alibaba', 'deepseek', 'minimax', 'moonshot', 'openrouter', 'zhipu'])
})

test('each card can name the next billing-window change', () => {
  const { nextChangeLabel } = load()
  // Wednesday 02:00 UTC is inside DeepSeek peak [01:00,04:00); it ends at 04:00.
  assert.equal(nextChangeLabel('deepseek', at('2026-11-11T02:00:00Z')), 'off-peak in 2h')
  // 10:00 UTC: the night window (14:00 UTC) opens in four hours.
  assert.equal(nextChangeLabel('alibaba', at('2026-11-11T10:00:00Z')), 'nights start in 4h')
  assert.equal(nextChangeLabel('openrouter', at('2026-11-11T10:00:00Z')), null)
  assert.equal(nextChangeLabel('minimax', at('2026-11-11T10:00:00Z')), null)
})

test('the rotation skips unusable providers, wraps, and never spins', () => {
  const { nextShowcaseIndex } = load()
  const avail = [true, false, true, false, false, false]
  assert.equal(nextShowcaseIndex(0, avail), 2)
  assert.equal(nextShowcaseIndex(2, avail), 0, 'wraps to the first usable slot')
  assert.equal(nextShowcaseIndex(0, [false, false, false, false, false, false]), 0, 'stays put when nothing is usable')
  assert.equal(nextShowcaseIndex(3, [true, true, true, true, true, true]), 4)
})