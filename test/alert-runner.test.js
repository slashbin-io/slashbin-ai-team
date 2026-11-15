/**
 * Alert runner — a monitoring alert answered by a command in its own thread, never by
 * the model (lib/alert-runner.js). The gate is tested on message shapes Discord delivers;
 * the queue against a fake thread and a real command (the routine runner).
 */
const assert = require("assert");
const { mkdtempSync, writeFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { parseAlertConfig, isAlert, alertInput, threadName, createAlertQueue } = require("../lib/alert-runner");
const { parseRoutineRunner, createRoutineRunner } = require("../lib/routine-runner");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const CH = "1484731236093006004", HOOK = "1541625394912952484";
const ENV = { ALERT_CHANNELS: CH, ALERT_WEBHOOKS: HOOK, ALERT_RUNNER: "node runner.mjs" };
const config = parseAlertConfig(ENV, parseRoutineRunner).config;

function fakeMsg(over = {}) {
  const sent = [];
  const thread = { id: "t1", send: async (m) => { sent.push(m); } };
  return {
    id: "m1", channelId: CH, webhookId: HOOK,
    content: "**Firing**\n\nLabels:\n - alertname = Ship Dot mismatch",
    embeds: [{ title: "[FIRING:1] Ship Dot mismatch production", description: null, fields: [] }],
    startThread: async (o) => { thread.name = o.name; return thread; },
    sent, thread, ...over,
  };
}

(async () => {
  console.log("alert runner");

  await check("off when nothing is set; a partial set is a problem, not a guess", () => {
    assert.deepStrictEqual(parseAlertConfig({}, parseRoutineRunner), { config: null, problem: null });
    const partial = parseAlertConfig({ ALERT_CHANNELS: CH, ALERT_RUNNER: "node x" }, parseRoutineRunner);
    assert.strictEqual(partial.config, null);
    assert.match(partial.problem, /must be set together/);
    assert.deepStrictEqual(config, { channels: [CH], webhooks: [HOOK], command: ["node", "runner.mjs"] });
  });

  await check("only the listed webhook in the listed channel is an alert", () => {
    assert.strictEqual(isAlert(fakeMsg(), config), true);
    assert.strictEqual(isAlert(fakeMsg({ webhookId: null }), config), false, "a person or a bot account");
    assert.strictEqual(isAlert(fakeMsg({ webhookId: "999" }), config), false, "another webhook");
    assert.strictEqual(isAlert(fakeMsg({ channelId: "1" }), config), false, "another channel");
    assert.strictEqual(isAlert(fakeMsg(), null), false, "runner off");
  });

  await check("the runner gets the embed title and the whole text", () => {
    const input = alertInput(fakeMsg());
    assert.strictEqual(input.identifier, "m1");
    assert.strictEqual(input.title, "[FIRING:1] Ship Dot mismatch production");
    assert.match(input.description, /alertname = Ship Dot mismatch[\s\S]*\[FIRING:1\]/);
  });

  await check("thread names fit Discord's limit and are never empty", () => {
    assert.ok(threadName("x".repeat(500)).length <= 100);
    assert.strictEqual(threadName("  "), "Alert triage");
  });

  const dir = mkdtempSync(join(tmpdir(), "alert-"));
  const script = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };
  const runnerFor = (path) => createRoutineRunner({ command: ["node", path], cwd: dir, env: () => process.env, timeoutMs: 10_000, log: silent });

  await check("an answer is posted in a thread on the alert, with no pings", async () => {
    const p = script("answer.js", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);console.log('**SRE triage** for '+i.title)})");
    const q = createAlertQueue({ run: runnerFor(p), split: (t) => [t], log: silent });
    const msg = fakeMsg();
    q.enqueue(msg); await q.idle();
    assert.strictEqual(msg.thread.name, "[FIRING:1] Ship Dot mismatch production");
    assert.strictEqual(msg.sent.length, 1);
    assert.match(msg.sent[0].content, /SRE triage\*\* for \[FIRING:1\]/);
    assert.deepStrictEqual(msg.sent[0].allowedMentions, { parse: [] });
  });

  await check("a declined alert (exit 3) gets no thread", async () => {
    const p = script("decline.js", "process.stdin.resume();process.stdin.on('end',()=>process.exit(3))");
    const q = createAlertQueue({ run: runnerFor(p), split: (t) => [t], log: silent });
    const msg = fakeMsg(); let started = false; msg.startThread = async () => { started = true; return msg.thread; };
    q.enqueue(msg); await q.idle();
    assert.strictEqual(started, false);
    assert.strictEqual(msg.sent.length, 0);
  });

  await check("a failed runner says so in the thread instead of going silent", async () => {
    const p = script("fail.js", "process.stdin.resume();process.stdin.on('end',()=>{console.error('boom');process.exit(1)})");
    const q = createAlertQueue({ run: runnerFor(p), split: (t) => [t], log: silent });
    const msg = fakeMsg();
    q.enqueue(msg); await q.idle();
    assert.match(msg.sent[0].content, /alert runner failed[\s\S]*boom/);
  });

  await check("alerts run one at a time, in arrival order", async () => {
    const order = []; let running = 0, maxRunning = 0;
    const run = async (i) => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 20)); order.push(i.identifier); running--; return "ok"; };
    const q = createAlertQueue({ run, split: (t) => [t], log: silent });
    q.enqueue(fakeMsg({ id: "a" })); q.enqueue(fakeMsg({ id: "b" })); q.enqueue(fakeMsg({ id: "c" }));
    await q.idle();
    assert.deepStrictEqual(order, ["a", "b", "c"]);
    assert.strictEqual(maxRunning, 1);
  });

  await check("a Discord failure on one alert does not stop the next", async () => {
    let n = 0;
    const q = createAlertQueue({ run: async () => "ok", split: (t) => [t], log: silent });
    const bad = fakeMsg({ id: "bad", startThread: async () => { throw new Error("Missing Permissions"); } });
    const good = fakeMsg({ id: "good" }); good.thread.send = async () => { n++; };
    q.enqueue(bad); q.enqueue(good); await q.idle();
    assert.strictEqual(n, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
