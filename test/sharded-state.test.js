/**
 * The bridge state, the owner-ask bindings and the stall card in the company
 * record, sharded (lib/sharded-record.js, lib/paperclip-state.js, lib/owner-asks.js).
 * Everything runs against a loopback stand-in for the record and a temporary folder.
 */
const { mkdtempSync, writeFileSync, readFileSync } = require("fs");
const { join } = require("path");
const os = require("os");
const assert = require("assert");
const { startReceiver } = require("./fake-receiver");
const { ScheduleStore } = require("../lib/schedule-store");
const { createPaperclipStore, splitState, joinState } = require("../lib/paperclip-state");
const { createOwnerAsks, createOwnerAskStore, announceAsk } = require("../lib/owner-asks");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed++; } catch (err) { console.log(`  FAIL ${name}\n       ${err.message}`); failed++; }
}
const quiet = { warn() {}, info() {}, error() {} };

const bigState = (n) => {
  const raw = { handledRuns: ["r1", "r2"], seq: 7, answeredAsks: [], pendingReplies: {}, closing: {}, lastAnswered: {}, resumedAsks: ["t0:a0"] };
  for (let i = 0; i < n; i++) { raw.answeredAsks.push(`task-${i}:ask`); raw.lastAnswered[`task-${i}`] = `task-${i}:ask`; }
  raw.pendingReplies["task-3:ask2"] = "an answer"; raw.closing["task-3"] = { key: "task-3:ask2", runId: "x" };
  return raw;
};

(async () => {
  console.log("\nSharded state: the record, not a local file");
  const rec = await startReceiver();
  const dir = mkdtempSync(join(os.tmpdir(), "ss-"));
  const mkStore = (env = rec.env) => new ScheduleStore({ env, bot: "team-bot", log: quiet, timeoutMs: 800 });
  const down = { ...rec.env, COMPANY_RECORD_BASE_URL: "http://127.0.0.1:1" };
  const shardRows = (name) => [...rec.rows].filter(([k]) => k.startsWith(`team-bot/state/b/${name}-`));

  await check("split and join are inverse, and a card's maps land in that card's entry", () => {
    const raw = bigState(5);
    const parts = splitState(raw);
    const entry = parts instanceof Map ? parts.get("task-3") : parts["task-3"];
    assert.deepStrictEqual(Object.keys(entry).sort(), ["answeredAsks", "closing", "lastAnswered", "pendingReplies"]);
    const back = joinState(parts);
    assert.deepStrictEqual([...back.answeredAsks].sort(), [...raw.answeredAsks].sort());
    assert.deepStrictEqual(back.pendingReplies, raw.pendingReplies);
    assert.deepStrictEqual(back.handledRuns, ["r1", "r2"]);
    assert.strictEqual(back.seq, 7);
  });

  await check("state over one record value is kept across shards, each under the cap, and survives a new process", async () => {
    const a = createPaperclipStore({ store: mkStore(), bot: "b", name: "big", log: quiet });
    assert.ok(await a.open());
    const raw = bigState(12000);
    a.write(raw);
    assert.ok(await a.record.flush());
    assert.ok(JSON.stringify(raw).length > 256 * 1024, "the fixture is over one key's cap");
    const sizes = shardRows("big").map(([, r]) => JSON.stringify(r.value).length);
    assert.ok(sizes.length > 1 && Math.max(...sizes) < 256 * 1024, `shards ${sizes.length}`);
    const b = createPaperclipStore({ store: mkStore(), bot: "b", name: "big", log: quiet });
    assert.ok(await b.open());
    const got = b.read();
    assert.strictEqual(got.answeredAsks.length, 12000);
    assert.deepStrictEqual(got.pendingReplies, raw.pendingReplies);
    assert.deepStrictEqual(got.handledRuns, ["r1", "r2"]);
  });

  await check("a save writes only the cards that changed, and a removed card leaves the record", async () => {
    const s = createPaperclipStore({ store: mkStore(), bot: "b", name: "diff", log: quiet });
    await s.open();
    s.write(bigState(50)); await s.record.flush();
    rec.log.length = 0;
    const raw = bigState(50); raw.pendingReplies["task-9:z"] = "x";
    s.write(raw); await s.record.flush();
    assert.strictEqual(rec.log.filter((l) => /^PUT .*state\/b\/diff-/.test(l) && !/conflict/.test(l)).length, 1, rec.log.join(" | "));
    const raw2 = bigState(50);
    raw2.answeredAsks = raw2.answeredAsks.filter((k) => !k.startsWith("task-0:")); delete raw2.lastAnswered["task-0"];
    s.write(raw2); await s.record.flush();
    const t = createPaperclipStore({ store: mkStore(), bot: "b", name: "diff", log: quiet });
    await t.open();
    assert.ok(!t.read().answeredAsks.includes("task-0:ask"));
    assert.strictEqual(t.read().answeredAsks.length, 49);
  });

  await check("losing the local file loses nothing: the old file seeds the record once and never overwrites a shard", async () => {
    const file = join(dir, "old.json");
    writeFileSync(file, JSON.stringify({ handledRuns: ["h"], answeredAsks: ["card-a:1", "card-b:1"], pendingReplies: { "card-a:2": "keep me" }, lastAnswered: { "card-a": "card-a:1" }, seq: 3 }));
    const a = createPaperclipStore({ store: mkStore(), bot: "b", name: "seed", legacyFile: file, log: quiet });
    assert.ok(await a.open());
    await a.record.flush();
    writeFileSync(file, JSON.stringify({ answeredAsks: ["card-a:9"], pendingReplies: { "card-a:2": "stale" } }));
    const b = createPaperclipStore({ store: mkStore(), bot: "b", name: "seed", legacyFile: file, log: quiet });
    assert.ok(await b.open());
    assert.deepStrictEqual([...b.read().answeredAsks].sort(), ["card-a:1", "card-b:1"]);
    const c = createPaperclipStore({ store: mkStore(), bot: "b", name: "seed", legacyFile: join(dir, "missing.json"), log: quiet });
    assert.ok(await c.open());
    assert.strictEqual(c.read().seq, 3);
    assert.deepStrictEqual(c.read().pendingReplies, { "card-a:2": "keep me" }, "the shard, not the changed file");
  });

  await check("a record that cannot be read leaves the state closed, never empty; an unreadable old file does too", async () => {
    assert.strictEqual(await createPaperclipStore({ store: mkStore(down), bot: "b", name: "seed", log: quiet }).open(), false);
    const bad = join(dir, "bad.json"); writeFileSync(bad, "{not json");
    assert.strictEqual(await createPaperclipStore({ store: mkStore(), bot: "b", name: "fresh-bad", legacyFile: bad, log: quiet }).open(), false);
  });

  await check("a write while the record is down stays queued, never throws, and goes out on the next flush", async () => {
    const store = mkStore();
    const s = createPaperclipStore({ store, bot: "b", name: "later", log: quiet });
    await s.open();
    const good = store.env;
    store.env = down;
    s.write(bigState(3));
    assert.strictEqual(await s.record.flush().catch(() => false), false);
    assert.ok(s.read().answeredAsks.includes("task-1:ask"), "the in-memory copy has it");
    store.env = good;
    assert.strictEqual(await s.record.flush(), true);
    const t = createPaperclipStore({ store: mkStore(), bot: "b", name: "later", log: quiet });
    await t.open();
    assert.strictEqual(t.read().answeredAsks.length, 3);
  });

  await check("the stall-card record is a small entry in the same store", async () => {
    const open = async () => { const s = createPaperclipStore({ store: mkStore(), bot: "b", name: "stall", log: quiet }); await s.open(); return s; };
    const s = await open();
    assert.ok(!s.getDoc("stall-card"));
    s.putDoc("stall-card", { issueId: "i1" }); await s.record.flush();
    const t = await open();
    assert.deepStrictEqual(t.getDoc("stall-card"), { issueId: "i1" });
    assert.ok(!t.read(), "a doc is not state");
    t.putDoc("stall-card", null); await t.record.flush();
    assert.ok(!(await open()).getDoc("stall-card"));
  });

  await check("owner asks: an announced ask is in the record, and a new process sees it and posts nothing", async () => {
    const open = async () => { const st = createOwnerAskStore({ store: mkStore(), bot: "b", name: "asks", log: quiet }); assert.ok(await st.open()); return { st, reg: createOwnerAsks({ store: st }) }; };
    const { st, reg } = await open();
    const ask = { ownerCardId: "own-1", ownerCardIdentifier: "R-1", cardIdentifier: "T-1", issueId: "i-1", decision: "Approve?", recommendation: "go" };
    const first = await announceAsk({ registry: reg, ask, channelId: "123456789012345678", send: async () => ({ id: "m-1" }) });
    assert.strictEqual(first.posted, true);
    await st.record.flush();
    const { reg: again } = await open();
    let sends = 0;
    const second = await announceAsk({ registry: again, ask, channelId: "123456789012345678", send: async () => { sends++; return { id: "m-2" }; } });
    assert.strictEqual(second.posted, false);
    assert.strictEqual(sends, 0);
    assert.strictEqual(again.all().length, 1);
  });

  await check("owner asks: the old file seeds the shards once; an unreadable one leaves it closed", async () => {
    const file = join(dir, "owner-asks.json");
    writeFileSync(file, JSON.stringify({ asks: { "default:c1": { key: "default:c1", state: "open", discordMessageId: "m", channelId: "1", createdAt: "2026-01-01", steps: {} } } }));
    const st = createOwnerAskStore({ store: mkStore(), bot: "b", name: "asks-seed", legacyFile: file, log: quiet });
    assert.ok(await st.open());
    assert.strictEqual(createOwnerAsks({ store: st }).get("default:c1").discordMessageId, "m");
    const bad = join(dir, "owner-bad.json"); writeFileSync(bad, "{nope");
    assert.strictEqual(await createOwnerAskStore({ store: mkStore(), bot: "b", name: "asks-bad", legacyFile: bad, log: quiet }).open(), false);
  });

  await check("no source writes the bridge state, the bindings or the stall card to a local file", () => {
    for (const f of ["lib/paperclip.js", "lib/owner-asks.js", "lib/paperclip-state.js", "lib/sharded-record.js"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      assert.ok(!/writeFile(Sync)?\(|renameSync\(|appendFile(Sync)?\(|createWriteStream\(|openSync\(/.test(src), `${f} writes a file`);
    }
  });

  await rec.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
