/**
 * Paperclip — the end of the escalation chain comes from the router's
 * `escalation_policy`, never from env (slashbin-ai-team#176, engineering-manager#2688).
 * PAPERCLIP_ESCALATE_TO named a retired seat; the router now ends the chain at a
 * person, and the bot asks it. Fake board and fake router only: nothing leaves the process.
 */
import assert from "node:assert";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { createPaperclipPoller, parseEscalateTo } = require("../lib/paperclip");
const { processEscalateClient, escalationTerminal, openHandUps } = require("../lib/process-escalate");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const MIN = 60000;
const SUSAN = { kind: "user", userId: "user-susan", name: "Susan" };

/** The router's fetch: initialize, then tools/call; escalation_policy answers `terminal`, or fails. */
function routerFetch(state) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const reply = (result) => ({ ok: true, status: 200, headers: { get: () => "s1" }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    if (body.method === "notifications/initialized") return { ok: true, status: 202, headers: { get: () => null }, text: async () => "" };
    if (body.method === "initialize") return reply({});
    state.tools.push(body.params.name);
    if (state.fails) return { ok: false, status: 500, headers: { get: () => null }, text: async () => "boom" };
    return reply({ content: [{ type: "text", text: JSON.stringify({ chain: { source: "paperclip.reportsTo", terminal: state.terminal } }) }] });
  };
}
const client = (state) => processEscalateClient({ url: "http://127.0.0.1:1/mcp", bearer: "b", agentKey: "k", fetch: routerFetch(state) });

/** A stalled seat with a stuck queued card; the board records the cards created. */
function stalledBoard({ escalate, escalateTo = null, refusePerson = false }) {
  const s = { now: Date.parse("2026-11-23T12:00:00Z"), created: [], warns: [] };
  const log = { ...silent, warn: (o, m) => s.warns.push(String(m ?? o)), child() { return log; } };
  const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: "agent-1", name: "Bot", companyId: "co-1", status: "idle" });
    if (path === "/companies/co-1/agents") return ok([{ id: "agent-nova", name: "Nova" }]);
    if (path === "/companies/co-1/issues" && init.method === "POST") {
      const b = JSON.parse(init.body);
      if (refusePerson && b.assigneeUserId) return { ok: false, status: 403, text: async () => "no" };
      s.created.push(b); return ok({ id: "new-1", identifier: "T-9" });
    }
    if (path.startsWith("/companies/co-1/heartbeat-runs")) return ok([{ id: "q1", status: "queued", createdAt: new Date(s.now - 25 * MIN).toISOString(), contextSnapshot: { issueId: "i-1" } }]);
    if (path === "/issues/i-1") return ok({ id: "i-1", identifier: "T-2", title: "Waiting" });
    if (path.startsWith("/companies/co-1") || path === "/agents/me/inbox-lite") return ok([]);
    return { ok: false, status: 404, text: async () => "" };
  };
  const poller = createPaperclipPoller({ url: "https://board.test", apiKey: "k", stateFile: join(mkdtempSync(join(tmpdir(), "term-")), "s.json"), log, fetch,
    escalate, escalateTo, stallCard: true, stallMinutes: 15, stallCheckMs: 5 * MIN, clock: () => s.now, onSeatStalled: async () => {} });
  return { s, tick: () => poller.tick() };
}
const NOVA_ENV = parseEscalateTo("agent:Nova");

(async () => {
  await check("escalationTerminal reads the person the router's chain ends at", async () => {
    const st = { terminal: SUSAN, tools: [] };
    assert.deepStrictEqual(await escalationTerminal(client(st)), { userId: "user-susan", name: "Susan" });
    assert.deepStrictEqual(st.tools, ["escalation_policy"]);
  });

  await check("a failed read, a board_operator terminal, a null one and no client are all null; nothing throws", async () => {
    assert.strictEqual(await escalationTerminal(client({ fails: true, terminal: SUSAN, tools: [] })), null);
    assert.strictEqual(await escalationTerminal(client({ terminal: { kind: "board_operator", userId: "ray" }, tools: [] })), null);
    assert.strictEqual(await escalationTerminal(client({ terminal: null, tools: [] })), null);
    assert.strictEqual(await escalationTerminal(null), null);
  });

  await check("record_resolution closes the latest hand-up, as record_answer does", () => {
    const hops = [{ operation: "hand_up", to: "a" }, { operation: "hand_up", to: "user-susan" }, { operation: "record_resolution" }];
    assert.deepStrictEqual(openHandUps(hops).map((h) => h.to), ["a"]);
  });

  await check("the stall card goes to the router's terminal person, once per stretch, never to the env seat", async () => {
    const b = stalledBoard({ escalate: client({ terminal: SUSAN, tools: [] }), escalateTo: NOVA_ENV });
    await b.tick(); b.s.now += 10 * MIN; await b.tick();
    assert.strictEqual(b.s.created.length, 1);
    assert.strictEqual(b.s.created[0].assigneeUserId, "user-susan");
    assert.ok(!b.s.created[0].assigneeAgentId);
  });

  await check("a failed read or a board_operator terminal opens no card: Discord only, no env fallback", async () => {
    for (const st of [{ fails: true, terminal: SUSAN, tools: [] }, { terminal: { kind: "board_operator", userId: "ray" }, tools: [] }]) {
      const b = stalledBoard({ escalate: client(st), escalateTo: NOVA_ENV });
      await b.tick();
      assert.strictEqual(b.s.created.length, 0);
      assert.ok(b.s.warns.some((w) => /Discord only/.test(w)), `warns ${b.s.warns}`);
    }
  });

  await check("the board refusing a card for a person: no card, no seat fallback", async () => {
    const b = stalledBoard({ escalate: client({ terminal: SUSAN, tools: [] }), escalateTo: NOVA_ENV, refusePerson: true });
    await b.tick(); b.s.now += 10 * MIN; await b.tick();
    assert.strictEqual(b.s.created.length, 0);
    assert.strictEqual(b.s.warns.filter((w) => /Discord only/.test(w)).length, 1);
  });

  await check("no router client: the env escalateTo still takes the card", async () => {
    const b = stalledBoard({ escalate: null, escalateTo: NOVA_ENV });
    await b.tick();
    assert.strictEqual(b.s.created[0]?.assigneeAgentId, "agent-nova");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
