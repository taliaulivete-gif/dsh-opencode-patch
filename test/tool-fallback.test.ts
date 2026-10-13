/**
 * `tool-fallback.ts` — the free-tier `read`/`bash` schema fallback.
 *
 * The Zen gateway rejects a free-tier `/responses` body that lacks `read` and
 * `bash` in `tools`, so this module injects both — but only when they are
 * genuinely missing, and only for a model the marker matches.
 *
 * The cases are weighted toward the paths that must leave a body alone: one
 * that already declares both schemas, one for a paid model, one that is not
 * JSON, one that is not a re-readable string/Buffer, and any path that is not
 * `/responses`. Every one of those is a silent rewrite if it ever fires by
 * accident, because the only caller compares references — `patchFetch` swaps
 * the body exactly when the returned value is not the one it passed in.
 *
 * @module test/tool-fallback.test
 */

import { describe, expect, it } from "vitest";

import {
  ALL_MODELS_MARKER,
  DEFAULT_FREE_MODEL_MARKER,
  OPENCODE_ZEN_CATALOG,
} from "../src/index.ts";
import {
  DUMMY_BASH_TOOL,
  DUMMY_BASH_TOOL_ANTHROPIC,
  DUMMY_BASH_TOOL_FUNCTION,
  DUMMY_READ_TOOL,
  DUMMY_READ_TOOL_ANTHROPIC,
  DUMMY_READ_TOOL_FUNCTION,
  RESPONSES_PATH,
  isCoreToolModel,
  maybeForceStreaming,
  maybeInjectCoreTools,
} from "../src/tool-fallback.ts";
import { parseJsonBody, toolNamesOf } from "./test-helpers.ts";

const RESPONSES_URL = `https://opencode.ai/zen/v1${RESPONSES_PATH}`;

/** The one free-tier model the gateway serves on `/responses`. */
const FREE_MODEL = "muse-spark-1.3-contributor-free";

/** The shipped fallback options: enabled, scoped to the named marker. */
const options = (
  modelMarker = DEFAULT_FREE_MODEL_MARKER
): { enabled: boolean; modelMarker: string } => ({
  enabled: true,
  modelMarker,
});

/**
 * The body a rewrite produced, proven to be the string the injector returned.
 *
 * The return type is the whole `RequestInit["body"]`, so a case that expects a
 * rewrite has to narrow it rather than stringify it — stringifying a FormData
 * here would hand the assertion a value no code path could produce.
 */
const bodyText = (body: RequestInit["body"]): string => {
  if (typeof body !== "string") {
    throw new TypeError(`expected a rewritten string body, got ${typeof body}`);
  }
  return body;
};

describe("isCoreToolModel", () => {
  it("admits every model under the all-models marker", () => {
    expect(isCoreToolModel("gpt-5.1", ALL_MODELS_MARKER)).toBe(true);
    expect(isCoreToolModel(FREE_MODEL, ALL_MODELS_MARKER)).toBe(true);
    // Even a model id with nothing in it: the marker is the whole test, so
    // there is no substring left to fail.
    expect(isCoreToolModel("", ALL_MODELS_MARKER)).toBe(true);
  });

  it("admits no model under an empty marker", () => {
    // `resolveConfig` normalises a blank `freeModelMarker` back to the default,
    // so an empty marker only reaches this function from a direct caller. It
    // has to mean "off": `"anything".includes("")` is always true, so treating
    // it as a substring would rewrite every paid request on the gateway.
    expect(isCoreToolModel(FREE_MODEL, "")).toBe(false);
    expect(isCoreToolModel("gpt-5.1", "")).toBe(false);
    expect(isCoreToolModel("", "")).toBe(false);
  });

it("matches a substring, case-sensitively, anywhere in the id", () => {
    expect(isCoreToolModel(FREE_MODEL, DEFAULT_FREE_MODEL_MARKER)).toBe(true);
    expect(isCoreToolModel("ling-3.1-flash-free", "free")).toBe(true);
    expect(isCoreToolModel("acct-preview-9", "preview")).toBe(true);
    // Case-sensitivity holds for the SUBSTRING test, because the vendor's ids
    // are lower-case. It is not how freeness is decided — see the catalog test
    // below, which is the one that carries the weight.
    expect(isCoreToolModel("MUSE-SPARK-CONTRIBUTOR-FREE", "free")).toBe(false);
    expect(isCoreToolModel("gpt-5.1", DEFAULT_FREE_MODEL_MARKER)).toBe(false);
    expect(isCoreToolModel("gpt-5.1", "preview")).toBe(false);
  });

  it("takes freeness from the catalog rather than from the shape of the id", () => {
    // The belief this replaces is written in the comment these lines used to
    // carry: "a model row carries no capability flag — the id is the only
    // signal". The row does carry one: `is_free`. Reading it is what keeps a
    // free model whose name does not look free from being left without the
    // core tools, which the gateway refuses with a 403 that reads as an
    // exhausted quota rather than a missing schema.
    expect(isCoreToolModel("big-pickle", DEFAULT_FREE_MODEL_MARKER)).toBe(true);
    // Every free tier in the bundled catalog, whatever its name looks like.
    for (const model of OPENCODE_ZEN_CATALOG) {
      if (model.is_free !== true) {
        continue;
      }
      expect(
        isCoreToolModel(model.id, DEFAULT_FREE_MODEL_MARKER),
        `${model.id} is free but is out of scope`
      ).toBe(true);
    }
  });

  it("keeps a paid model out of scope even when the marker matches nothing", () => {
    expect(isCoreToolModel("gpt-5.1", DEFAULT_FREE_MODEL_MARKER)).toBe(false);
  });
});

describe("maybeInjectCoreTools: bodies it must not rewrite", () => {
  it("returns the body untouched when the fallback is switched off", () => {
    const body = JSON.stringify({ input: "hi", model: FREE_MODEL });
    const headers = new Headers();

    // The toggle is the user's off switch. Nothing may be parsed, rewritten or
    // measured here — a `content-length` written for a body that never changed
    // is the visible proof that something did run.
    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, {
      enabled: false,
      modelMarker: DEFAULT_FREE_MODEL_MARKER,
    });
    expect(out).toBe(body);
    expect(headers.get("content-length")).toBeNull();
  });

  it("returns the body untouched off every inference path", () => {
    const body = JSON.stringify({ input: "hi", model: FREE_MODEL });

    // A listing carries no `tools` and has no reason to grow two, so the path
    // check must come before any parsing. `/chat/completions` is NOT in this
    // set any more — see the next case.
    const headers = new Headers();
    expect(
      maybeInjectCoreTools("https://opencode.ai/zen/v1/models", body, headers, options())
    ).toBe(body);
    expect(headers.get("content-length")).toBeNull();
  });

  it("injects on the chat path, because the gate is not responses-specific", () => {
    // Measured 2026-10-13: `/chat/completions` refuses a free-tier body that
    // lacks `read` and `bash` exactly as `/responses` does — no `tools` key, an
    // empty array, `bash` alone and `read` alone were all refused, and only the
    // pair was served. And `space-bunny-free` answers `/responses` with
    // `ModelProtocolUnsupported`, so the chat path is the only path such a model
    // can be reached on. Scoping this to `/responses` therefore left those
    // models with no schemas at all, which looks from the outside exactly like
    // a header that does not matter.
    const headers = new Headers();
    const out = maybeInjectCoreTools(
      "https://opencode.ai/zen/v1/chat/completions",
      JSON.stringify({ messages: [], model: FREE_MODEL }),
      headers,
      options()
    );
    // The chat path injects the OpenAI-shaped schemas, which carry their name
// under `function` rather than at the top level — so read the shape the
// gateway actually receives rather than going through `toolNamesOf`.
const parsed = parseJsonBody(out) as {
      tools?: { function?: { name?: string } }[];
    };
    expect(parsed.tools?.map((tool) => tool.function?.name)).toEqual([
      "read",
      "bash",
    ]);
  });

  it("returns an absent body as it found it", () => {
    // `patchFetch` only calls this when `init.body !== undefined`, so
    // `undefined` never arrives in production; `null` does, from a caller that
    // spells "no body" explicitly. Neither may become an empty string.
    const headers = new Headers();
    expect(
      maybeInjectCoreTools(RESPONSES_URL, undefined, headers, options())
    ).toBe(undefined);
    expect(maybeInjectCoreTools(RESPONSES_URL, null, headers, options())).toBe(
      null
    );
    expect(headers.get("content-length")).toBeNull();
  });

  it("returns a body it cannot re-read as the very same object", () => {
    const binary = new TextEncoder().encode(
      JSON.stringify({ model: FREE_MODEL })
    );
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(binary);
        controller.close();
      },
    });
    const form = new FormData();
    form.append("model", FREE_MODEL);

    // All three are legal `fetch` bodies that are simply not JSON text. Reading
    // them would either throw or invent a body, so each must come back as the
    // identical object — reference equality is the whole contract here.
    //
    // The binary view is the sharp edge of that rule: it holds exactly the
    // JSON the rewrite wants, but `Buffer.isBuffer` says no, so it is skipped.
    // A Buffer is the one binary shape that IS re-read — see the next case.
    for (const body of [binary, stream, form]) {
      const headers = new Headers();
      expect(
        maybeInjectCoreTools(RESPONSES_URL, body, headers, options())
      ).toBe(body);
      expect(headers.get("content-length")).toBeNull();
    }
  });

  it("rewrites a Buffer body into the JSON text fetch can send", () => {
    const headers = new Headers();
    const body = Buffer.from(JSON.stringify({ model: FREE_MODEL }), "utf-8");

    // An adapter that pre-encodes its body hands over a Buffer, and this is the
    // one binary shape the module reads. It leaves as text, and the caller's
    // own bytes are left exactly as they were — a mutated buffer would show up
    // as a second, different body in whatever the caller keeps a reference to.
    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options());
    expect(Buffer.isBuffer(out)).toBe(false);
    expect(parseJsonBody(bodyText(out))).toEqual({
      model: FREE_MODEL,
      tools: [DUMMY_READ_TOOL, DUMMY_BASH_TOOL],
    });
    expect(body.toString("utf-8")).toBe(JSON.stringify({ model: FREE_MODEL }));
  });

  it("returns an empty body untouched", () => {
    const headers = new Headers();
    // There is no model to classify in an empty body, so there is nothing to
    // scope the rewrite by; the length check is what keeps it that way.
    expect(maybeInjectCoreTools(RESPONSES_URL, "", headers, options())).toBe(
      ""
    );
    expect(headers.get("content-length")).toBeNull();
  });

  it("returns a body that is not JSON untouched", () => {
    const garbage = "{not json at all";
    const truncated = '{"model":"muse-spark-1.3-contributor-free","tools":[';
    const headers = new Headers();

    // A stream that died mid-write reaches the interceptor as a half-written
    // body. Corrupting it further would turn a parse error into a sent request.
    expect(
      maybeInjectCoreTools(RESPONSES_URL, garbage, headers, options())
    ).toBe(garbage);
    expect(
      maybeInjectCoreTools(RESPONSES_URL, truncated, headers, options())
    ).toBe(truncated);
    expect(headers.get("content-length")).toBeNull();
  });

  it("returns a parsed body that is not an object untouched", () => {
    // Parsing successfully is not enough: the rewrite needs a property bag to
    // put `tools` on, and an array or a scalar has nowhere to put it.
    for (const raw of ["[1,2,3]", "42", "null", '"a bare JSON string"']) {
      const headers = new Headers();
      expect(maybeInjectCoreTools(RESPONSES_URL, raw, headers, options())).toBe(
        raw
      );
      expect(headers.get("content-length")).toBeNull();
    }
  });

  it("returns a body without a string model untouched", () => {
    const noModel = JSON.stringify({ input: "hi" });
    const numericModel = JSON.stringify({ input: "hi", model: 42 });
    const nullModel = JSON.stringify({ input: "hi", model: null });

    // The marker is matched against the body's own `model`. A body that does
    // not name one cannot be classified as free tier, and guessing would put
    // gateway-only schemas into an unrelated request.
    for (const raw of [noModel, numericModel, nullModel]) {
      const headers = new Headers();
      expect(maybeInjectCoreTools(RESPONSES_URL, raw, headers, options())).toBe(
        raw
      );
      expect(headers.get("content-length")).toBeNull();
    }
  });

  it("returns a body for a non-free model untouched", () => {
    const body = JSON.stringify({ input: "hi", model: "gpt-5.1" });
    const headers = new Headers();

    // The one rewrite that must never fire: a paid model accepts the body as
    // it stands, and advertising tools the caller never asked for changes what
    // the model may call on a metered request.
    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options());
    expect(out).toBe(body);
    expect(parseJsonBody(bodyText(out))).toEqual({
      input: "hi",
      model: "gpt-5.1",
    });
    expect(headers.get("content-length")).toBeNull();
  });
});

describe("maybeInjectCoreTools: injection", () => {
  it("injects both schemas and states the new length in bytes", () => {
    const headers = new Headers();
    const body = JSON.stringify({
      input: [{ content: "héllo wörld", role: "user" }],
      model: FREE_MODEL,
      stream: true,
    });

    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options());
    expect(typeof out).toBe("string");
    const rewritten = bodyText(out);

    expect(parseJsonBody(rewritten)).toEqual({
      input: [{ content: "héllo wörld", role: "user" }],
      model: FREE_MODEL,
      stream: true,
      tools: [DUMMY_READ_TOOL, DUMMY_BASH_TOOL],
    });
    expect(toolNamesOf(parseJsonBody(rewritten))).toEqual(["read", "bash"]);
    // `content-length` counts BYTES. A `.length` here under-reports every body
    // carrying non-ASCII text, and the response never finishes arriving.
    expect(headers.get("content-length")).toBe(
      String(Buffer.byteLength(rewritten))
    );
    expect(headers.get("content-length")).not.toBe(String(rewritten.length));
  });

  it("passes a body that already declares both tools through byte-identically", () => {
    const headers = new Headers();
    const tools = [DUMMY_READ_TOOL, DUMMY_BASH_TOOL];
    const body = JSON.stringify({ input: "hi", model: FREE_MODEL, tools });

    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options());

    // The gateway already sees both schemas, so the request leaves as it
    // arrived: the same bytes, the same structure, and the caller's own tool
    // array neither grown nor replaced.
    expect(out).toBe(body);
    expect(toolNamesOf(parseJsonBody(bodyText(out)))).toEqual(["read", "bash"]);
    expect(tools).toEqual([DUMMY_READ_TOOL, DUMMY_BASH_TOOL]);
    expect(tools).toHaveLength(2);
    // Nothing was injected, yet the length is still stated — which is the one
    // header a rewritten body and an untouched one must agree on.
    expect(headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  });

  it("appends only the missing schema when one tool is already declared", () => {
    const headers = new Headers();
    const declared = {
      description: "the caller's own bash",
      name: "bash",
      type: "function",
    };
    const body = JSON.stringify({ model: FREE_MODEL, tools: [declared] });

    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options());

    // A second `bash` would give the model two tools under one name and the
    // gateway rejects the request, so the declared entry is kept verbatim and
    // only `read` is appended.
    expect(parseJsonBody(bodyText(out))).toEqual({
      model: FREE_MODEL,
      tools: [declared, DUMMY_READ_TOOL],
    });
    expect(toolNamesOf(parseJsonBody(bodyText(out)))).toEqual(["bash", "read"]);
  });

  it("counts tools declared in the OpenAI function shape", () => {
    const headers = new Headers();
    const body = JSON.stringify({
      model: FREE_MODEL,
      tools: [
        { function: { name: "read" }, type: "function" },
        { function: { name: "bash" }, type: "function" },
      ],
    });

    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options());

    // Reading only the top-level `name` would append a second `read` and a
    // second `bash`. The pass-through is byte-identical, which is only
    // provable because the fixture is canonically serialized — a reformatted
    // body comes back re-serialized (JSON.parse then JSON.stringify) with
    // identical content.
    expect(out).toBe(body);
    expect(parseJsonBody(bodyText(out))).toEqual({
      model: FREE_MODEL,
      tools: [
        { function: { name: "read" }, type: "function" },
        { function: { name: "bash" }, type: "function" },
      ],
    });
  });

  it("emits the OpenAI dialect when any entry uses it", () => {
    const headers = new Headers();
    const responsesShaped = { name: "read", type: "function" };
    const openAiShaped = { function: { name: "web" }, type: "function" };
    const body = JSON.stringify({
      model: FREE_MODEL,
      tools: [responsesShaped, openAiShaped],
    });

    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options());

    // The dialect is inferred from the body's OWN tools, never from the URL:
    // one entry without a top-level `name` flips the whole body, so `bash`
    // arrives in the OpenAI form beside a Responses-shaped `read`. That
    // mixture is the caller's own doing — the module has to match the dialect
    // it finds, not the one the route name suggests.
    expect(parseJsonBody(bodyText(out))).toEqual({
      model: FREE_MODEL,
      tools: [responsesShaped, openAiShaped, DUMMY_BASH_TOOL_FUNCTION],
    });
  });

  it("emits both schemas in the OpenAI dialect when neither is declared", () => {
    const headers = new Headers();
    const openAiShaped = { function: { name: "web" }, type: "function" };
    const body = JSON.stringify({ model: FREE_MODEL, tools: [openAiShaped] });

    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options());

    // Nothing is declared, so both schemas are appended — and the dialect
    // still comes from the body's own tools rather than from the URL, so a
    // gateway that receives `/responses` with one OpenAI-shaped entry gets two
    // more entries it can actually parse.
    expect(parseJsonBody(bodyText(out))).toEqual({
      model: FREE_MODEL,
      tools: [openAiShaped, DUMMY_READ_TOOL_FUNCTION, DUMMY_BASH_TOOL_FUNCTION],
    });
  });

  it("replaces a tools value it cannot merge with", () => {
    // A `tools` value that is not an array cannot be merged with. Forwarding
    // it would leave the gateway rejecting the request for exactly the reason
    // this module exists, so a malformed value is replaced like an absent one.
    const bodies = [
      JSON.stringify({ model: FREE_MODEL, tools: "read" }),
      JSON.stringify({ model: FREE_MODEL, tools: null }),
      JSON.stringify({ model: FREE_MODEL, tools: { name: "read" } }),
    ];

    for (const raw of bodies) {
      const headers = new Headers();
      const out = maybeInjectCoreTools(RESPONSES_URL, raw, headers, options());
      expect(parseJsonBody(bodyText(out))).toEqual({
        model: FREE_MODEL,
        tools: [DUMMY_READ_TOOL, DUMMY_BASH_TOOL],
      });
      expect(headers.get("content-length")).toBe(
        String(Buffer.byteLength(bodyText(out)))
      );
    }
  });

  it("skips tool entries it cannot read instead of dropping them", () => {
    const headers = new Headers();
    const declaredRead = { name: "read" };
    const body = JSON.stringify({
      model: FREE_MODEL,
      tools: [null, "bash", 7, declaredRead],
    });

    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options());

    // Only an object with a name counts as declared, so the bare string
    // "bash" does not stop a `bash` from being added. Entries the module
    // cannot read are carried through untouched: silently dropping a caller's
    // tool changes what the model is allowed to call.
    expect(parseJsonBody(bodyText(out))).toEqual({
      model: FREE_MODEL,
      tools: [null, "bash", 7, declaredRead, DUMMY_BASH_TOOL],
    });
  });

  it("prefers the Anthropic schemas when the URL names /messages", () => {
    // Both path segments in one URL is not a route this plugin documents:
    // `RESPONSES_PATH` gates first, so a plain `/messages` URL never reaches
    // the injector. The case pins the precedence between the two dialects
    // (Anthropic wins over the OpenAI function form) and keeps the Anthropic
    // schemas from rotting untested.
    const url = "https://relay.internal/v1/messages?upstream=/responses";
    const headers = new Headers();
    const body = JSON.stringify({ model: FREE_MODEL });

    const out = maybeInjectCoreTools(url, body, headers, options());

    expect(parseJsonBody(bodyText(out))).toEqual({
      model: FREE_MODEL,
      tools: [DUMMY_READ_TOOL_ANTHROPIC, DUMMY_BASH_TOOL_ANTHROPIC],
    });
    // `input_schema`, not `parameters`: the two dialects are not
    // interchangeable, and mixing them is the failure the fallback avoids.
    expect(DUMMY_READ_TOOL_ANTHROPIC).toHaveProperty("input_schema");
    expect(DUMMY_READ_TOOL_FUNCTION).toHaveProperty("function");
  });
});

describe("maybeInjectCoreTools: marker scoping", () => {
  it("injects for every model under the all-models marker", () => {
    const headers = new Headers();
    const body = JSON.stringify({ input: "hi", model: "gpt-5.1" });

    // `*` is the documented escape hatch for when the free-tier rule widens to
    // paid models — the marker, not a capability flag, is what carries it.
    const out = maybeInjectCoreTools(
      RESPONSES_URL,
      body,
      headers,
      options(ALL_MODELS_MARKER)
    );
    expect(toolNamesOf(parseJsonBody(bodyText(out)))).toEqual(["read", "bash"]);
    expect(headers.get("content-length")).toBe(
      String(Buffer.byteLength(bodyText(out)))
    );
  });

  it("injects for nothing under an empty marker", () => {
    const body = JSON.stringify({ input: "hi", model: FREE_MODEL });
    const headers = new Headers();

    const out = maybeInjectCoreTools(RESPONSES_URL, body, headers, options(""));
    expect(out).toBe(body);
    expect(headers.get("content-length")).toBeNull();
  });

  it("injects only for the models carrying a custom marker", () => {
    const hit = JSON.stringify({ input: "hi", model: "acct-preview-9" });
    const miss = JSON.stringify({ input: "hi", model: "gpt-5.1" });

    // A relabelled free tier still has to be injectable: the marker is
    // user-configured precisely because the vendor renames ids.
    const injected = maybeInjectCoreTools(
      RESPONSES_URL,
      hit,
      new Headers(),
      options("preview")
    );
    expect(toolNamesOf(parseJsonBody(bodyText(injected)))).toEqual([
      "read",
      "bash",
    ]);
    expect(
      maybeInjectCoreTools(
        RESPONSES_URL,
        miss,
        new Headers(),
        options("preview")
      )
    ).toBe(miss);
  });

  it("still injects for a catalog free tier the custom marker does not name", () => {
    // A custom marker SCOPES which other models get the fallback; it does not
    // waive the requirement for models the catalog records as free. Leaving
    // them out is not a narrower policy, it is a broken model: the gateway
    // refuses a free-tier body without `read` and `bash` either way.
    const body = JSON.stringify({ input: "hi", model: "big-pickle" });
    const injected = maybeInjectCoreTools(
      RESPONSES_URL,
      body,
      new Headers(),
      options("preview")
    );
    expect(toolNamesOf(parseJsonBody(bodyText(injected)))).toEqual([
      "read",
      "bash",
    ]);
  });
});

/**
 * `maybeForceStreaming` — the free tier's `stream: true` requirement.
 *
 * Measured 2026-10-13: with an in-band session id, a non-empty `tools` array
 * and every identity header present, `stream: true` is served and the same
 * request without it is refused with `403 FreeTierError` — byte-identical to
 * every other free-tier refusal, which is why this reads from the outside as
 * "the headers did not work" rather than "one field was wrong".
 *
 * As with the tool fallback, most of these cases assert that the body is left
 * ALONE. The sole caller swaps the body whenever the returned reference
 * differs, so a rewrite that fires by accident is invisible until a turn
 * silently changes shape.
 */
describe("tool-fallback: the free tier's stream requirement", () => {
  const url = "https://opencode.ai/zen/v1/chat/completions";
  const sent = (model: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ messages: [], model, ...extra });

  it("sets stream on a free-tier body that omits it", () => {
    const headers = new Headers();
    const out = maybeForceStreaming(url, sent("mimo-v2.6-flash-free"), headers, {
      enabled: true,
      modelMarker: DEFAULT_FREE_MODEL_MARKER,
    });
    expect((JSON.parse(out as string) as { stream?: boolean }).stream).toBe(true);
  });

  it("sets stream when the caller explicitly sent false", () => {
    const headers = new Headers();
    const out = maybeForceStreaming(
      url,
      sent("space-bunny-free", { stream: false }),
      headers,
      { enabled: true, modelMarker: DEFAULT_FREE_MODEL_MARKER }
    );
    expect((JSON.parse(out as string) as { stream?: boolean }).stream).toBe(true);
  });

  it("leaves a body that already streams byte-identical", () => {
    const body = sent("space-bunny-free", { stream: true });
    expect(
      maybeForceStreaming(url, body, new Headers(), {
        enabled: true,
        modelMarker: DEFAULT_FREE_MODEL_MARKER,
      })
    ).toBe(body);
  });

  it("covers chat/completions and messages as well as responses", () => {
    // The gate is a property of the free tier, not of one API shape: all three
    // paths were refused identically before this rewrite existed.
    for (const path of ["/responses", "/chat/completions", "/messages"]) {
      const out = maybeForceStreaming(
        `https://opencode.ai/zen/v1${path}`,
        sent("cat-jam-free"),
        new Headers(),
        { enabled: true, modelMarker: DEFAULT_FREE_MODEL_MARKER }
      );
      expect((JSON.parse(out as string) as { stream?: boolean }).stream).toBe(
        true
      );
    }
  });

  it("leaves a paid model's body alone", () => {
    const body = sent("gpt-5.4");
    expect(
      maybeForceStreaming(url, body, new Headers(), {
        enabled: true,
        modelMarker: DEFAULT_FREE_MODEL_MARKER,
      })
    ).toBe(body);
  });

  it("leaves non-inference traffic and disabled injection alone", () => {
    const body = sent("space-bunny-free");
    expect(
      maybeForceStreaming(
        "https://opencode.ai/zen/v1/models",
        body,
        new Headers(),
        { enabled: true, modelMarker: DEFAULT_FREE_MODEL_MARKER }
      )
    ).toBe(body);
    expect(
      maybeForceStreaming(url, body, new Headers(), {
        enabled: false,
        modelMarker: DEFAULT_FREE_MODEL_MARKER,
      })
    ).toBe(body);
  });

  it("leaves unparsable and non-body input alone", () => {
    for (const bad of ["not json", "", undefined, null]) {
      expect(
        maybeForceStreaming(url, bad, new Headers(), {
          enabled: true,
          modelMarker: DEFAULT_FREE_MODEL_MARKER,
        })
      ).toBe(bad);
    }
  });

  it("keeps content-length tracking the rewritten body", () => {
    const headers = new Headers();
    const out = maybeForceStreaming(url, sent("space-bunny-free"), headers, {
      enabled: true,
      modelMarker: DEFAULT_FREE_MODEL_MARKER,
    });
    expect(headers.get("content-length")).toBe(
      Buffer.byteLength(out as string).toString()
    );
  });
});
