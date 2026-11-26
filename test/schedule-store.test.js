/**
 * The schedules list lives in the company record's keyed state (lib/schedule-store.js),
 * and a run books jobs by leaving request files (lib/schedule-requests.js).
 * Everything runs against a loopback stand-in for the record and a temporary folder.
 */
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readdirSync, readFileSync } = require("fs");
const { join } = require("path");
const os = require("os");
const assert = require("assert");
const { startReceiver } = require("./fake-receiver");

const SIGNING_VAR = "SLASHBIN_STATE_SIGNING_KEY__TEAM_BOT";
const wasSet = process.env[SIGNING_VAR];
process.env[SIGNING_VAR] = "test-signing-key";
const { ScheduleStore, keyFor, jobsOf, OWNER } = require("../lib/schedule-store");
const requests = require("../lib/schedule-requests");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed++; } catch (err) { console.log(`  FAIL ${name}\n       ${err.message}`); failed++; }
}
const quiet = { warn() {}, info() {} };
const job = (id, extra = {}) => ({ id, channel: "111", cron: "0 9 * * *", prompt: `do ${id}`, ...extra });
const ids = (jobs) => jobs.map((j) => j.id);

(async () => {
  console.log("\nSchedule store — keys and the record");

  await check("the key is per bot, and per scope in private mode; nothing unsafe survives in it", () => {
    assert.strictEqual(keyFor("team-bot"), "schedules/team-bot");
    assert.strictEqual(keyFor("privbot", "group_acme"), "schedules/privbot/group_acme");
    assert.strictEqual(keyFor("a/b", "../x"), "schedules/a_b/.._x");
    assert.strictEqual(OWNER, "team-bot");
  });

  await check("the signing key is taken out of process.env when the module loads, so no run inherits it", () => {
    assert.strictEqual(process.env[SIGNING_VAR], undefined);
  });

  await check("jobsOf accepts {jobs:[...]} or a bare list and ignores anything else", () => {
    assert.deepStrictEqual(ids(jobsOf({ jobs: [job("a"), null, 3] })), ["a"]);
    assert.deepStrictEqual(ids(jobsOf([job("b")])), ["b"]);
    assert.deepStrictEqual(jobsOf("x"), []);
    assert.deepStrictEqual(jobsOf(null), []);
  });

  const rec = await startReceiver();
  const mk = (over = {}) => new ScheduleStore({ env: { ...rec.env, ...over }, bot: "team-bot", log: quiet });

  await check("a key that does not exist yet loads as no jobs, and the first write creates it (expected_version 0)", async () => {
    const s = mk();
    assert.strictEqual(await s.load(), true);
    assert.deepStrictEqual(s.jobs(), []);
    s.mutate(null, (jobs) => [...jobs, job("first")]);
    assert.deepStrictEqual(ids(s.jobs()), ["first"], "the change is in the copy at once");
    assert.strictEqual(await s.flush(), true);
    assert.deepStrictEqual(ids(rec.jobs("schedules/team-bot")), ["first"]);
    assert.ok(rec.log.includes("PUT team-bot/schedules/team-bot v1"));
  });

  await check("a second store loads what the first wrote", async () => {
    const s = mk();
    await s.load();
    assert.deepStrictEqual(ids(s.jobs()), ["first"]);
  });

  await check("a version conflict re-reads and re-applies: an entry written meanwhile is never lost", async () => {
    const s = mk();
    await s.load();
    // Another writer lands between this store's read and its write.
    let injected = false;
    const rec2 = await startReceiver({ beforePut: ({ rows, key }) => {
      if (injected) return;
      injected = true;
      const row = rows.get(key);
      rows.set(key, { value: { jobs: [...row.value.jobs, job("other-writer")] }, version: row.version + 1 });
    } });
    rec2.seed("schedules/team-bot", { jobs: [job("first")] });
    const s2 = new ScheduleStore({ env: rec2.env, bot: "team-bot", log: quiet });
    await s2.load();
    s2.mutate(null, (jobs) => [...jobs, job("mine")]);
    assert.strictEqual(await s2.flush(), true);
    assert.deepStrictEqual(ids(rec2.jobs("schedules/team-bot")).sort(), ["first", "mine", "other-writer"]);
    assert.ok(rec2.log.some((l) => /conflict/.test(l)), "the conflict never happened");
    await rec2.close();
  });

  await check("a removal applied twice (after a conflict) is still one removal", async () => {
    const s = mk();
    await s.load();
    s.mutate(null, (jobs) => jobs.filter((j) => j.id !== "first"));
    s.mutate(null, (jobs) => [...jobs, job("second")]);
    await s.flush();
    assert.deepStrictEqual(ids(rec.jobs("schedules/team-bot")), ["second"]);
  });

  await check("a scope that never loaded refuses a change, so nothing is written over a list never read", async () => {
    const s = mk({ COMPANY_RECORD_READ_TOKEN: "wrong-token" });
    const before = rec.log.filter((l) => l.startsWith("PUT")).length;
    assert.strictEqual(await s.load(), false);
    assert.throws(() => s.mutate(null, (jobs) => jobs), /not loaded/);
    assert.strictEqual(rec.log.filter((l) => l.startsWith("PUT")).length, before, "something was written");
  });

  await check("a failed flush keeps the change queued and retries it; nothing is dropped", async () => {
    const s = mk();
    await s.load();
    s.mutate(null, (jobs) => [...jobs, job("late")]);
    s.env = { ...s.env, [SIGNING_VAR]: "wrong-key" }; // the record refuses the signature
    assert.strictEqual(await s.flush(), false);
    assert.ok(ids(s.jobs()).includes("late"), "the change left the copy");
    s.env = { ...s.env, [SIGNING_VAR]: "test-signing-key" };
    assert.strictEqual(await s.flush(), true);
    assert.ok(ids(rec.jobs("schedules/team-bot")).includes("late"));
  });

  await check("not configured: loading says so, nothing is sent", async () => {
    const warns = [];
    const s = new ScheduleStore({ env: {}, bot: "x", log: { warn: (m) => warns.push(m) } });
    assert.strictEqual(await s.load(), false);
    assert.strictEqual(s.configured, false);
    assert.ok(/not configured/.test(warns[0]));
  });

  await check("each scope has its own key", async () => {
    const s = new ScheduleStore({ env: rec.env, bot: "privbot", log: quiet });
    await s.load("group_acme"); await s.load("333");
    s.mutate("group_acme", (jobs) => [...jobs, job("g")]);
    s.mutate("333", (jobs) => [...jobs, job("s", { channel: "333" })]);
    await s.flushAll();
    assert.deepStrictEqual(ids(rec.jobs("schedules/privbot/group_acme")), ["g"]);
    assert.deepStrictEqual(ids(rec.jobs("schedules/privbot/333")), ["s"]);
  });

  console.log("\nSchedule store — channel groups keep the old foreign-row and dormant-scope behaviour");

  await check("a change to a scope keeps the rows already there that belong to another scope, and a consumed wake fires once over two ticks", async () => {
    const r = await startReceiver();
    r.seed("schedules/privbot/group_acme", { jobs: [job("wake", { channel: "111", once: true }), job("pre", { channel: "333" })] });
    const s = new ScheduleStore({ env: r.env, bot: "privbot", log: quiet });
    await s.load("group_acme");
    let ran = 0;
    const tick = async () => {
      const due = s.jobs("group_acme").filter((j) => j.id === "wake");
      ran += due.length;
      s.mutate("group_acme", (jobs) => jobs.filter((j) => j.id !== "wake"));
      await s.flush("group_acme");
    };
    await tick(); await tick();
    assert.strictEqual(ran, 1, "the consumed wake fired again");
    assert.deepStrictEqual(ids(r.jobs("schedules/privbot/group_acme")), ["pre"], "the outside-scope row was lost or the wake stayed");
    await r.close();
  });

  await check("a scope nobody changed is never written, so a dormant scope's record stays exactly as it was", async () => {
    const r = await startReceiver();
    r.seed("schedules/privbot/111", { jobs: [job("j111")] });
    r.seed("schedules/privbot/333", { jobs: [job("r333", { channel: "333" })] });
    const s = new ScheduleStore({ env: r.env, bot: "privbot", log: quiet });
    await s.load("111"); await s.load("333");
    s.mutate("333", (jobs) => [...jobs, job("new", { channel: "333" })]);
    await s.flushAll();
    assert.deepStrictEqual(ids(r.jobs("schedules/privbot/333")), ["r333", "new"]);
    assert.ok(!r.log.some((l) => /^PUT .*\/111/.test(l)), "the dormant scope was written");
    assert.deepStrictEqual(ids(r.jobs("schedules/privbot/111")), ["j111"]);
    await r.close();
  });

  await check("a record that cannot be read is not written over: the scope refuses changes until it loads", async () => {
    const r = await startReceiver();
    r.seed("schedules/privbot/333", { jobs: [job("keep", { channel: "333" })] });
    const s = new ScheduleStore({ env: { ...r.env, COMPANY_RECORD_READ_TOKEN: "wrong" }, bot: "privbot", log: quiet });
    assert.strictEqual(await s.load("333"), false);
    assert.throws(() => s.mutate("333", (jobs) => [...jobs, job("x")]), /not loaded/);
    assert.deepStrictEqual(ids(r.jobs("schedules/privbot/333")), ["keep"]);
    await r.close();
  });

  console.log("\nSchedule store — the one-time import");

  await check("import creates the key once; a second run does nothing and says exists", async () => {
    const s = new ScheduleStore({ env: rec.env, bot: "po", log: quiet });
    const first = await s.importList(null, [job("old1"), job("old2")]);
    assert.deepStrictEqual([first.status, first.jobs], ["imported", 2]);
    const writes = rec.log.filter((l) => l.startsWith("PUT")).length;
    const again = await s.importList(null, [job("different")]);
    assert.strictEqual(again.status, "exists");
    assert.strictEqual(rec.log.filter((l) => l.startsWith("PUT")).length, writes, "a second import wrote");
    assert.deepStrictEqual(ids(rec.jobs("schedules/po")), ["old1", "old2"]);
  });

  await rec.close();

  console.log("\nSchedule requests — what a run may leave");
  const root = mkdtempSync(join(os.tmpdir(), "sched-req-"));
  const view = join(root, "schedules.json");
  const dir = requests.requestsDirFor(view);
  mkdirSync(dir);
  const put = (name, text) => writeFileSync(join(dir, name), text);

  await check("a good add and remove are read; each bad one is refused with a reason, never its contents", () => {
    put("a.json", JSON.stringify({ op: "add", job: job("j1") }));
    put("b.json", JSON.stringify({ op: "remove", id: "j0" }));
    put("c.json", "{SECRETISH not json");
    put("d.json", JSON.stringify({ op: "add", job: { id: "x", prompt: "p", cron: "* * * * *", channel: "not-a-number" } }));
    put("e.json", JSON.stringify({ op: "nuke" }));
    put("notes.txt", "ignored");
    const r = requests.readRequests(dir);
    assert.deepStrictEqual(r.requests.map((x) => x.request.op).sort(), ["add", "remove"]);
    assert.strictEqual(r.refused.length, 4, "three bad requests and a stray name");
    assert.ok(!JSON.stringify(r.refused).includes("SECRETISH"));
  });

  await check("a link, an oversize file and a folder named like a request are refused", () => {
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({ op: "remove", id: "victim" }));
    symlinkSync(outside, join(dir, "link.json"));
    put("big.json", JSON.stringify({ op: "add", job: job("big", { prompt: "x".repeat(70 * 1024) }) }));
    mkdirSync(join(dir, "folder.json"));
    const r = requests.readRequests(dir);
    assert.ok(!r.requests.some((x) => x.request.id === "victim"), "a link was followed");
    assert.ok(!r.requests.some((x) => x.request.job?.id === "big"));
    for (const f of ["link.json", "big.json", "folder.json"]) assert.ok(r.refused.some((x) => x.file.endsWith(f)), `${f} was not refused`);
  });

  await check("the folder itself as a link reads as nothing", () => {
    const real = join(root, "real"); mkdirSync(real);
    writeFileSync(join(real, "a.json"), JSON.stringify({ op: "remove", id: "z" }));
    const l = join(root, "linked", "schedule-requests");
    mkdirSync(join(root, "linked"));
    symlinkSync(real, l);
    const r = requests.readRequests(l);
    assert.deepStrictEqual(r.requests, []);
  });

  rmSync(root, { recursive: true, force: true });
  await check("the temporary folder is removed", () => assert.strictEqual(existsSync(root), false));

  if (wasSet !== undefined) process.env[SIGNING_VAR] = wasSet;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
