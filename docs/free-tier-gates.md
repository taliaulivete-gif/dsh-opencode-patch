# The free tier's three gates — hand-off

Every one of these refuses with a **byte-identical** `403 FreeTierError` body. From
outside the process they are indistinguishable, so fixing one looks like a complete
fix and the next turn fails identically. That is the whole hazard this file exists
to record: until each was isolated by changing exactly one variable, every patch
looked sufficient.

Do not narrow any of the three scopes back. Each was a measured refusal, not a
guess, and two of them are counter-intuitive.

---

## Gate 1 — the `ses_` id encodes an *inverted* timestamp

`src/session.ts` · `openCodeSessionIdFor`

The twelve hex characters after `ses_` are
`~(milliseconds * 0x1000 + counter)`, low 48 bits. Two details are load-bearing:

1. **The field is bit-inverted.** `time.ts` complements the whole value on the way
   in, so `counter = 1` puts the low twelve bits on `0xFFE` and the hex ends `ffe`.
   Encoded without the inversion the hex ends `001` instead, and the request is
   refused.
2. **The counter must decode into 1..63.** It occupies the low twelve bits before
   inversion, so the accepted band surfaces as `0xFC0`..`0xFFE`.

Measured single-variable ablation — identical body, headers and credential, only
the session value changed:

```
ses_ecb0c523dffe…  ->  200   data: {"id":"gen-…","object":"chat.completion.chunk"
ses_5de271cd159c…  ->  403   FreeTierError
```

A hash-derived counter lands in that band roughly **once in 4096**. That is why
every probe appeared to fail with no pattern, and why the header looked worthless
while being present, correctly spelled and stable.

The embedded timestamp is *not* what the gate checks — ids hundreds of days stale
or ahead are served. Only the counter band is. That is what lets the value stay
stable per conversation, which session affinity requires, without reading a clock
on every turn.

`hasPlausibleCounter()` is exported for exactly this: an id that is present and
well-formed is not necessarily one that will be served.

> The lint bans the bitwise operators outright, so the inversion is written
> `BigInt.asUintN(48, -value - 1n)` — the same operation, since `~x === -x - 1`.
> **Do not "simplify" that back into `&`.** It is the difference between a served
> request and a refused one.

## Gate 2 — `stream: true` is mandatory

`src/tool-fallback.ts` · `maybeForceStreaming`

With an in-band session id, a non-empty `tools` array and every identity header
present, a request carrying `stream: true` is served and the same request without
it is refused. Seven header combinations were all served with it and all refused
without it — full CLI User-Agent vs bare `opencode/1.19.0`, `x-opencode-client:
cli` vs `desktop` — so this is the discriminating variable, **not** the
User-Agent. A widely-repeated claim that the User-Agent shape is the gate does not
survive ablation.

Scoped exactly like the core-tool fallback: free-tier models only, and a body
that already says `stream: true` passes through byte-identical.

## Gate 3 — the `read`/`bash` schemas, on the *chat* path too

`src/tool-fallback.ts` · `maybeInjectCoreTools`

The requirement is not specific to `/responses`. On `/chat/completions` the
gateway refuses a free-tier body that lacks `read` and `bash`:

```
read + bash                          200  served
no tools key                         403
tools: []                            403
only bash                            403
only read                            403
one unrelated tool                   403
a realistic toolset without them     403
```

This matters more than it looks. `space-bunny-free` answers `/responses` with
`ModelProtocolUnsupported`, so for such a model the chat path is the **only** path
it can be reached on. Scoping the fallback to `/responses` therefore left those
models with no schemas at all — which looks from the outside exactly like a header
that does not matter.

Note the shape difference the code already handles: the chat path injects the
OpenAI-shaped schemas, whose names sit under `function`, not at the top level. A
test helper that reads only `tool.name` will report `[]` for a correct rewrite.

---

## Verifying

```sh
pnpm run typecheck      # 0
pnpm run lint           # 0
pnpm exec vp test run   # 824 passed / 46 files
pnpm run build
```

The e2e suites are opt-in because one of them binds a socket:

```sh
OPENCODE_E2E=1 pnpm exec vp test --config=vitest.e2e.config.ts run
```

`test/e2e/zen-free-tier-gate.e2e.ts` is an **offline replica** of this gate: a
loopback listener that enforces the same nine conditions and answers with the same
403 body, so the 403→400 demultiplexing and every header on the wire are proven
without a network. It encodes a hypothesis about the gate and cannot detect the
vendor tightening it. It is a regression guard on this plugin's half of the
contract — never evidence that the real free tier works.

## What is genuinely still closed

Workspace-bound models still need a console session (`opencode console login`);
the org id travels as `x-opencode-org-id`, which the gateway reads on its own —
a malformed value changes the answer, an unrelated malformed header does not.
That path is separate from the three gates above and none of them substitute for
it.