/**
 * The summarizer child is an agent child: it must never receive the harness's
 * company-record signing key or read token (PR #181 review, S1).
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync, readFileSync, chmodSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

test("summarize() launches its child without the company-record credentials", async () => {
  const { summarize } = require("../lib/summarize-core");
  const { KEY_VAR, READ_VAR } = require("../lib/job-runs");
  const dir = mkdtempSync(join(tmpdir(), "summ-env-"));
  const bin = join(dir, "fake-claude");
  const dump = join(dir, "env.txt");
  writeFileSync(bin, `#!/bin/sh\nenv > "${dump}"\necho '{"type":"result","result":"ok"}'\n`);
  chmodSync(bin, 0o755);
  const env = { PATH: process.env.PATH, [KEY_VAR]: "sign-secret", [READ_VAR]: "read-secret", KEEP_ME: "1" };
  await summarize({ transcript: "a: hi", kind: "channel-day", channelName: "c", date: "2026-11-25",
    claudeBin: bin, cwd: dir, timeoutMs: 10000, permissionArgs: [], env }).catch(() => {});
  const seen = readFileSync(dump, "utf8");
  assert.ok(seen.includes("KEEP_ME=1"), "the child ran with the given env");
  assert.ok(!seen.includes(`${KEY_VAR}=`), "signing key reached the child");
  assert.ok(!seen.includes(`${READ_VAR}=`), "read token reached the child");
});
