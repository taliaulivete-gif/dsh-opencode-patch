---
tags:
  - dsh
  - plugin
  - opencode
  - cordis
status: note
aliases:
  - dsh-opencode-patch
---

# `dsh-opencode-patch` — working notes

What this repository is, the rules a change has to follow, and where things live. The user-facing side is the [README](./README.md); the design reasoning and protocol findings are in [docs/engineering-notes.md](./docs/engineering-notes.md); the protocol internals are in [docs/deep-dive.md](./docs/deep-dive.md) and [docs/protocol-routing-and-merge.md](./docs/protocol-routing-and-merge.md).

## HARD RULE: a local path never leaves the machine

An absolute path from a development machine (`/Users/<name>/…`, `/home/<name>/…`, `C:\Users\…`) must never appear anywhere a third party can read: documentation, code comments, examples, fixtures, commit messages, issue text, or a published artifact. It leaks a username, an operating system and a directory layout, and it is worthless to the reader anyway.

- Use a neutral placeholder in prose and examples — `/home/you/projects/my-app`, `~/dev/my-app`, or just the folder name.
- **Grep the artifact, not just the tree**, before publishing.
- Generated output counts: coverage reports, source maps and logs carry absolute paths, so they are gitignored, never committed.
- The check belongs **before** the commit. Once it ships, removing it means rewriting content _and_ history, force-pushing over every tag, and invalidating published provenance.

## HARD RULE: internal notes are private by default

A file's name does not decide whether it is public — its content does. Incident logs, machine-specific commands, credential-resolution details and per-project retrospectives belong outside the repository. This file is deliberately the _public_ half; nothing here should describe a particular machine, account or workflow.

## HARD RULE: a value that arrives on one path is read on every path

A `fetch` call carries its headers and its body in two different places: `init.headers` / `init.body`, or the `input` `Request` itself. The interceptor read **headers from both** and the body from `init` alone — and that asymmetry was the whole of a week-long fault, because the host issues inference as `fetch(new Request(url, { body }))`, so the free-tier tool injection was skipped for exactly the turns that needed it.

- **If a value can arrive on two paths, read it on both.** `clone()` keeps a `Request`'s body readable, so there is no excuse for reading the cheaper one.
- **Assert what leaves, not that a helper works.** `tool-fallback.test.ts` covered `maybeInjectCoreTools` exhaustively — both schemas, every dialect, every marker — and all of it passed while real turns were being refused, because the function was never called for them. `free-tier-contract.test.ts` asserts the contract on the wire across every body source; that is the file that would have caught it on day one.
- **Read a fact from the fact.** Freeness came from `modelId.includes("-free")`, and a test comment recorded *why* it had to: "a model row carries no capability flag — the id is the only signal". The row does carry one, `is_free`. `big-pickle` is free with no `-free` in its name, so the substring test left it out and the gateway refused it. A name is a hint; the catalog is the record.
- **A refusal that reads like another refusal sends you the wrong way.** The free tier answers a missing `read`/`bash` with a 403 whose body is byte-identical to an exhausted quota, which is why this was diagnosed as credentials, then limits, then session ids, then workspace. Log the discriminator (`toolNames`, `bodySource`, `sessionCounter`) so the next one is a one-line read.

## Rules a change must follow

- **Start from the host's built-ins.** Read `@deepseek-ai/dsh-client-ui-primitives` before writing any UI. It ships the components _and_ one CSS module each, which is the fastest inventory of the design language available. A component we hand-roll is one whose CSS module we never opened.
- **Declare cross-plugin services, and know how each access fails.** Measured against cordis: `ctx.get(name)` reads the scope's store and does **not** consult `inject`, so an undeclared service answers `undefined` silently; only property access (`ctx.name`) throws `cannot get property "name" without inject`. Capture an optional service through `ctx.inject([name], scope => …)`, which is a real child scope that can see it — and do **not** hand-roll a context wrapper to make one reachable: a copy that replaces `get` is not a cordis context, and passing it where the host's own context was expected takes the whole host down.
- **The `Tooltip` clones its child.** Wrap a DOM node, never a component, or the tooltip attaches handlers to something that ignores them and never appears.
- **One switch per surface.** A switch whose effect only exists inside another switch's surface is a state, not a decision.
- **Opt into the theme; do not re-declare it.** `data-menu-material="translucent"` and no hand-set stroke, so both themes stay right.
- **Verify the artifact, not the command's output.** A grep over a directory that does not exist is indistinguishable from a grep that found nothing; a cached registry read makes a completed operation look pending. Assert that the input was actually read, and include a case whose answer you already know.
- **A test for a behaviour must perform that behaviour.** Asserting a constant is not the same as exercising a switch.

## Repo map

Host bundle (`lib/index.mjs`), a thin `apply` barrel over small modules:

- `src/index.ts` · `src/identity.ts` · `src/lifecycle.ts` — the public barrel, the identity constants, and the `apply()` composition (one installer per side effect, in load-bearing order).
- `src/config.ts` · `src/config-values.ts` · `src/guards.ts` — the schema and its defaults; dependency-free readers and type guards. The client bundle may import these, and it does — along with the contract and presentation modules (`usage-contract.ts`, `login-contract.ts`, `settings-copy.ts`, `settings-fields.ts`, `usage-ui.ts`, `go-limits.ts`). The rule is not a list of names: **the client may import a module that reaches nothing host-only** — no cordis context, no credential seam, no node built-in — and the bundle gate is what enforces it, by failing the build rather than by anyone remembering. An earlier version of this line named two files as the only ones allowed, which the tree had already outgrown.
- `src/session.ts` · `src/turn-store.ts` — the `ses_<12hex><14base62>` derivation and the `AsyncLocalStorage` turn store.
- `src/stream-hook.ts` · `src/fetch-patch.ts` · `src/tool-fallback.ts` — the `llm/stream` hook, the fetch interceptor, and the free-tier `read`/`bash` fallback. `tool-fallback.ts` reads freeness from the **catalog's `is_free`**, not from the shape of the id — see the two-source rule below, because both halves of that entry were wrong in ways a unit test could not see.
- `src/key-capture.ts` · `src/go-discovery.ts` · `src/usage.ts` · `src/usage-contract.ts` — credential extraction, quota discovery, the usage service, and the shared shape.
- `src/catalog-data.ts` · `src/models-catalog.ts` · `src/models-discovery.ts` — the generated static shim, the `models.dev` parser with SWR refresh, and discovery decoration. `catalog-data.ts` is **generated**; never hand-edit it.
- A note on the sweep that found the two entries around here, because it nearly produced a false one: grepping for a symbol's callers while EXCLUDING the file that defines it makes every same-file call look like no call at all. `resolveGoKeyForRef` reads as unreferenced that way and is not — `resolveGoApiKey` calls it, and the usage service calls that, which is how the Go endpoint keeps Zen keys away from itself. Check the defining file too before believing an export is dead.

**The general form, because this shape recurred twice in one session**: a sweep that resolves a name in the wrong CONTEXT reports a clean tree as broken. Grepping for callers without the defining file makes same-file calls look absent; resolving a doc's relative links from the repository root instead of from the file's own directory makes every link look dead. Both produced a list of confident findings and both were entirely wrong. A third instance is reading a UTC timestamp as local time and concluding that a workflow had not run since the previous evening, when it had run twenty minutes earlier — same shape, wrong context, confident conclusion. Before acting on a sweep, check that the thing being searched is the thing the claim is about, including the clock it is written in.

- `src/go-limits.ts` — the allowance lookup, the label normalization and the money formatting. `allowanceFor` is the tested one and `attachAllowance` in `usage.ts` is what the meter actually calls, and they are the same lookup written twice: the second inlines `GO_MODEL_LIMITS[model] ?? GO_MODEL_LIMITS[model.toLowerCase()]` where the first normalizes. They agree today, which is why this is a duplication and not a bug — and the tested one is the one nothing calls, so the next change to either will land on the untested side.
- `src/go-limits-data.ts` — the Go plan allowances, per model and per tier, **generated** from the vendor's own page by `scripts/generate-go-limits.ts`; never hand-edit it, and regenerate with `pnpm run limits:shim -- --write`. The scheduled freshness job is what notices when the page moves, which it did: the docs went under `/v2/docs/console/` and serve HTML now, so the generator reads a table off that page rather than the markdown it used to.
- `src/responses-routes.ts` · `src/responses-provider.ts` — the protocol table and the in-process mount of the host's `llm-pi-ai`.
- `src/session-cost.ts` · `src/cordis-context.ts` · `src/debug.ts` — per-turn accounting, the typed host interfaces, and stream debug logging.
- `src/pi-provider.ts` — the per-protocol base URLs, the pi model object, and the gateway headers. Every value here is measured; see `docs/redirect-planes.md`.
- `src/google-bridge.ts` — the Google models, served through the plugin's own adapter on the real `llm` service. It is the ONLY module that imports pi at runtime, and its route is `opencode-google` so the `google` name stays free for a real deployment.
- `src/credential-pool.ts` — several credentials per plane, one active at a time. Off unless a deployment enables it, and rotation WRITES through the reference the pool owns, which is the only path that reaches the routes the wrapper serves.
- `src/opencode-paths.ts` — where an OpenCode installation keeps its files, ported from `~/dev/opencode`'s `global-roots.ts` (the directory) and `database-path.ts` (the filename). It takes `home`, `env` and `channel` as parameters and reads neither the environment nor the filesystem, which is what makes the Windows and Linux layouts testable from here. Two facts it encodes that are easy to get wrong: the directory is XDG on EVERY platform — macOS and Windows use `~/.local/share` too, and `os.homedir()` is the only platform-dependent call — and the FILENAME is not constant, being `$OPENCODE_DB`, else `opencode.db` on a stable channel, else `opencode-<channel>.db`. The database sits under `data` while the config sits under `config`, so one root cannot serve both. It is the foundation of the opt-in reader: `go-discovery.ts`'s `resolveOpencodeStoreKey` is what imports it, and nothing else does.
- `src/opencode-store.ts` — reading the credentials an OpenCode installation already holds, through `node:sqlite`. Two rules shape it: nothing throws (a missing file, a foreign schema and `:memory:` all answer `undefined`), and a value never leaves the return value — no log line, no error message, no client bundle. `node:sqlite` is host-only, which is what keeps the module on the host side of the bundle rule. It is reached only through `resolveOpencodeStoreKey`, which is the last step of every key-source policy and is off unless `readOpencodeStore` is on.
- `src/console-auth.ts` — the Console device flow and the two reads a login needs: `/api/user` and `/api/orgs`.
- `src/token-store.ts` — a login as one `grant` record: the token pair and its owner, written atomically.
- `src/login-flow.ts` — the flow that keeps what it learned. A login that cannot read its owner FAILS rather than storing a token without its org. It also exports two conveniences nothing calls: `orgForLogin`, which is `login?.orgId`, and `summarizeLogin`, which is the owner and the tokens as one value. They are not missing behaviour the way `login-session.ts` was — the seam's `state()` deliberately carries no tokens, so `summarizeLogin` is for a host-side caller that does not exist yet, and `orgForLogin` is a one-line accessor. Read them as API surface rather than as wiring: safe to delete, and nothing is silently absent while they are here.
- `src/login-contract.ts` · `src/login-service.ts` — the three calls a settings card makes (`begin`, `poll`, `state`), their codecs, and the host half that answers them. **A credential never crosses this seam**: the state carries an email and an org, and the parser is a whitelist.
- `src/login-session.ts` — the session for one plane: it joins the store and the client and refreshes the token BEFORE handing it out, so `token()` answers one good for the next call and a caller never handles an expired one. **`loginTokenReader` goes through it**, which is the point — reading the store directly, which the reader used to do, hands out whatever is on disk until it expires and then fails. Worth knowing how it was found: it was referenced by nothing but its own test for a while, and the first reading of that was 'dead code'. It was the half that was missing.
- A timing dependency both remotes share, worth knowing before debugging a row that will not appear: the mount is an async `$mount` started in an effect, and the card reads `ctx.remote.opencodeLogin` / `.opencodeGoUsage` SYNCHRONOUSLY when its injector builds the props. If the injector runs before the mount resolves, the service is not there yet and the surface renders nothing. The meter won that race in the deployment this was written for — its card rendered with `readUsage` present, which is only possible if the injector saw the mounted remote — and the sign-in row did NOT, because its remote was never mounted at all. So the race is real but was not the cause here; the cause was the missing mount, one entry up. Both now report when the lookup comes back empty — `no opencodeLogin service on the remote` with the keys the remote does expose — so the symptom is a line in the console rather than a blank.
- `src/org-cache.ts` — the org a plane's requests carry, in one small module both sides import. `patchFetch` asks for it synchronously and cannot go to the store itself, so the login service writes it when a login completes: a value read once at startup would miss a grant that appeared minutes later, which is exactly what it did.

Web client bundle (`lib/client.js`): `src/settings-page.tsx` (entry, wiring only), the `settings-*` card and its controls, the sign-in row — `src/settings-login.tsx` — and the meter — `src/usage-pill.tsx` (state), `src/usage-panel.tsx` (pure views), `src/usage-ui.ts` (logic and stylesheet).

## Commands

```sh
vp test run            # unit suite
vp test run --coverage # with the coverage ratchet (95/90/93/95)
vp check               # format, lint, types
vp fmt --write         # rewrite formatting
vp pack                # build lib/ (host bundle + client bundle)
node --experimental-strip-types scripts/check.ts   # bundle gate
```

`lib/` is built output and is not committed; the host loads `lib/index.mjs`, so a source change is not deployed until `vp pack` runs.

**And the process has to restart, not just the page.** The host bundle is read once at process start — a deployment installs this package through a `link:`, so there is nothing to reinstall and nothing to notice a newer file. A browser reload picks up `lib/client.js` and keeps running the `lib/index.mjs` the process started with, which makes a client-side fix look like it did nothing and a host-side diagnostic look like it never ran. Measured the hard way: a running host was two and a half hours and eleven commits behind its own build, and every "it still does not work" in between was answered by a file that was never loaded.

## A known local-only failure in the bundle gate

`scripts/check.ts` ends with a consumer install, and it can fail with `ETARGET: No matching version found for @aws-sdk/nested-clients@^3.997.48` on a machine where the registry has only `3.997.46` and `3.997.47`. The chain is ours only by accident: `@earendil-works/pi-ai` → `@aws-sdk/client-bedrock-runtime` → `@aws-sdk/credential-provider-node` → `nested-clients`, and the lockfile pins `3.997.46`, which exists. It is npm resolving a caret range to a version that has not been published, not anything this repository wrote — CI passes on the same commit. Re-run when the registry catches up; do not "fix" it by loosening the lockfile.

## Releasing

Releases are cut by release-please from Conventional Commit subjects, and published to npm by `.github/workflows/release.yml` through OIDC trusted publishing (no stored token). **`CHANGELOG.md` is owned by release-please — never hand-edit it**; clarity comes from commit subjects and the `changelog-sections` mapping in the release-please workflow.

**Let release-please drive the release.** Its version anchor is the latest GitHub **Release**, not the latest tag, so a manual cut (`npm version` + `git tag` + push) creates a tag it cannot see. It then keeps computing from the last release it knows: it re-proposes a version that is already published, that pull request _regresses_ `package.json`, and its next run fails with `already_exists` when it tries to create the release a second time. If a manual cut is ever necessary, create the GitHub Release as part of it (`gh release create <tag> --generate-notes`).
