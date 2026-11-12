// Regression test for the provider → balance-kind mapping in the built client
// bundle.
//
// `lib/client.js` is what the browser loads and what the `./client` export
// points at, so this reads the built artifact rather than the TypeScript
// source: a fix applied only to `src/` would still ship the bug. Run
// `pnpm run build` first (CI builds before it verifies).
//
// The bug: the modlens vision plugin registers synthetic `modlens-<upstream>`
// wrapper routes, and the mapping knew only the bare catalog names, so every
// `modlens-*` route fell through to DeepSeek. Selecting a "(modlens vision)"
// model therefore showed a missing-DEEPSEEK_API_KEY error instead of the
// OpenRouter credit the session was really spending.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(ROOT, 'lib/client.js')

/**
 * Extract one `function name(...) { ... }` declaration by brace matching.
 * @param source - the bundle text.
 * @param name - the function name to find.
 * @returns the function's source text, or undefined when the bundle omits it.
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return undefined
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
 * Evaluate the mapping functions exactly as they appear in the built bundle.
 * @param bundle - the bundle text.
 * @returns the bundle's own `kindForProvider`.
 */
function loadMapping(bundle) {
  const parts = ['unwrapModlensProvider', 'knownProviderKind', 'kindForProvider']
    .map((name) => extractFunction(bundle, name))
    .filter((part) => part !== undefined)
  return new Function(`${parts.join('\n')}\nreturn kindForProvider`)()
}

test('the built bundle parses as JavaScript', () => {
  const bundle = readFileSync(BUNDLE, 'utf8')
  // Compiles the whole artifact without running it.
  assert.doesNotThrow(() => new Function(bundle))
})

test('modlens wrapper routes resolve to the provider they wrap', () => {
  const kindForProvider = loadMapping(readFileSync(BUNDLE, 'utf8'))
  // The reported case: the session's model rode modlens-openrouter.
  assert.equal(kindForProvider('modlens-openrouter'), 'openrouter')
  assert.equal(kindForProvider('modlens-zai'), 'zhipu')
  assert.equal(kindForProvider('modlens-moonshotai-cn'), 'moonshot')
  assert.equal(kindForProvider('modlens-minimax-cn'), 'minimax')
  // The legacy DeepSeek wrap keeps its historical id.
  assert.equal(kindForProvider('deepseek-modlens'), 'deepseek')
})

test('bare catalog routes and the DeepSeek fallback are unchanged', () => {
  const kindForProvider = loadMapping(readFileSync(BUNDLE, 'utf8'))
  assert.equal(kindForProvider('openrouter'), 'openrouter')
  assert.equal(kindForProvider('moonshotai'), 'moonshot')
  assert.equal(kindForProvider('zai-coding-cn'), 'zhipu')
  assert.equal(kindForProvider('minimax'), 'minimax')
  assert.equal(kindForProvider('OpenRouter'), 'openrouter')
  // An unrecognized route still falls back rather than failing the chip.
  assert.equal(kindForProvider('some-custom-route'), 'deepseek')
  assert.equal(kindForProvider('modlens-some-custom-route'), 'deepseek')
})

test('Alibaba Cloud Model Studio routes and Qwen models resolve to alibaba', () => {
  const kindForProvider = loadMapping(readFileSync(BUNDLE, 'utf8'))
  for (const route of ['alibaba-cloud', 'alibaba', 'dashscope', 'bailian', 'qwen', 'model-studio']) {
    assert.equal(kindForProvider(route), 'alibaba')
  }
  assert.equal(kindForProvider('modlens-alibaba-cloud'), 'alibaba')
  // Custom openai-compat channels carry arbitrary ids; Qwen models only exist
  // on Model Studio, so the model name identifies the provider.
  assert.equal(kindForProvider('my-relay', 'qwen3.8-max'), 'alibaba')
  assert.equal(kindForProvider('my-relay', 'Qwen4-Max-Preview'), 'alibaba')
  // DeepSeek models on a custom route stay DeepSeek: the id, not the model,
  // decides there, because DeepSeek sells the same models directly.
  assert.equal(kindForProvider('my-relay', 'deepseek-v4-pro'), 'deepseek')
  assert.equal(kindForProvider('deepseek', 'qwen3.8-max'), 'deepseek')
})
