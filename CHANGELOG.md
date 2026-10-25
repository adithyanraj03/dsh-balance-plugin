# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every release is also published on [GitHub Releases](https://github.com/andregoncalves/dsh-balance/releases)
and on [npm](https://www.npmjs.com/package/@andrecgoncalves/dsh-balance).

## [0.5.0] — 2026-10-26

### Changed

- The chip moved from the sidebar foot to the **composer dock** — the status strip
  below the search bar that carries the activity, usage and context pills. It
  registers on the `conversation.composer.dock` slot (order 100, behind the chat's
  own entries) and is pinned to the strip's **right end**, after the context
  meter, by writing a large CSS `order` on its slot outlet (`applyDockOrder`).
  The outlet is the dock row's real flex child — the slot runtime wraps every
  list entry in a `[data-slot]` element — so the order goes there (and on the
  anchor, covering runtimes that render the entry directly), and both values are
  restored on unmount.
- The chip is restyled as a compact strip pill (20px line, no box of its own) so
  it reads as one of the dock's items instead of a button dropped onto it.
- `dsh.client.inject` and the peer list now name
  `@deepseek-ai/dsh-client-ui-conversation` instead of
  `@deepseek-ai/dsh-client-ui-sidebar`.

### Removed

- The sidebar-foot rescue (`applySidebarFooterLayout`, `applyFooterFlex`,
  `collectStyleOwners`, `clearFooterStyles`) and the `wide` owner-share prop —
  the dock renders only in a session's composer view, so the collapsed-rail
  special case and the two-seat flex rewrite are both obsolete.

## [0.4.3] — 2026-09-28

### Fixed

- The chip no longer overlaps the sidebar's account row. The sidebar footer is now two
  stacked full-width seats — the `sidebar.footer.action` slot, then the seat holding the
  account launcher ("Signed in to DeepSeek") and the Settings trigger — where the older
  foot was a single row of "actions, then Settings". The rescue in `applySidebarFooterLayout`
  still assumed the old shape and gave the action seat `flex: 1`, which sized the account
  seat to its **min-content** width; its label is laid out with `overflow: hidden` and a
  fixed text box, so it painted straight under the chip instead of truncating.
- The chip now takes exactly the width its own content needs — `width: max-content` with
  `flex: 0 0 auto` on its seat — so it never claims a share of the row's free space, and
  every remaining pixel goes to the account label, which is the seat that yields
  (`flex: 1 1 auto; min-width: 0`) and truncates with an ellipsis only when it must.
- The chip keeps its amount at every sidebar width. An intermediate revision gave the chip a
  compact mark-and-dot form for narrow footers, judged by whether dropping the amount would
  let the account label fit — but that traded away the balance (the plugin's entire reason to
  exist) to protect a label the core app already truncates with an ellipsis, and it hid the
  number in the app's default window. The footer is now strictly one-way: the chip takes its
  own content width and never yields it, and only the account label truncates. The dot keeps
  its provider meaning and the tooltip keeps the full breakdown.
- The chip now sits on the account row's line instead of a few pixels above it. Its
  `4px auto 6px 0` margin was left over from when it sat alone above the Settings seat and
  needed optical separation; now that it is a flex sibling that the foot centres, those
  margins offset it — the asymmetric pair held it above the row's centre. The chip
  contributes no vertical margin and is 32px tall, the same box the account row presents
  inside its own 4px `.triggerRow` margin, so the two seats centre on the same line rather
  than merely sharing a text baseline.
- `marginLeft: 'auto'` in the chip's style object never took effect: the later `margin`
  shorthand overwrote it, because React writes style keys in object order. The chip's own
  right-push margin is now spelled as a longhand inside the shorthand.
- The rescue reverses the foot with `row` plus an explicit `order` instead of the physical
  `row-reverse`, and it prefers the slot's own element over the plugin row when the sidebar
  wraps the slot, so the layout no longer depends on which side of the slot the anchor sits.
- The client bundle no longer declares the retired `@deepseek-ai/dsh-client-web-react`
  platform package as an external. The shell does not seed that module into its frozen module
  table, so an import of it would throw at load time; the package is not imported, and the
  declaration was a latent trap as well as a violation of the upstream client-bundle purity
  gate.

## [0.4.2] — 2026-09-28

### Fixed

- The chip now resolves the open Session on DSH `0.1.6-alpha.2` as well as `0.1.6-alpha.1`. alpha.2
  removed the sessions snapshot's `current` field (`ISessions.list` now documents that "navigation
  belongs to view owners"), so `useSessions(s => s.current)` was permanently `undefined`. The chip
  then fell through to its DeepSeek fallback and, on a Host without `DEEPSEEK_API_KEY`, rendered the
  "Balance —" error pill in every session — including OpenRouter sessions — regardless of the
  selected model. `currentSessionId` reads alpha.1's `current` when present, and otherwise derives
  the open Session from main-view retention (`retainedBy.mainView`) — the same derivation
  `ui-session` and `DocumentTitle` use. `scripts/verify-client.mjs` covers both snapshot shapes, the
  count-not-boolean case, and the empty and no-retention fallbacks.
- The balance chip no longer falls back to the DeepSeek balance on the modlens vision plugin's
  synthetic wrapper routes. modlens registers `modlens-<upstream>` (and the legacy
  `deepseek-modlens`) so a text-only model can accept pasted images, and those routes bill the
  upstream provider's account; `kindForProvider` knew only the bare catalog names, so every
  `modlens-*` route fell through to DeepSeek, and an OpenRouter session showed a
  missing-`DEEPSEEK_API_KEY` error instead of the credits it was spending. `unwrapModlensProvider`
  strips the wrapper prefix before matching. `test/kind-for-provider.test.mjs` asserts the mapping
  against the built `lib/client.js` — the artifact the browser loads — and runs in CI after the
  build, so a source-only fix cannot pass it.

## [0.4.1] — 2026-09-09

### Fixed

- Provider detection in the browser half. The chip read the active session's provider through a
  `connection.api.sessions.models(...)` call that does not exist in DSH (the `connection` service is
  a `ConnectionHandle` with `rpc`, not a session API), so the lookup always threw and the chip
  silently fell back to the DeepSeek balance in every session, including OpenRouter, Moonshot, Zhipu,
  and MiniMax sessions. It now reads `ctx.modelDirectories.directoryFor(sessionId).store` — the same
  shared state the composer's model seat writes — and keeps the model-directory subscription that
  re-polls on a model switch. `scripts/verify-client.mjs` now asserts the resolved `kind` for each
  provider route, the OpenRouter regression included.

## [0.4.0] — 2026-09-09

First public release.

### Added

- Provider-aware balance chip in the sidebar foot (`sidebar.footer.action`) for the active model's
  provider: DeepSeek, OpenRouter, Moonshot/Kimi, Zhipu/GLM (Z.ai), and MiniMax.
- DeepSeek peak/off-peak status dot — peak is Monday–Friday, Beijing time (UTC+8) 09:00–12:00 and
  14:00–18:00 (01:00–04:00 and 06:00–10:00 UTC); every other hour, including the whole weekend, is
  off-peak at half the peak price.
- Host route `GET /plugins/balance?kind=…`; the API key is resolved on the host through the
  credentials seam and never reaches the browser.
- Automatic refresh every 60 seconds, on click, on session change, and on model switch.
- `dsh.bundle` manifest, so `dsh plugin --profile web add @andrecgoncalves/dsh-balance` wires the
  sidebar row without a manual profile patch.
- Mock mode (`DSH_BALANCE_MOCK=1` or `?mock=1`) for previewing any provider without an account.
- Bilingual README (English and Chinese), light/dark screenshots, and a `screenshots.json`
  declaration for plugin storefronts.

[0.4.1]: https://github.com/andregoncalves/dsh-balance/releases/tag/v0.4.1
[0.4.0]: https://github.com/andregoncalves/dsh-balance/releases/tag/v0.4.0
