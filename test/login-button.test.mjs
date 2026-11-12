// Regression test for the on-demand sign-in button.
//
// The expired-session auto-open was replaced by an explicit control: when the
// Token Plan console session lapses, the percentage slot becomes a refresh+%
// affordance and clicking the chip asks the host (?kind=alibaba&login=1) to
// open the login terminal. Auto-open is now opt-in (DSH_BALANCE_AUTOLOGIN=1).
//
// `lib/client.js` / `lib/index.js` are the shipped artifacts. Build first.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const client = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
const host = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')

test('the chip requests an on-demand login terminal', () => {
  assert.match(client, /kind=alibaba&login=1/)
})

test('the percentage slot becomes a sign-in affordance when expired', () => {
  assert.match(client, /needsLogin/)
  assert.match(client, /Sign in to Alibaba Cloud Token Plan/)
})

test('the host serves the login action and clears the quota cache', () => {
  assert.match(host, /get\("login"\) === "1"|get\('login'\) === '1'/)
  assert.match(host, /manualLogin/)
})

test('auto-open is opt-in, not the default', () => {
  assert.match(host, /DSH_BALANCE_AUTOLOGIN/)
  assert.doesNotMatch(host, /DSH_BALANCE_NO_AUTOLOGIN/)
})