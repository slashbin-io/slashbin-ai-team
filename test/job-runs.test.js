/**
 * Job history in the company record (lib/job-runs.js): the signed write,
 * its never-throws contract, and the reader mapping.
 */
const http = require("http");
const crypto = require("crypto");
const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");
const jr = require("../lib/job-runs");

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); passed++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); failed++; }
}

const KEY = "test-signing-key";
const quiet = { warn() {} };

function server(status) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = status; res.end(); });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, base: `http://127.0.0.1:${srv.address().port}` })));
}
const envFor = (base) => ({ SLASHBIN_DATA_RECEIVER_BASE_URL: base, SLASHBIN_EVENTS_SIGNING_KEY__JOB_RUN: KEY });
const cronRec = { id: "daily-digest", cron: "0 9 * * 1", scheduledFor: "2026-11-25T09:00:00.000Z", firedAt: "2026-11-25T09:01:30.000Z", durationMs: 90000, success: true, channel: "123" };

(async () => {
  console.log("Job runs");

  await check("the write is signed over the raw body and carries the event id", async () => {
    const s = await server(202);
    const r = await jr.recordExecution(cronRec, { env: envFor(s.base), log: quiet });
    s.srv.close();
    assert.strictEqual(r.ok, true);
    const [req] = s.seen;
    assert.strictEqual(req.url, "/slashbin/job-run/events");
    assert.strictEqual(req.headers["content-type"], "application/json");
    assert.strictEqual(req.headers["x-slashbin-signature"], "sha256=" + crypto.createHmac("sha256", KEY).update(req.body).digest("hex"));
    assert.strictEqual(req.headers["x-slashbin-job-id"], "team-bot:daily-digest:2026-11-25T09:01:30.000Z:finished");
  });

  await check("the body has the receiver's shape", async () => {
    const s = await server(202);
    await jr.recordExecution({ ...cronRec, success: false, error: "boom" }, { env: envFor(s.base), log: quiet });
    s.srv.close();
    const b = JSON.parse(s.seen[0].body.toString());
    assert.deepStrictEqual(Object.keys(b).sort(), ["evidence", "finished_at", "job", "outcome", "provenance", "run_key", "scheduled_for", "scheduler", "started_at"]);
    assert.strictEqual(b.scheduler, "team-bot");
    assert.strictEqual(b.job, "daily-digest");
    assert.strictEqual(b.outcome, "failed");
    assert.ok(/^[A-Za-z0-9._:-]{1,200}$/.test(b.run_key), b.run_key);
    assert.strictEqual(b.run_key, "daily-digest:2026-11-25T09:01:30.000Z");
    assert.ok(b.provenance.host && b.provenance.producer);
    assert.deepStrictEqual(JSON.parse(b.evidence), { cron: "0 9 * * 1", durationMs: 90000, channel: "123", error: "boom" });
  });

  await check("a run key replaces characters outside the allowed set and stays within 200", () => {
    const k = jr.runKeyFor("a b/c#d", "2026-11-25T09:00:00.000Z");
    assert.ok(/^[A-Za-z0-9._:-]{1,200}$/.test(k) && k.startsWith("a_b_c_d:"));
    assert.strictEqual(jr.runKeyFor("x".repeat(500), "t").length, 200);
  });

  await check("a wake job's evidence carries runAt and attempt", () => {
    const e = jr.eventFromRecord({ id: "w1", runAt: "2026-11-25T10:00:00.000Z", attempt: 2, scheduledFor: "s", firedAt: "2026-11-25T10:00:01.000Z", durationMs: 5, success: true });
    assert.deepStrictEqual(JSON.parse(e.evidence), { runAt: "2026-11-25T10:00:00.000Z", attempt: 2, durationMs: 5 });
  });

  await check("evidence is trimmed to 2000 characters", () => {
    const e = jr.eventFromRecord({ ...cronRec, success: false, error: "x".repeat(5000) });
    assert.ok(e.evidence.length <= 2000, String(e.evidence.length));
    assert.ok(JSON.parse(e.evidence).error.length > 1000, "the error is shortened, not dropped");
  });

  await check("a 503 never throws and is reported", async () => {
    const s = await server(503);
    const lines = [];
    const r = await jr.recordExecution(cronRec, { env: envFor(s.base), log: { warn: (m) => lines.push(m) } });
    s.srv.close();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(lines.length, 1);
  });

  await check("a network error never throws", async () => {
    const r = await jr.recordExecution(cronRec, { env: envFor("http://127.0.0.1:1"), log: quiet });
    assert.strictEqual(r.ok, false);
    const t = await jr.recordExecution(cronRec, { env: envFor("http://x"), log: quiet, fetchImpl: () => { throw new Error("sync boom"); } });
    assert.strictEqual(t.ok, false);
  });

  await check("a throwing logger still never throws", async () => {
    const r = await jr.recordExecution(cronRec, { env: envFor("http://127.0.0.1:1"), log: { warn() { throw new Error("log"); } } });
    assert.strictEqual(r.ok, false);
  });

  await check("without the env vars it skips and logs once", async () => {
    const lines = [];
    const log = { warn: (m) => lines.push(m) };
    const r1 = await jr.recordExecution(cronRec, { env: {}, log });
    await jr.recordExecution(cronRec, { env: {}, log });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes("SLASHBIN_DATA_RECEIVER_BASE_URL is not set"));
  });

  const rows = [
    { job: "a", scheduled_for: "2026-11-25T09:00:00.000Z", started_at: "2026-11-25T09:00:00.000Z", finished_at: "2026-11-25T09:01:30.000Z", outcome: "ok", evidence: JSON.stringify({ cron: "0 9 * * 1", durationMs: 90000, channel: "123" }) },
    { job: "b", scheduled_for: null, started_at: "2026-11-24T09:00:00.000Z", finished_at: "2026-11-24T09:00:02.000Z", outcome: "failed", evidence: "not json" },
  ];

  await check("listRuns maps rows back to the old record shape", async () => {
    let seenUrl, seenAuth;
    const fetchImpl = async (u, o) => { seenUrl = u; seenAuth = o.headers.authorization; return { status: 200, json: async () => ({ runs: rows }) }; };
    const out = await jr.listRuns({ limit: 9999, env: { SLASHBIN_DATA_RECEIVER_BASE_URL: "http://h/", COMPANY_RECORD_READ_TOKEN: "tok" }, fetchImpl });
    assert.ok(seenUrl.startsWith("http://h/company-record/job-runs/team-bot?") && seenUrl.includes("limit=500"), seenUrl);
    assert.strictEqual(seenAuth, "Bearer tok");
    assert.deepStrictEqual(out[0], { id: "a", cron: "0 9 * * 1", durationMs: 90000, channel: "123", scheduledFor: "2026-11-25T09:00:00.000Z", firedAt: "2026-11-25T09:01:30.000Z", success: true });
    assert.strictEqual(out[1].success, false);
    assert.strictEqual(out[1].id, "b");
  });

  await check("the skill-pack reader maps the same way and names the missing variable", async () => {
    const m = await import(join(__dirname, "../skill-pack/bin/job-runs-read.mjs"));
    assert.deepStrictEqual(m.rowToRecord(rows[0]), jr.rowToRecord(rows[0]));
    await assert.rejects(m.listRuns({ env: { SLASHBIN_DATA_RECEIVER_BASE_URL: "http://h" } }), /job history unavailable: COMPANY_RECORD_READ_TOKEN is not set/);
    await assert.rejects(jr.listRuns({ env: {} }), /job history unavailable: SLASHBIN_DATA_RECEIVER_BASE_URL is not set/);
  });

  await check("the bot keeps no local job-history file", () => {
    const bot = readFileSync(join(__dirname, "../bot.js"), "utf8");
    assert.ok(!bot.includes("JOB_HISTORY_FILE"));
    assert.ok(bot.includes("jobRuns.recordExecution("));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
