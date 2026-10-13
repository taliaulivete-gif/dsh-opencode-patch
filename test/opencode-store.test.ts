/**
 * The reader, against databases this test builds rather than one that exists.
 *
 * Every case makes its own SQLite file with the schema the installation uses, so
 * the queries are exercised for real — `node:sqlite` is the same driver the plugin
 * uses — without depending on a machine that has OpenCode installed.
 *
 * The values here are fixtures. They are shaped like secrets because the reader's
 * job is to carry them, and they are not secrets because nothing in this repository
 * ever holds a real one.
 *
 * @module dsh-opencode-patch/opencode-store.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  readOpencodeAccount,
  readOpencodeCredentials,
} from "../src/opencode-store.ts";

const temporary: string[] = [];

/** A database at a fresh path, built by `create`. */
const database = (create: (db: DatabaseSync) => void): string => {
  const directory = mkdtempSync(nodePath.join(os.tmpdir(), "opencode-store-"));
  temporary.push(directory);
  const path = nodePath.join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  create(db);
  db.close();
  return path;
};

/** The schema, as the installation ships it, trimmed to the columns read. */
const schema = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE credential (
      id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT,
      connector_id TEXT, method_id TEXT, active INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE account (
      id TEXT PRIMARY KEY, email TEXT, url TEXT, access_token TEXT,
      refresh_token TEXT, token_expiry INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE account_state (
      id TEXT PRIMARY KEY, active_account_id TEXT, active_org_id TEXT
    );
  `);
};

const addCredential = (
  db: DatabaseSync,
  id: string,
  integrationId: string,
  value: string,
  active: number,
  label?: string
): void => {
  db.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
  ).run(id, integrationId, label ?? integrationId, value, active);
};

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("opencode-store: credentials", () => {
  it("returns the active rows, keyed by integration", () => {
    const path = database((db) => {
      schema(db);
      addCredential(db, "a", "opencode", "oc_sk_fixture_zen", 1, "Zen");
      addCredential(db, "b", "opencode-go", "sk-fixture-go", 1, "Go");
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(2);
    const integrations = found?.map((entry) => entry.integrationId) ?? [];
    expect(integrations).toHaveLength(2);
    expect(integrations).toEqual(
      expect.arrayContaining(["opencode", "opencode-go"])
    );
    expect(
      found?.find((entry) => entry.integrationId === "opencode")?.label
    ).toBe("Zen");
  });

  it("reads legacy rows that carry no active flag at all", () => {
    // Measured on a real installation: every row has `active IS NULL`, written
    // before the flag existed. Filtering on `active = 1` alone answered nothing
    // there, which is the difference between this reader working and not.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run("legacy", "opencode", "Zen", "oc_sk_fixture_legacy", 100);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_legacy");
  });

  it("prefers an explicit active flag over legacy rows", () => {
    // Legacy rows are the fallback, not an addition: once any row sets the flag,
    // that is the user's selection and the unflagged rows are the old ones.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run("legacy", "opencode", "Old", "oc_sk_fixture_legacy", 100);
      addCredential(db, "new", "opencode", "oc_sk_fixture_new", 1);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_new");
  });

  it("extracts the key from the JSON every real row carries", () => {
    // Measured against a live installation: EVERY value is a JSON document, not a
    // bare key. Returning the document puts JSON in the Bearer header, and the
    // gateway answers `Invalid credential` - or, on the free tier, a refusal that
    // reads as though the model were unusable. That is the wrong conclusion to
    // draw, and this is the reader that caused it.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run(
        "a",
        "opencode",
        "Zen",
        JSON.stringify({ type: "apiKey", key: "oc_sk_fixture_zen" }),
        100
      );
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_zen");
  });

  it("carries an OAuth grant's access token rather than the whole grant", () => {
    // `xai` is shaped differently - { type, methodID, refresh, access, expires } -
    // so the reader claims only the two fields OpenCode itself declares.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run(
        "x",
        "xai",
        "xAI",
        JSON.stringify({
          type: "oauth",
          methodID: "token",
          refresh: "fixture-refresh",
          access: "fixture-access",
          expires: 1_700_000_000_000,
        }),
        100
      );
    });
    expect(readOpencodeCredentials(path)?.[0]?.value).toBe("fixture-access");
  });

  it("drops a row whose value shape it does not claim", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active, time_updated) VALUES (?, ?, ?, ?, NULL, ?)"
      ).run(
        "u",
        "mystery",
        "?",
        JSON.stringify({ type: "whatever", token: "nope" }),
        100
      );
    });
    expect(readOpencodeCredentials(path)).toBeUndefined();
  });

  it("leaves an inactive credential behind", () => {
    // A retired key is one the user already replaced; offering it would resurrect
    // the thing they retired.
    const path = database((db) => {
      schema(db);
      addCredential(db, "old", "opencode", "oc_sk_fixture_old", 0);
      addCredential(db, "new", "opencode", "oc_sk_fixture_new", 1);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_new");
  });

  it("skips a row with no integration or no value rather than inventing one", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
      ).run("c", "", "", "orphan", 1);
      addCredential(db, "d", "opencode", "oc_sk_fixture_ok", 1);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_ok");
  });

  it("answers undefined for an installation with none", () => {
    const path = database(schema);
    expect(readOpencodeCredentials(path)).toBeUndefined();
  });
});

describe("opencode-store: the account", () => {
  it("returns the stored login", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, access_token, refresh_token, token_expiry) VALUES (?, ?, ?, ?, ?)"
      ).run("acct", "you@example.com", "fixture-access", "fixture-refresh", 1);
    });
    expect(readOpencodeAccount(path)).toEqual({
      accessToken: "fixture-access",
      email: "you@example.com",
      // The table exists and is empty, which is the ordinary case: no org known.
      orgId: undefined,
      refreshToken: "fixture-refresh",
    });
  });

  it("carries the active org, which lives in its own table", () => {
    // The request has to send an org, and a token with the wrong one is worse than
    // no token - so this is read from account_state rather than assumed. Measured
    // against the real schema: account holds the token, account_state holds which
    // org is active.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, access_token) VALUES (?, ?, ?)"
      ).run("acct", "you@example.com", "fixture-access");
      db.prepare(
        "INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)"
      ).run("state", "acct", "org_fixture");
    });
    expect(readOpencodeAccount(path)?.orgId).toBe("org_fixture");
  });

  it("reads the ACTIVE account, not merely the first row", () => {
    // The state table names which account is in use, and a token from one the
    // user has switched away from is not the login they hold.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, access_token, time_created) VALUES (?, ?, ?, ?)"
      ).run("first", "first@example.com", "fixture-first", 1);
      db.prepare(
        "INSERT INTO account (id, email, access_token, time_created) VALUES (?, ?, ?, ?)"
      ).run("second", "second@example.com", "fixture-second", 2);
      db.prepare(
        "INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)"
      ).run("state", "second", "org_second");
    });
    expect(readOpencodeAccount(path)).toEqual({
      accessToken: "fixture-second",
      email: "second@example.com",
      orgId: "org_second",
      refreshToken: undefined,
    });
  });

  it("never attaches an org to an account it does not belong to", () => {
    // The failure this reads around: an org taken from the state row and paired
    // with whichever account happened to be first. A token carrying another
    // credential's org is worse than a token carrying none, so a state row that
    // names nobody leaves the org unset.
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, access_token) VALUES (?, ?, ?)"
      ).run("acct", "you@example.com", "fixture-access");
      db.prepare(
        "INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)"
      ).run("state", "someone-else", "org_fixture");
    });
    expect(readOpencodeAccount(path)).toEqual({
      accessToken: "fixture-access",
      email: "you@example.com",
      orgId: undefined,
      refreshToken: undefined,
    });
  });

  it("treats a row with no access token as no login", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, access_token, refresh_token) VALUES (?, ?, ?, ?)"
      ).run("acct", "you@example.com", "", "");
    });
    expect(readOpencodeAccount(path)).toBeUndefined();
  });

  it("carries a missing refresh token rather than dropping the login", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, access_token) VALUES (?, ?, ?)"
      ).run("acct", "you@example.com", "fixture-access");
    });
    expect(readOpencodeAccount(path)).toEqual({
      accessToken: "fixture-access",
      email: "you@example.com",
      orgId: undefined,
      refreshToken: undefined,
    });
  });
});

describe("opencode-store: nothing throws", () => {
  it("answers undefined when the file is not there", () => {
    // The ordinary case on a machine without OpenCode: not an error, and not
    // something a user should ever see a message about.
    const missing = nodePath.join(
      os.tmpdir(),
      "opencode-store-absent",
      "opencode.db"
    );
    expect(readOpencodeCredentials(missing)).toBeUndefined();
    expect(readOpencodeAccount(missing)).toBeUndefined();
  });

  it("answers undefined for a file that is not a database", () => {
    const directory = mkdtempSync(
      nodePath.join(os.tmpdir(), "opencode-store-")
    );
    temporary.push(directory);
    const path = nodePath.join(directory, "opencode.db");
    writeFileSync(path, "not a database at all");
    expect(readOpencodeCredentials(path)).toBeUndefined();
    expect(readOpencodeAccount(path)).toBeUndefined();
  });

  it("answers undefined for a database from another version", () => {
    const path = database((db) => {
      db.exec("CREATE TABLE something_else (id TEXT PRIMARY KEY)");
    });
    expect(readOpencodeCredentials(path)).toBeUndefined();
    expect(readOpencodeAccount(path)).toBeUndefined();
  });

  it("answers undefined for :memory:, which is not a path to open", () => {
    expect(readOpencodeCredentials(":memory:")).toBeUndefined();
    expect(readOpencodeAccount(":memory:")).toBeUndefined();
  });
});
