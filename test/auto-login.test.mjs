// Regression test for the automatic bl-login terminal guard.
//
// When the Token Plan console session expires the host may open a terminal
// running `bl auth login` so the user can finish the browser flow. The guard
// must fire only for the expired-session note, respect the opt-out, and bound
// repeats with a cooldown so a 60s poll never spams windows.
//
// `lib/index.js` is the host artifact. Run `pnpm run build` first.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const bundle = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')

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

const shouldAutoLogin = new Function(`
  const AUTO_LOGIN_COOLDOWN_MS = 10 * 60_000;
  ${extractFunction(bundle, 'shouldAutoLogin')}
  return shouldAutoLogin;
`)()

const EXPIRED = 'bl console session expired — run: bl auth login --console'
const NOW = 1_000_000_000_000

test('only the expired-session note triggers a login terminal', () => {
  assert.equal(shouldAutoLogin(EXPIRED, NOW, 0, false), true)
  assert.equal(shouldAutoLogin('bl CLI not found — npm install -g bailian-cli', NOW, 0, false), false)
  assert.equal(shouldAutoLogin('bl quota read failed — click the chip to retry', NOW, 0, false), false)
  assert.equal(shouldAutoLogin(undefined, NOW, 0, false), false)
})

test('the opt-out disables the automatic terminal', () => {
  assert.equal(shouldAutoLogin(EXPIRED, NOW, 0, true), false)
})

test('the cooldown bounds repeated launches', () => {
  assert.equal(shouldAutoLogin(EXPIRED, NOW, NOW - 60_000, false), false, 'within cooldown')
  assert.equal(shouldAutoLogin(EXPIRED, NOW, NOW - 10 * 60_000, false), true, 'cooldown elapsed')
})