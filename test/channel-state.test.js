/**
 * The summarizer's seen channels and checkpoints live in the company record
 * (lib/channel-state.js over lib/keyed-doc.js). Everything runs against a
 * loopback stand-in for the record and a temporary folder.
 */
const { mkdtempSync, writeFileSync, rmSync } = require("fs");
const { join } = require("path");
const os = require("os");
const assert = require("assert");
const { startReceiver } = require("./fake-receiver");
const { ScheduleStore } = require("../lib/schedule-store");
const { createChannelState, newer } = require("../lib/channel-state");
const { docKey } = require("../lib/keyed-doc");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed++; } catch (err) { console.log(`  FAIL ${name}\n       ${err.message}`); failed++; }
}
const quiet = { warn() {}, info() {} };

(async () => {
  console.log("\nChannel state — the record, not a local file");
  const rec = await startReceiver();
  const dir = mkdtempSync(join(os.tmpdir(), "cs-"));
  const mk = (env, extra = {}) => createChannelState({ bot: "b", log: quiet, store: new ScheduleStore({ env, bot: "b", log: quiet, timeoutMs: 800 }), ...extra });
  const make = (extra) => mk(rec.env, extra);
  const downEnv = () => ({ ...rec.env, COMPANY_RECORD_BASE_URL: "http://127.0.0.1:1" });

  await check("keys are per bot and name", () => {
    assert.strictEqual(docKey("b", "checkpoints"), "state/b/checkpoints");
    assert.strictEqual(docKey("a/b", "x y"), "state/a_b/x_y");
  });

  await check("snowflakes compare as numbers", () => {
    assert.ok(newer("1000000000000000010", "999999999999999999"));
    assert.ok(!newer("5", "5"));
  });

  await check("a seen channel is written to the record and survives a new process", async () => {
    const a = make();
    await a.loadSeen();
    await a.recordSeen("111");
    await a.recordSeen("111");
    const b = make();
    await b.loadSeen();
    assert.deepStrictEqual([...b.seenIds()], ["111"]);
  });

  await check("the old local files seed the record once, and never overwrite it", async () => {
    const seenFile = join(dir, "seen.json"), markFile = join(dir, "cp.json");
    writeFileSync(seenFile, JSON.stringify(["222"]));
    writeFileSync(markFile, JSON.stringify({ c1: "100", c2: "200" }));
    const s = make({ legacySeenFile: seenFile, legacyCheckpointFile: markFile });
    await s.loadSeen();
    await s.loadMarks();
    assert.deepStrictEqual([...s.seenIds()], ["111"], "an existing record is not overwritten by the old file");
    assert.deepStrictEqual(s.marksNow(), { c1: "100", c2: "200" });
    writeFileSync(markFile, JSON.stringify({ c1: "1" }));
    const t = make({ legacyCheckpointFile: markFile });
    await t.loadMarks();
    assert.deepStrictEqual(t.marksNow(), { c1: "100", c2: "200" });
  });

  await check("a checkpoint only moves forward, and two writers keep each other's channels", async () => {
    const a = make(), b = make();
    await a.loadMarks(); await b.loadMarks();
    await a.setMark("c1", "300");
    await b.setMark("c3", "50");
    await b.setMark("c1", "10");
    const c = make();
    await c.loadMarks();
    assert.deepStrictEqual(c.marksNow(), { c1: "300", c2: "200", c3: "50" });
  });

  await check("a record that cannot be read is not read as empty: the cycle is told so", async () => {
    const down = mk(downEnv());
    assert.strictEqual(await down.loadMarks(), false);
    assert.deepStrictEqual(down.marksNow(), {});
  });

  await check("a change made while the record is down stays queued and goes out on the next flush", async () => {
    const env = downEnv();
    const s = mk(env);
    await s.recordSeen("333");
    assert.ok(s.seenIds().has("333"));
    env.COMPANY_RECORD_BASE_URL = rec.env.COMPANY_RECORD_BASE_URL;
    assert.strictEqual(await s.seen.flush(), true);
    const t = make();
    await t.loadSeen();
    assert.ok(t.seenIds().has("333"));
  });

  await check("an unconfigured bot says so and reads nothing as empty", async () => {
    const s = mk({});
    assert.strictEqual(s.configured, false);
    assert.strictEqual(await s.loadMarks(), false);
  });

  rmSync(dir, { recursive: true, force: true });
  await rec.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
