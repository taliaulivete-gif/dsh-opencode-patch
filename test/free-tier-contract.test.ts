/**
 * The free tier's contract, enforced on the wire rather than on a function.
 *
 * `tool-fallback.test.ts` covers `maybeInjectCoreTools` exhaustively: both
 * schemas, every dialect, every marker, every body it must not touch. All of
 * that passed while a real turn was being refused, because the function was
 * never called for it.
 *
 * The hole was one level up. The injection sat behind `init?.body !== undefined`,
 * so a caller that issued `fetch(new Request(url, { body }))` — which is how
 * the host issues inference on some paths — skipped the block entirely and left
 * for the gateway with whatever tools its mode happened to supply. In Agent
 * Team mode that set carried no `bash`. The gateway answers a free-tier body
 * without `read` and `bash` with `403 FreeTierError`, whose body is
 * byte-identical to a genuine quota refusal, so the turn reads as "you are out
 * of free tier" and points every diagnosis at limits, credentials and session
 * ids instead.
 *
 * Headers were already read from `input` and `init` together. Only the body
 * was single-sourced, and that asymmetry is the whole fault.
 *
 * So this file asserts the CONTRACT — not that a helper works, but that what
 * leaves `patchFetch` satisfies the gateway — across every way a body can
 * arrive. A new body source, or a new free model, has to pass here too, which
 * is the point: the failure mode is a silent skip, and a matrix is what turns
 * a silent skip into a red test.
 *
 * @module test/free-tier-contract
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DUMMY_BASH_TOOL,
  DUMMY_READ_TOOL,
  OPENCODE_ZEN_CATALOG,
  SESSION_HEADER,
  openCodeSessionIdFor,
  patchFetch,
  resolveConfig,
  type ActiveTurnState,
} from "../src/index.ts";
import { createCaptureFetch, headerOf, toolNamesOf } from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
});

const GATEWAY = "https://opencode.ai/zen/v1";

/**
 * Every inference path the free tier is reached on. `/responses` and
 * `/messages` answer `ModelProtocolUnsupported` for most free models, but a
 * free model that does speak one of them must meet the same contract there,
 * so all three are covered.
 */
const INFERENCE_PATHS = ["/chat/completions", "/responses", "/messages"];

/**
 * Every free tier in the shipped catalog, read from the catalog rather than
 * listed by hand. A hand-written list is a list that stops being true the
 * next time the catalog is regenerated, and then the new free model is
 * covered by no test at all — which is the failure this file exists to make
 * impossible.
 */
const FREE_MODELS = OPENCODE_ZEN_CATALOG.filter(
  (model) => model.is_free === true
).map((model) => model.id);

/** A body in the shape that was being refused: one core tool, no `bash`. */
const bodyFor = (model: string): string =>
  JSON.stringify({
    max_tokens: 256,
    messages: [{ content: "hi", role: "user" }],
    model,
    stream: true,
    tools: [DUMMY_READ_TOOL],
  });

/**
 * The body as it will actually be sent, wherever the interceptor put it: on a
 * rebuilt `Request`, or in `init`. Reading only `init` is how the fault stayed
 * invisible — on the borrowed path that field is empty and the diagnostic
 * reported nothing at all.
 */
const sentBody = async (
  input: RequestInfo | URL | undefined,
  init: RequestInit | undefined
): Promise<unknown> => {
  let raw = "";
  if (input instanceof Request) {
    raw = await input.clone().text();
  } else if (typeof init?.body === "string") {
    raw = init.body;
  }
  expect(raw.length).toBeGreaterThan(0);
  return JSON.parse(raw) as unknown;
};

/** Dispatch one call the way the host can, and hand back what left. */
const dispatch = async (
  path: string,
  model: string,
  carry: (url: string, body: string) => [RequestInfo | URL, RequestInit | undefined],
  body = bodyFor(model)
): Promise<{ body: unknown; session: string | null; claimed: boolean }> => {
  const als = new AsyncLocalStorage<ActiveTurnState>();
  const { capture, mockFetch } = createCaptureFetch();
  const patched = patchFetch(mockFetch, als, resolveConfig());
  const session = openCodeSessionIdFor(`contract-${path}-${model}`);
  const [input, init] = carry(`${GATEWAY}${path}`, body);

  await als.run({ provider: "opencode", value: session }, async () => {
    await patched(input, init);
  });

  return {
    body: await sentBody(capture.input, capture.init),
    claimed: headerOf(capture.init, SESSION_HEADER) === session,
    session: headerOf(capture.init, SESSION_HEADER),
  };
};

/** How a caller puts the body on a `Request` and leaves `init` empty. */
const onARequest = (
  url: string,
  body: string
): [RequestInfo | URL, RequestInit | undefined] => [
  new Request(url, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  }),
  undefined,
];

/** The three ways a caller can put a body in front of `fetch`. */
const BODY_SOURCES: ReadonlyArray<
  [
    name: string,
    carry: (url: string, body: string) => [RequestInfo | URL, RequestInit | undefined]
  ]
> = [
  ["init string body", (url, body) => [url, { body, method: "POST" }]],
  ["Request body", onARequest],
  [
    "Request plus a spare init",
    (url, body) => {
      const [request] = onARequest(url, body);
      return [request, { method: "POST" }];
    },
  ],
  ["Buffer body", (url, body) => [url, { body: Buffer.from(body), method: "POST" }]],
];

describe("the free tier's contract, on the wire", () => {
  it("finds free models to test against, so the matrix below is not vacuous", () => {
    // A matrix that silently covers nothing is worse than no matrix. If the
    // catalog loses its free tiers, this fails before the loops can pass
    // vacuously.
    expect(FREE_MODELS.length).toBeGreaterThan(0);
    expect(FREE_MODELS).toContain("space-bunny-free");
  });

  for (const path of INFERENCE_PATHS) {
    for (const [sourceName, carry] of BODY_SOURCES) {
      it(`carries read and bash to ${path} via a ${sourceName}`, async () => {
        const { body, claimed, session } = await dispatch(
          path,
          "space-bunny-free",
          carry
        );

        // Claimed first. An unclaimed request was never a candidate, so a
        // passing assertion below would mean nothing.
        expect(claimed).toBe(true);
        expect(session).not.toBeNull();
        expect(toolNamesOf(body)).toEqual(
          expect.arrayContaining(["read", "bash"])
        );
      });
    }
  }

  it("forces streaming on every body source, not just the one it was written for", async () => {
    for (const [sourceName, carry] of BODY_SOURCES) {
      const { body } = await dispatch(
        "/chat/completions",
        "space-bunny-free",
        carry,
        // A body that arrives without `stream`, so the requirement is tested
        // rather than satisfied by what the caller happened to send.
        JSON.stringify({
          max_tokens: 256,
          messages: [{ content: "hi", role: "user" }],
          model: "space-bunny-free",
          tools: [DUMMY_READ_TOOL],
        })
      );
      expect(body, `stream not forced for a ${sourceName}`).toMatchObject({
        stream: true,
      });
    }
  });

  it("covers every free tier the catalog ships, not the ones we remembered", async () => {
    // The `Request` source specifically: that is the path that was skipped.
    for (const model of FREE_MODELS) {
      const { body, claimed } = await dispatch(
        "/chat/completions",
        model,
        onARequest
      );
      expect(claimed, `free model ${model} was not claimed`).toBe(true);
      expect(
        toolNamesOf(body),
        `free model ${model} left without read and bash`
      ).toEqual(expect.arrayContaining(["read", "bash"]));
    }
  });

  it("leaves a body that already carries both tools byte-identical", async () => {
    // The contract is a floor, not a mandate: a caller that already declares
    // the core tools must not have its body rewritten under it.
    const als = new AsyncLocalStorage<ActiveTurnState>();
    const { capture, mockFetch } = createCaptureFetch();
    const patched = patchFetch(mockFetch, als, resolveConfig());
    const body = JSON.stringify({
      max_tokens: 256,
      messages: [{ content: "hi", role: "user" }],
      model: "space-bunny-free",
      stream: true,
      tools: [DUMMY_READ_TOOL, DUMMY_BASH_TOOL],
    });

    await als.run(
      { provider: "opencode", value: openCodeSessionIdFor("already-complete") },
      async () => {
        await patched(`${GATEWAY}/chat/completions`, { body, method: "POST" });
      }
    );

    expect(capture.init?.body).toBe(body);
  });
});