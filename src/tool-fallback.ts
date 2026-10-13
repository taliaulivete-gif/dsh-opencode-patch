/**
 * Free-tier core-tool schema fallback.
 *
 * The OpenCode Zen gateway rejects free-tier `/responses` bodies that lack
 * `read` and `bash` in `tools`, while DSH deliberately does not send them.
 * When the request model is marked free-tier, this module rewrites the body
 * to carry both schemas — and only when they are actually missing, so a body
 * that already declares them passes through byte-identical.
 *
 * @module dsh-opencode-patch/tool-fallback
 */

import { ALL_MODELS_MARKER } from "./config-values.ts";
import { isRecord, isUnknownArray } from "./guards.ts";

/** Path segment that marks a Responses-API body worth inspecting. */
export const RESPONSES_PATH = "/responses";

/** Placeholder `read` schema formatted for Anthropic-compatible /messages. */
export const DUMMY_READ_TOOL_ANTHROPIC = {
  description: "Read a file or directory from the local filesystem.",
  input_schema: {
    properties: {
      filePath: {
        description: "The absolute path to the file",
        type: "string",
      },
    },
    required: ["filePath"],
    type: "object",
  },
  name: "read",
} as const;

/** Placeholder `bash` schema formatted for Anthropic-compatible /messages. */
export const DUMMY_BASH_TOOL_ANTHROPIC = {
  description: "Execute a bash command.",
  input_schema: {
    properties: {
      command: { description: "The command to execute", type: "string" },
    },
    required: ["command"],
    type: "object",
  },
  name: "bash",
} as const;

/** Placeholder `read` schema the gateway's validator accepts. */
export const DUMMY_READ_TOOL = {
  description: "Read a file or directory from the local filesystem.",
  name: "read",
  parameters: {
    properties: {
      filePath: {
        description: "The absolute path to the file",
        type: "string",
      },
    },
    required: ["filePath"],
    type: "object",
  },
  type: "function",
} as const;

/** Placeholder `bash` schema the gateway's validator accepts. */
export const DUMMY_BASH_TOOL = {
  description: "Execute a bash command.",
  name: "bash",
  parameters: {
    properties: {
      command: { description: "The command to execute", type: "string" },
    },
    required: ["command"],
    type: "object",
  },
  type: "function",
} as const;

/** Placeholder `read` schema formatted for OpenAI-compatible /chat/completions. */
export const DUMMY_READ_TOOL_FUNCTION = {
  type: "function",
  function: {
    description: "Read a file or directory from the local filesystem.",
    name: "read",
    parameters: {
      properties: {
        filePath: {
          description: "The absolute path to the file",
          type: "string",
        },
      },
      required: ["filePath"],
      type: "object",
    },
  },
} as const;

/** Placeholder `bash` schema formatted for OpenAI-compatible /chat/completions. */
export const DUMMY_BASH_TOOL_FUNCTION = {
  type: "function",
  function: {
    description: "Execute a bash command.",
    name: "bash",
    parameters: {
      properties: {
        command: { description: "The command to execute", type: "string" },
      },
      required: ["command"],
      type: "object",
    },
  },
} as const;

export const toolNames = (
  tools: unknown[]
): { hasBash: boolean; hasRead: boolean; isOpenAiFormat: boolean } => {
  let hasBash = false;
  let hasRead = false;
  let isOpenAiFormat = false;
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    let toolName: unknown = tool.name;
    if (typeof toolName !== "string" && isRecord(tool.function)) {
      toolName = tool.function.name;
      isOpenAiFormat = true;
    }
    if (toolName === "read") {
      hasRead = true;
    }
    if (toolName === "bash") {
      hasBash = true;
    }
  }
  return { hasBash, hasRead, isOpenAiFormat };
};

/** Whether `modelId` is in scope for the core-tool fallback. */
export const isCoreToolModel = (modelId: string, marker: string): boolean => {
  if (marker === ALL_MODELS_MARKER) {
    return true;
  }
  if (marker.length === 0) {
    return false;
  }
  return modelId.includes(marker);
};

/**
 * Path segments that mark an inference body worth inspecting for `stream`.
 *
 * Wider than {@link RESPONSES_PATH}: the streaming requirement is a property of
 * the free tier's inference gate, not of one API shape. `/chat/completions` and
 * `/messages` are refused identically when `stream` is absent.
 */
const INFERENCE_PATHS = ["/responses", "/chat/completions", "/messages"];

/**
 * Force `stream: true` on a free-tier inference body.
 *
 * Measured 2026-10-13: with an in-band session id, a non-empty `tools` array and
 * every identity header present, a request carrying `stream: true` is served
 * and the same request with `stream` absent or false is refused with
 * `403 FreeTierError` — the same refusal body as every other gate, so it reads
 * as "the headers did not work" rather than "one field was wrong".
 *
 * Seven header combinations (full CLI User-Agent vs bare `opencode/1.19.0`,
 * `x-opencode-client: cli` vs `desktop`) were all served with `stream: true` and
 * all refused without it, so this is the discriminating variable, not the
 * User-Agent.
 *
 * Scoped exactly like the core-tool fallback: free-tier models only, and a body
 * that already says `stream: true` passes through byte-identical.
 *
 * @param url - request URL.
 * @param body - the outgoing request body.
 * @param headers - mutable header bag whose `content-length` must track a rewrite.
 * @param options - whether injection is enabled and which model marker scopes it.
 * @returns the (possibly rewritten) body; the original reference when untouched.
 */
export const maybeForceStreaming = (
  url: string,
  body: RequestInit["body"],
  headers: Headers,
  options: { enabled: boolean; modelMarker: string }
): RequestInit["body"] => {
  if (!options.enabled) {
    return body;
  }
  if (!INFERENCE_PATHS.some((path) => url.includes(path))) {
    return body;
  }
  let bodyStr: string | undefined;
  if (typeof body === "string") {
    bodyStr = body;
  } else if (Buffer.isBuffer(body)) {
    bodyStr = body.toString("utf-8");
  } else {
    return body;
  }
  if (bodyStr.length === 0) {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) {
    return body;
  }
  const modelProp: unknown = parsed.model;
  if (typeof modelProp !== "string" || !isCoreToolModel(modelProp, options.modelMarker)) {
    return body;
  }
  if (parsed.stream === true) {
    return body;
  }
  parsed.stream = true;
  const newBodyStr = JSON.stringify(parsed);
  headers.set("content-length", Buffer.byteLength(newBodyStr).toString());
  return newBodyStr;
};

/**
 * Inject `read` + `bash` schemas into a free-tier completions body.
 *
 * @param url - request URL (supports `/responses` and `/chat/completions`).
 * @param body - the outgoing request body.
 * @param headers - the mutable header bag whose `content-length` must track a
 * rewritten body.
 * @param options - whether injection is enabled and which model marker scopes it.
 * @returns the (possibly rewritten) body; the original reference when untouched.
 */
export const maybeInjectCoreTools = (
  url: string,
  body: RequestInit["body"],
  headers: Headers,
  options: { enabled: boolean; modelMarker: string }
): RequestInit["body"] => {
  if (!options.enabled) {
    return body;
  }
  // Measured 2026-10-13: the core-tool requirement is not specific to
  // `/responses`. On `/chat/completions` the gateway refuses a free-tier body
  // that lacks `read` and `bash` exactly as it does on `/responses` — and a
  // model like `space-bunny-free` rejects `/responses` outright with
  // `ModelProtocolUnsupported`, so the chat path is the ONLY path it can be
  // reached on. Scoping this to `/responses` left those models with no schemas
  // at all, which is the same silent 403 as having the wrong session id.
  if (!INFERENCE_PATHS.some((path) => url.includes(path))) {
    return body;
  }
  if (body === undefined || body === null) {
    return body;
  }
  let bodyStr: string | undefined;
  if (typeof body === "string") {
    bodyStr = body;
  } else if (Buffer.isBuffer(body)) {
    bodyStr = body.toString("utf-8");
  } else {
    return body;
  }
  if (bodyStr.length === 0) {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) {
    return body;
  }
  const modelProp: unknown = parsed.model;
  if (typeof modelProp !== "string") {
    return body;
  }
  if (!isCoreToolModel(modelProp, options.modelMarker)) {
    return body;
  }
  const toolsProp: unknown = parsed.tools;
  let tools: unknown[];
  if (toolsProp === undefined) {
    tools = [];
  } else if (isUnknownArray(toolsProp)) {
    tools = [...toolsProp];
  } else {
    // A malformed `tools` value cannot be merged with — replace it, the same
    // as an absent one, so the request leaves with schemas the gateway accepts.
    tools = [];
  }
  const { hasBash, hasRead, isOpenAiFormat } = toolNames(tools);
  const isAnthropic = url.includes("/messages");
  const useOpenAi =
    isOpenAiFormat ||
    url.includes("/chat/completions") ||
    url.includes("/completions");

  const getReadTool = () => {
    if (isAnthropic) {
      return DUMMY_READ_TOOL_ANTHROPIC;
    }
    if (useOpenAi) {
      return DUMMY_READ_TOOL_FUNCTION;
    }
    return DUMMY_READ_TOOL;
  };
  const getBashTool = () => {
    if (isAnthropic) {
      return DUMMY_BASH_TOOL_ANTHROPIC;
    }
    if (useOpenAi) {
      return DUMMY_BASH_TOOL_FUNCTION;
    }
    return DUMMY_BASH_TOOL;
  };

  if (!hasRead) {
    tools.push(getReadTool());
  }
  if (!hasBash) {
    tools.push(getBashTool());
  }
  parsed.tools = tools;
  const newBodyStr = JSON.stringify(parsed);
  headers.set("content-length", Buffer.byteLength(newBodyStr).toString());
  return newBodyStr;
};
