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
const { ShardedRecord } = require("../lib/sharded-record");
const { createOwnerAsks, createOwnerAskStore, announceAsk, recoverUnsentAsks, askMessage } = require("../lib/owner-asks");

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

  const brokenWrites = (store) => { const set = store.set; store.set = async () => { throw new Error("record down"); }; return () => { store.set = set; }; };

  await check("many changes to one bucket cost one write: a flush coalesces", async () => {
    const r = new ShardedRecord({ store: mkStore(), bot: "b", name: "coal", buckets: 2, log: quiet });
    assert.ok(await r.open());
    rec.log.length = 0;
    for (let i = 0; i < 300; i++) r.put(`id-${i}`, { n: i });
    assert.ok(await r.flush());
    const puts = rec.log.filter((l) => /^PUT .*state\/b\/coal-/.test(l) && !/conflict/.test(l));
    assert.ok(puts.length <= 2, `${puts.length} writes for 300 changes: ${puts.join(" | ")}`);
    const t = new ShardedRecord({ store: mkStore(), bot: "b", name: "coal", buckets: 2, log: quiet });
    assert.ok(await t.open());
    assert.strictEqual(t.map.size, 300);
  });

  await check("an entry too big for its bucket gets its own document, written before the pointer, and reads back", async () => {
    const r = new ShardedRecord({ store: mkStore(), bot: "b", name: "ovf", buckets: 2, log: quiet });
    assert.ok(await r.open());
    rec.log.length = 0;
    const huge = { list: Array.from({ length: 6000 }, (_, i) => `run-${i}-aaaaaaaa`) };
    r.put("huge", huge); r.put("small", { n: 1 });
    assert.ok(await r.flush());
    const puts = rec.log.filter((l) => l.startsWith("PUT") && !/conflict/.test(l));
    const own = puts.findIndex((l) => /ovf-x-/.test(l)), bucket = puts.findIndex((l) => /ovf-\d\d/.test(l));
    assert.ok(own >= 0 && bucket > own, puts.join(" | "));
    assert.ok(Math.max(...shardRows("ovf").filter(([k]) => !/-x-/.test(k)).map(([, row]) => JSON.stringify(row.value).length)) < 9000, "the bucket holds a pointer, not the entry");
    const t = new ShardedRecord({ store: mkStore(), bot: "b", name: "ovf", buckets: 2, log: quiet });
    assert.ok(await t.open());
    assert.deepStrictEqual(t.get("huge"), huge);
    assert.deepStrictEqual(t.get("small"), { n: 1 });
    for (const k of [...rec.rows.keys()].filter((k) => /ovf-x-/.test(k))) rec.rows.delete(k);
    assert.strictEqual(await new ShardedRecord({ store: mkStore(), bot: "b", name: "ovf", buckets: 2, log: quiet }).open(), false, "a pointer to nothing leaves it closed");
  });

  await check("open() is true only once the import is in the record; a failed commit leaves it closed and the next open finishes it", async () => {
    const file = join(dir, "mig.json");
    writeFileSync(file, JSON.stringify({ answeredAsks: ["m-a:1"], seq: 4 }));
    const store = mkStore();
    const restore = brokenWrites(store);
    const a = createPaperclipStore({ store, bot: "b", name: "mig", legacyFile: file, log: quiet });
    assert.strictEqual(await a.open(), false);
    restore();
    const b = createPaperclipStore({ store: mkStore(), bot: "b", name: "mig", legacyFile: file, log: quiet });
    assert.ok(await b.open());
    writeFileSync(file, "{gone");
    const c = createPaperclipStore({ store: mkStore(), bot: "b", name: "mig", legacyFile: file, log: quiet });
    assert.ok(await c.open(), "committed: the file is not read again for a bucket that exists");
    assert.strictEqual(c.read().seq, 4);
  });

  await check("a restart between the imported entries and the empty-bucket marks resumes the import, never reads empty as done", async () => {
    const file = join(dir, "mig2.json");
    writeFileSync(file, JSON.stringify({ answeredAsks: ["z-a:1"], pendingReplies: { "z-a:2": "keep" }, seq: 9 }));
    writeFileSync(`${file}.stall-card.json`, JSON.stringify({ issueId: "card-9" }));
    const store = mkStore();
    const set = store.set;
    let writes = 0;
    store.set = async (k, v, ver) => { if (!v.entries || Object.keys(v.entries).length) { writes++; return set.call(store, k, v, ver); } throw new Error("marks down"); };
    assert.strictEqual(await createPaperclipStore({ store, bot: "b", name: "mig2", legacyFile: file, log: quiet }).open(), false);
    assert.ok(writes > 0, "the contents went out first");
    const again = createPaperclipStore({ store: mkStore(), bot: "b", name: "mig2", legacyFile: file, log: quiet });
    assert.ok(await again.open());
    writeFileSync(file, "{gone"); writeFileSync(`${file}.stall-card.json`, "{gone");
    const last = createPaperclipStore({ store: mkStore(), bot: "b", name: "mig2", legacyFile: file, log: quiet });
    assert.ok(await last.open());
    assert.strictEqual(last.read().seq, 9);
    assert.deepStrictEqual(last.read().pendingReplies, { "z-a:2": "keep" });
    assert.deepStrictEqual(last.getDoc("stall-card"), { issueId: "card-9" });
  });

  await check("a failed flush retries by itself, with no further change", async () => {
    const store = mkStore();
    const r = new ShardedRecord({ store, bot: "b", name: "retry", buckets: 2, retryMs: [20], log: quiet });
    assert.ok(await r.open());
    const restore = brokenWrites(store);
    r.put("a", { n: 1 });
    assert.strictEqual(await r.flush(), false);
    restore();
    for (let i = 0; i < 50 && r.dirty.size; i++) await new Promise((res) => setTimeout(res, 20));
    assert.strictEqual(r.dirty.size, 0, "drained by the timer");
    const t = new ShardedRecord({ store: mkStore(), bot: "b", name: "retry", buckets: 2, log: quiet });
    await t.open();
    assert.deepStrictEqual(t.get("a"), { n: 1 });
  });

  await check("the old stall-card marker is imported with the state file, or alone", async () => {
    const file = join(dir, "bridge.json");
    writeFileSync(`${file}.stall-card.json`, JSON.stringify({ issueId: "old-1" }));
    const a = createPaperclipStore({ store: mkStore(), bot: "b", name: "stallmig", legacyFile: file, log: quiet });
    assert.ok(await a.open());
    assert.deepStrictEqual(a.getDoc("stall-card"), { issueId: "old-1" });
  });

  await check("an ask is announced only after its binding is in the record", async () => {
    const store = mkStore();
    const st = createOwnerAskStore({ store, bot: "b", name: "asks-order", log: quiet });
    assert.ok(await st.open());
    const reg = createOwnerAsks({ store: st });
    const restore = brokenWrites(store);
    let sends = 0;
    const ask = { ownerCardId: "own-9", cardIdentifier: "T-9", issueId: "i-9", decision: "Approve?" };
    const r1 = await announceAsk({ registry: reg, ask, channelId: "123456789012345678", send: async () => { sends++; return { id: "m" }; } });
    assert.deepStrictEqual([r1.posted, sends], [false, 0]);
    restore();
    const r2 = await announceAsk({ registry: reg, ask, channelId: "123456789012345678", send: async () => { sends++; return { id: "m" }; } });
    assert.deepStrictEqual([r2.posted, sends], [true, 1]);
    const t = createOwnerAskStore({ store: mkStore(), bot: "b", name: "asks-order", log: quiet });
    await t.open();
    assert.strictEqual(createOwnerAsks({ store: t }).get(reg.keyOf(null, "own-9")).discordMessageId, "m");
  });

  const flake = (ms, n = 0) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
  const CH = "123456789012345678";
  await check("an ask sent just before a restart is adopted, not sent twice", async () => {
    const store = mkStore();
    const st = createOwnerAskStore({ store, bot: "b", name: "asks-adopt", log: quiet });
    assert.ok(await st.open());
    const reg = createOwnerAsks({ store: st });
    const ask = { ownerCardId: "own-10", cardIdentifier: "T-10", issueId: "i-10", decision: "Approve?" };
    const channel = [];
    let sends = 0;
    // The message reaches the channel but its id never comes back: the binding is durable with no id.
    const lostSend = async (text) => { channel.push({ id: flake(Date.now() + 5), content: text }); return null; };
    const r1 = await announceAsk({ registry: reg, ask, channelId: CH, send: lostSend });
    assert.strictEqual(r1.posted, false);
    const st2 = createOwnerAskStore({ store, bot: "b", name: "asks-adopt", log: quiet });
    await st2.open();
    const reg2 = createOwnerAsks({ store: st2 });
    const r2 = await announceAsk({ registry: reg2, ask, channelId: CH,
      send: async () => { sends++; return { id: "again" }; }, scan: async () => channel });
    assert.deepStrictEqual([r2.binding.discordMessageId, sends], [channel[0].id, 0]);
  });

  await check("an identical earlier ask 30s before, with 120 messages between, is never adopted for the new one", async () => {
    const st = createOwnerAskStore({ store: mkStore(), bot: "b", name: "asks-twin", log: quiet });
    assert.ok(await st.open());
    const reg = createOwnerAsks({ store: st });
    const t0 = Date.now();
    const mk = (id, at) => reg.create({ key: reg.keyOf(null, id), board: null, channelId: CH, cardIdentifier: "T-1", issueId: id, ownerCardId: id,
      decision: "Approve?", yesAction: "go", link: "https://x/1", answerers: ["u1"], createdAt: new Date(at).toISOString() });
    const old = mk("own-old", t0 - 30_000);
    old.discordMessageId = flake(t0 - 29_000); old.state = "answered"; reg.put(old);
    const fresh = mk("own-new", t0);
    const history = [{ id: old.discordMessageId, content: askMessage(old) }];
    for (let i = 0; i < 120; i++) history.push({ id: flake(t0 - 28_000 + i * 100), content: `chat ${i}` });
    // The older announcement carries the same text apart from its ref, and even its ref text must not match.
    history.push({ id: flake(t0 - 5_000), content: askMessage(fresh).replace(/ref: \w+/, `ref: ${"0".repeat(12)}`) });
    const mine = { id: flake(t0 + 2_000), content: askMessage(fresh) };
    history.push(mine);
    let sends = 0;
    assert.strictEqual(await recoverUnsentAsks({ registry: reg, scan: async () => history }), 1);
    assert.strictEqual(reg.get(fresh.key).discordMessageId, mine.id);
    assert.strictEqual(reg.get(old.key).discordMessageId, flake(t0 - 29_000));
    const r = await announceAsk({ registry: reg, ask: { ownerCardId: "own-new", cardIdentifier: "T-1", issueId: "own-new", decision: "Approve?" }, channelId: CH, send: async () => { sends++; return { id: "x" }; } });
    assert.deepStrictEqual([r.posted, sends], [false, 0]);
    assert.strictEqual(reg.byMessage(CH, mine.id).key, fresh.key);
  });

  await check("a message already bound to another ask is never adopted", async () => {
    const st = createOwnerAskStore({ store: mkStore(), bot: "b", name: "asks-bound", log: quiet });
    assert.ok(await st.open());
    const reg = createOwnerAsks({ store: st });
    const t0 = Date.now();
    const a = reg.create({ key: reg.keyOf(null, "a"), channelId: CH, cardIdentifier: "T", decision: "d", yesAction: "y", answerers: [], createdAt: new Date(t0).toISOString() });
    const msg = { id: flake(t0 + 1000), content: askMessage(a) };
    const b = reg.create({ key: reg.keyOf(null, "b"), channelId: CH, cardIdentifier: "T", decision: "d", yesAction: "y", answerers: [], createdAt: new Date(t0).toISOString(), discordMessageId: msg.id });
    assert.strictEqual(await recoverUnsentAsks({ registry: reg, scan: async () => [msg] }), 0);
    assert.strictEqual(reg.get(a.key).discordMessageId, null);
  });

  await check("startup recovery reads a channel's history once for all its bindings", async () => {
    const st = createOwnerAskStore({ store: mkStore(), bot: "b", name: "asks-once", log: quiet });
    assert.ok(await st.open());
    const reg = createOwnerAsks({ store: st });
    const t0 = Date.now();
    const made = [];
    for (let i = 0; i < 20; i++) made.push(reg.create({ key: reg.keyOf(null, `k${i}`), channelId: CH, cardIdentifier: `T-${i}`, decision: "d", yesAction: "y", answerers: [], createdAt: new Date(t0 + i).toISOString() }));
    const history = made.map((b, i) => ({ id: flake(t0 + 1000 + i), content: askMessage(b) }));
    let scans = 0;
    assert.strictEqual(await recoverUnsentAsks({ registry: reg, scan: async () => { scans++; return history; } }), 20);
    assert.strictEqual(scans, 1);
  });

  await check("a history lookup that errors sends nothing, and startup recovery adopts the original", async () => {
    const st = createOwnerAskStore({ store: mkStore(), bot: "b", name: "asks-lookup", log: quiet });
    assert.ok(await st.open());
    const reg = createOwnerAsks({ store: st });
    const ask = { ownerCardId: "own-11", cardIdentifier: "T-11", issueId: "i-11", decision: "Approve?" };
    let sends = 0;
    const send = async () => { sends++; return { id: "new" }; };
    const r1 = await announceAsk({ registry: reg, ask, channelId: CH, send, scan: async () => { throw new Error("history down"); } });
    assert.deepStrictEqual([r1.posted, r1.binding.discordMessageId, sends], [false, null, 0]);
    assert.strictEqual(await recoverUnsentAsks({ registry: reg, scan: async () => { throw new Error("down"); } }), 0);
    const b = reg.get(reg.keyOf(null, "own-11"));
    assert.strictEqual(b.discordMessageId, null);
    const orig = { id: flake(Date.now() + 1000), content: askMessage(b) };
    assert.strictEqual(await recoverUnsentAsks({ registry: reg, scan: async () => [orig] }), 1);
    assert.strictEqual(reg.byMessage(CH, orig.id)?.cardIdentifier, "T-11");
    const r2 = await announceAsk({ registry: reg, ask, channelId: CH, send });
    assert.deepStrictEqual([r2.posted, sends], [false, 0]);
  });

  await check("a failed import leaves the old file in place and the collection closed", async () => {
    const file = join(dir, "keep.json");
    writeFileSync(file, JSON.stringify({ seq: 5 }));
    const store = mkStore();
    store.set = async () => { throw new Error("record down"); };
    assert.strictEqual(await createPaperclipStore({ store, bot: "b", name: "keep", legacyFile: file, log: quiet }).open(), false);
    assert.strictEqual(JSON.parse(readFileSync(file, "utf8")).seq, 5);
  });

  await check("the recovery search has no fixed message count and is done before replies route", () => {
    const src = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
    assert.ok(!/limit:\s*50\b/.test(src));
    assert.ok(/await ownerAsksRecovery;\s*\n\s*const isAskAnswer/.test(src));
  });

  await check("the poller launches nothing until its state is in the record", () => {
    const src = readFileSync(join(__dirname, "..", "lib/paperclip.js"), "utf8");
    const at = src.indexOf("const preflight = async");
    const body = src.slice(at, src.indexOf("const run = async", at));
    assert.ok(/await stateStore\.flush\(\)/.test(body) && /throw new CardMoved\(\)/.test(body.slice(body.indexOf("stateStore.flush"))));
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
