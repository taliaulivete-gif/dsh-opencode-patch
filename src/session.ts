/**
 * Deterministic OpenCode session identity.
 *
 * The gateway rejects requests without a valid OpenCode session id, and it must
 * stay stable for a DSH session or every turn looks like a new conversation to
 * the prompt cache. Everything here is a pure derivation from the DSH session
 * id and, when the Host knows it, the session's creation time — no table, no
 * randomness, no state to lose on restart.
 *
 * @module dsh-opencode-patch/session
 */

import { createHash } from "node:crypto";

import { OPENCODE_USER_AGENT } from "./identity.ts";

/** Header carrying the derived OpenCode session id. */
export const SESSION_HEADER = "x-opencode-session";

/** Generic proxy session affinity header used by gateways and connection pools. */
export const SESSION_AFFINITY_HEADER = "x-session-affinity";

/** Header carrying the derived OpenCode parent session id for subagents. */
export const PARENT_SESSION_HEADER = "x-opencode-parent-session-id";

/** Generic parent session header used by third-party proxies. */
export const PARENT_SESSION_ALT_HEADER = "x-parent-session-id";

/** Canonical OpenCode CLI User-Agent the DSH LLM adapter strips. */
export const OPENCODE_UA = OPENCODE_USER_AGENT;

/**
 * The vendor's own base62 alphabet, character for character (`randomBase62` in
 * `packages/opencode/src/id/id.ts`): digits, then uppercase, then lowercase.
 * The ORDER does not matter for validity, only the set does — matching theirs
 * keeps our suffix indistinguishable from one they minted.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Characters of the id that carry a TIMESTAMP: six bytes of
 * `milliseconds * 0x1000 + counter`, hex-encoded.
 */
const TIME_HEX_LENGTH = 12;

/** Characters the vendor fills with `randomBase62`. */
const RANDOM_LENGTH = 14;

/**
 * The vendor keeps the time in six bytes, so the stored field is 48 bits wide
 * and anything wider was truncated by their writer.
 */
const TIME_BITS = 48;

/**
 * Counter band the gateway accepts, 1..63 inclusive.
 *
 * The counter occupies the low twelve bits of the pre-inversion value, so after
 * inversion the low twelve bits are `0xFFF - counter`. Measured 2026-10-13
 * against `mimo-v2.6-flash-free`: a counter of 1 lands the id's hex on
 * `...ffe` and the request is served; a counter drawn from a full byte (0..255)
 * lands outside the band and is refused, with a 403 body byte-identical to
 * every other refusal. That identity is why a header that is present,
 * correctly spelled and correctly stable can still be worthless.
 */
const COUNTER_MAX = 63;

/** Twelve bits, all ones: the value `~` yields before the counter is taken off. */
const LOW_TWELVE_ALL_ONES = 4095;

/**
 * Complement `value` and keep only the vendor's 48-bit field.
 *
 * This is `~value & TIME_MASK`, written as arithmetic and `BigInt.asUintN`
 * because the repo's lint bans the bitwise operators outright. Nothing is lost:
 * `~x` is exactly `-x - 1`, and `asUintN` is a function rather than an operator.
 *
 * The inversion is not a detail. It is the whole difference between an id the
 * gateway serves and one it refuses, so it stays written out in the code rather
 * than folded into a mask someone might later "simplify" away.
 *
 * @param value - the pre-inversion field.
 * @returns the complemented value, truncated to 48 bits.
 */
const inverted48 = (value: bigint): bigint =>
  BigInt.asUintN(TIME_BITS, -value - 1n);

/**
 * Derive a valid OpenCode session ID: `ses_` + 12 hex + 14 base62.
 *
 * The shape is read off the vendor's own generator rather than inferred
 * (`packages/opencode/src/id/id.ts`):
 *
 * ```ts
 * let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)
 * return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
 * ```
 *
 * **Those twelve characters are a timestamp, and the vendor reads them back.**
 * Their `timestamp(id)` divides the hex by `0x1000` to recover milliseconds, so
 * filling them with hash bytes hands them a random creation instant — often in
 * the future — and a non-hex alphabet makes that parser throw. When the Host
 * tells us the session's creation time, that is what goes in.
 *
 * Everything else is derived from the DSH session id, so the value is stable:
 * the same conversation presents the same id on every turn, in every process,
 * and after a restart, which is what session affinity needs. The 12-bit counter
 * only disambiguates ids minted within one millisecond, so it comes from the
 * hash — deterministic and free.
 *
 * With no creation time the timestamp is the one thing this function cannot
 * supply honestly. It then falls back to hash bits, which is the degraded case:
 * the id is still valid and still stable, but its embedded time is not a time.
 *
 * @param sessionId - DSH session identifier (stringified before hashing, so
 * numeric ids match their string form).
 * @param createdAt - the session's creation time in milliseconds, when known.
 */
export const openCodeSessionIdFor = (
  sessionId: string | number,
  createdAt?: number
): string => {
const hash = createHash("sha256").update(String(sessionId)).digest();

  // Kept inside 1..63 so the inverted low twelve bits land in the band the
  // gateway reads. Still hash-derived, so it stays stable per conversation.
  const counter = ((hash[0] ?? 0) % COUNTER_MAX) + 1;

  // With no creation time the timestamp is the one thing this function cannot
  // supply honestly, so it stays hash-derived — which is safe precisely because
  // the gate checks the counter band rather than the age of the timestamp.
  const milliseconds =
    createdAt !== undefined && Number.isSafeInteger(createdAt) && createdAt >= 0
      ? BigInt(createdAt)
      : BigInt(`0x${hash.subarray(0, 6).toString("hex")}`);

  const time = inverted48(milliseconds * 4096n + BigInt(counter));

  let random = "";
  for (let i = 6; i < 20; i += 1) {
    const byte = hash[i];
    if (byte !== undefined) {
      random += BASE62[byte % BASE62.length] ?? "0";
    }
  }

  return `ses_${time.toString(16).padStart(TIME_HEX_LENGTH, "0")}${random.slice(0, RANDOM_LENGTH)}`;
};

/**
 * Whether a `ses_…` value carries a counter the gateway will accept.
 *
 * @param id - a full session id, with or without the `ses_` prefix.
 */
export const counterFor = (id: string): number | undefined => {
  const hex = id.startsWith("ses_") ? id.slice(4, 16) : id.slice(0, 12);
  if (!/^[0-9a-f]{12}$/iu.test(hex)) return undefined;
  return LOW_TWELVE_ALL_ONES - Number.parseInt(hex.slice(9, 12), 16);
};

export const hasPlausibleCounter = (id: string): boolean => {
  const counter = counterFor(id);
  return counter !== undefined && counter <= COUNTER_MAX;
};

/**
 * Session id for a streamed turn, or `undefined` when there is none to carry.
 *
 * Always derives: raw DSH UUIDs satisfy no gateway, while derived `ses_…`
 * values route stably everywhere a UUID would.
 *
 * @param sessionId - the DSH session id carried by the turn.
 * @param createdAt - that session's creation time in milliseconds, when the
 * Host's session service can supply it.
 */
export const headerValueFor = (
  sessionId: string | number | undefined | null,
  createdAt?: number
): string | undefined => {
  if (sessionId === undefined || sessionId === null) {
    return undefined;
  }
  const raw = String(sessionId);
  if (raw.length === 0) {
    return undefined;
  }
  return openCodeSessionIdFor(raw, createdAt);
};

/**
 * Fallback session id for requests issued outside any tracked turn.
 *
 * Prefers the configured environment variable (headless runs pin one id per
 * process) and otherwise derives a stable id for the reserved `"default"`
 * conversation.
 *
 * @param envName - environment variable consulted first; defaults to
 * `OPENCODE_SESSION_ID` when blank.
 */
/**
 * Whether a string is a session id the gateway will accept.
 *
 * The shape is `ses_` + 12 hex + 14 base62, which is what {@link
 * openCodeSessionIdFor} derives and what the client's own ids look like.
 *
 * This exists because a prefix is not a format. A configuration that pins
 * `x-opencode-session: ses_dsh_default` starts with `ses_` and is not a session
 * id at all — the gateway answers it `401 Invalid API key`, which reads as a
 * credential fault and is really a malformed header. Anything that cannot be
 * accepted is better replaced with a derived id than sent as written.
 *
 * @param value - the candidate.
 * @returns whether it is a session id the gateway accepts.
 */
export const isOpenCodeSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(value);

export const fallbackSessionId = (envName?: string): string => {
  const name =
    envName !== undefined && envName.length > 0 ? envName : undefined;
  if (name !== undefined) {
    const envId: unknown = process.env[name];
    // Validated for the same reason a pinned header is: an id the gateway
    // rejects earns a 401 that reads like a credential fault, and a derived id
    // is strictly better than one that cannot be accepted.
    if (isOpenCodeSessionId(envId)) {
      return envId;
    }
  }
  return openCodeSessionIdFor("default");
};
