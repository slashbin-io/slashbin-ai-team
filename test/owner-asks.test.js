/**
 * Asks to a person: announced once on Discord, answered by a bare yes/no there
 * (lib/owner-asks.js, and the poller's scan and relay in lib/paperclip.js).
 */
const assert = require("assert");
const { readFileSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { idsIn, classifyReply, createOwnerAsks, announceAsk, answerAsk, routeReply, replyContext, whichMessage, sectionOf, RELAYED_MARK, ASK_OPERATION, ASK_CARD_FIELD, ASK_CARD_IDENTIFIER_FIELD } = require("../lib/owner-asks");
const { createPaperclipPoller, askOf, buildTaskPrompt } = require("../lib/paperclip");

const bot = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const dir = () => mkdtempSync(join(tmpdir(), "owner-asks-"));
const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };
const CH = "123456789012345678";
const OWNER = "9000000000000001", COWORKER = "9000000000000002";
const ASK = (n, extra = {}) => ({ ownerCardId: `own-${n}`, ownerCardIdentifier: `R-${n}`, cardIdentifier: `T-${n}`, issueId: `iss-${n}`, marker: `m${n}`,
  decision: `Approve change ${n}?`, recommendation: `ship change ${n} to production`, link: `https://board.example.com/T/issues/R-${n}`, ...extra });
const fresh = () => createOwnerAsks({ file: join(dir(), "owner-asks.json") });
async function post(registry, n, id) {
  const sent = [];
  const r = await announceAsk({ registry, ask: ASK(n), channelId: CH, answerers: [OWNER], send: async (t) => { sent.push(t); return { id }; } });
  return { ...r, sent };
}

(async () => {
  await check("yes and no are recognised bare, with punctuation, case and a leading mention; stop is neither", () => {
    for (const t of ["yes", "Yes.", "YEP!", "go ahead", "<@123456789012345678> proceed", "Approved", "do it", "ship it!", "y", "go"]) assert.strictEqual(classifyReply(t), "yes", t);
    for (const t of ["no", "No.", "n", "hold", "don't", "Don’t!"]) assert.strictEqual(classifyReply(t), "no", t);
    for (const t of ["stop", "yes but only the first", "maybe", "", "what are you asking?", "go to the store"]) assert.strictEqual(classifyReply(t), null, t);
  });

  await check("an ask is posted once and bound; the same ask seen again, even after a restart, posts nothing", async () => {
    const file = join(dir(), "owner-asks.json");
    const a = createOwnerAsks({ file });
    const first = await announceAsk({ registry: a, ask: ASK(1), board: null, channelId: CH, send: async () => ({ id: "m-1" }) });
    assert.strictEqual(first.posted, true);
    const b = first.binding;
    assert.deepStrictEqual([b.discordMessageId, b.channelId, b.cardIdentifier, b.issueId, b.ownerCardId, b.state], ["m-1", CH, "T-1", "iss-1", "own-1", "open"]);
    assert.ok(b.createdAt && b.marker === "m1" && b.yesAction === "ship change 1 to production");
    let sends = 0;
    for (const reg of [a, createOwnerAsks({ file })]) {
      const again = await announceAsk({ registry: reg, ask: ASK(1), board: null, channelId: CH, send: async () => { sends++; return { id: "m-x" }; } });
      assert.strictEqual(again.posted, false);
    }
    assert.strictEqual(sends, 0);
    assert.strictEqual(createOwnerAsks({ file }).all().length, 1);
  });

  await check("a post that failed is retried, not lost; the posted text states the ask and what a yes does", async () => {
    const r = fresh();
    await assert.rejects(announceAsk({ registry: r, ask: ASK(1), channelId: CH, send: async () => { throw new Error("discord down"); } }));
    assert.strictEqual(r.get(r.keyOf(null, "own-1")).discordMessageId, null);
    const { sent, posted } = await post(r, 1, "m-1");
    assert.strictEqual(posted, true);
    assert.match(sent[0], /Approve change 1\?/);
    assert.match(sent[0], /If you say yes: ship change 1 to production/);
    assert.match(sent[0], /Reply to this message with yes or no/);
  });

  await check("a yes replying to a bound ask resolves that ask, even with several open", async () => {
    const r = fresh(); await post(r, 1, "m-1"); await post(r, 2, "m-2");
    const route = routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "m-2", userId: OWNER });
    assert.strictEqual(route.kind, "resolve");
    assert.strictEqual(route.binding.cardIdentifier, "T-2");
    assert.strictEqual(route.verdict, "yes");
  });

  await check("a bare yes with exactly one open ask resolves it", async () => {
    const r = fresh(); await post(r, 1, "m-1");
    const route = routeReply({ registry: r, channelId: CH, text: "Proceed.", referenceId: null, userId: OWNER });
    assert.strictEqual(route.kind, "resolve");
    assert.strictEqual(route.binding.cardIdentifier, "T-1");
  });

  await check("a bare yes with two open asks names them and resolves neither", async () => {
    const r = fresh(); await post(r, 1, "m-1"); await post(r, 2, "m-2");
    const route = routeReply({ registry: r, channelId: CH, text: "yes", referenceId: null, userId: OWNER });
    assert.strictEqual(route.kind, "which");
    const text = whichMessage(route.open);
    assert.match(text, /Approve change 1\?/); assert.match(text, /Approve change 2\?/);
    assert.ok(r.open(CH).length === 2);
  });

  await check("a bare yes with 115 open asks gets a reply Discord accepts (under 2000 chars) naming the newest", async () => {
    const r = fresh(); for (let i = 1; i <= 115; i++) await post(r, i, `m-${i}`);
    const route = routeReply({ registry: r, channelId: CH, text: "yes", referenceId: null, userId: OWNER });
    assert.strictEqual(route.kind, "which");
    const text = whichMessage(route.open);
    assert.ok(text.length <= 2000, `which message is ${text.length} chars`);
    assert.match(text, /Approve change 115\?/); assert.match(text, /110 older/);
    assert.doesNotMatch(text, /Approve change 1\?/);
  });

  await check("a bare yes with nothing open, or in another channel, is left to the model", async () => {
    const r = fresh(); await post(r, 1, "m-1");
    assert.strictEqual(routeReply({ registry: r, channelId: "2234567890123456", text: "yes", userId: OWNER }).kind, "none");
    assert.strictEqual(routeReply({ registry: fresh(), channelId: CH, text: "yes", userId: OWNER }).kind, "none");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "unrelated", userId: OWNER }).kind, "none");
  });

  await check("no resolves with a no verdict, relays it, marks the ask answered, and a repeat is not guessed onto another ask", async () => {
    const r = fresh(); const { binding } = await post(r, 1, "m-1");
    const calls = [];
    const relays = { default: async (b, verdict, o) => { calls.push([b.issueId, verdict, o.text]); return { woke: true }; } };
    const route = routeReply({ registry: r, channelId: CH, text: "No", referenceId: "m-1", userId: OWNER });
    assert.strictEqual(route.verdict, "no");
    const out = await answerAsk({ registry: r, binding: route.binding, verdict: "no", text: "No", relays, by: { id: OWNER, tag: "owner" } });
    assert.strictEqual(out.ok, true);
    assert.match(out.reply, /Recorded: no/);
    assert.deepStrictEqual(calls, [["iss-1", "no", "No"]]);
    assert.strictEqual(r.get(binding.key).state, "answered");
    assert.strictEqual(r.get(binding.key).answer.verdict, "no");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "m-1", userId: OWNER }).kind, "closed");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", userId: OWNER }).kind, "none");
  });

  await check("a relay that fails leaves the ask open and says nothing was recorded", async () => {
    const r = fresh(); const { binding } = await post(r, 1, "m-1");
    const out = await answerAsk({ registry: r, binding, verdict: "yes", text: "yes", by: { id: OWNER }, relays: { default: async () => { throw new Error("HTTP 500 secret-ish detail"); } } });
    assert.strictEqual(out.ok, false);
    assert.doesNotMatch(out.reply, /500|secret/);
    assert.strictEqual(r.get(binding.key).state, "open");
  });

  await check("reply context carries the replied-to words, and the ask's card and what a yes does", async () => {
    const r = fresh(); const { binding } = await post(r, 1, "m-1");
    const route = routeReply({ registry: r, channelId: CH, text: "what is the risk?", referenceId: "m-1", userId: OWNER });
    assert.strictEqual(route.kind, "context");
    const withAsk = replyContext({ author: "bot", content: "Decision needed: Approve change 1?", binding: route.binding });
    assert.match(withAsk, /reply to bot's message: "Decision needed: Approve change 1\?"/);
    assert.match(withAsk, /T-1/); assert.match(withAsk, /A yes would: ship change 1 to production/);
    const plain = replyContext({ author: "owner", content: "see the doc" });
    assert.match(plain, /reply to owner's message: "see the doc"/);
    assert.doesNotMatch(plain, /open ask/);
    assert.match(bot, /replied = await msg\.fetchReference\(\)/);
    assert.match(bot, /runClaude\(runPrompt,/);
  });

  // --- the poller's half: notice the ask, relay the answer ---
  const ME = { id: "agent-1", name: "Bot", companyId: "co-1" };
  const record = { card: "iss-1", hops: [{ from: ME.id, to: "user-1", operation: ASK_OPERATION, idempotencyKey: "k1", [ASK_CARD_FIELD]: "own-1" }], [ASK_CARD_FIELD]: "own-1", [ASK_CARD_IDENTIFIER_FIELD]: "R-1" };
  const marker = `<!-- process.escalate:${Buffer.from(JSON.stringify(record)).toString("base64url")} -->`;
  const ownerDescription = ["Decision needed for T-1.", "", "**Decision**", "> Approve the rollout?", "", "**Recommendation**", "> roll out to all stores", "", "Answer with a comment."].join("\n");
  function board(overrides = {}) {
    const writes = [], gets = [];
    const routes = {
      "GET /agents/me": ME,
      "GET /agents/me/inbox-lite": [{ id: "iss-1", status: "blocked", assigneeAgentId: ME.id, updatedAt: "2026-10-21T00:00:00Z" }],
      "GET /companies/co-1/issues?assigneeAgentId=agent-1&status=in_review": [],
      "GET /issues/iss-1/comments": [{ id: "c1", authorAgentId: ME.id, body: marker, createdAt: "2026-10-21T00:00:00Z", createdByRunId: "run-9" }],
      "GET /issues/iss-1": { id: "iss-1", identifier: "T-1", title: "Rollout", assigneeAgentId: ME.id, status: "blocked" },
      "GET /issues/own-1": { id: "own-1", identifier: "R-1", status: "todo", description: ownerDescription },
      ...overrides,
    };
    const fetch = async (url, init) => {
      const key = `${init.method} ${url.replace(/^.*\/api/, "")}`;
      if (init.method !== "GET") { writes.push({ key, body: init.body ? JSON.parse(init.body) : null }); return { ok: true, text: async () => "{}" }; }
      gets.push(key);
      if (!(key in routes)) return { ok: false, status: 404, text: async () => "nf" };
      return { ok: true, text: async () => JSON.stringify(routes[key]) };
    };
    return { fetch, writes, gets, routes };
  }
  const poller = (b, extra) => createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile: join(dir(), "p.json"), log: silent, fetch: b.fetch,
    answer: async () => "", watchMs: 1e9, stallMinutes: 0, ...extra });

  await check("the poller hands an open request to onOwnerAsk with the decision and recommendation read off the person's card, once per poll while unchanged", async () => {
    const b = board(); const seen = [];
    const p = poller(b, { onOwnerAsk: async (a) => { seen.push(a); return true; } });
    await p.tick(); await p.tick();
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual([seen[0].issueId, seen[0].cardIdentifier, seen[0].ownerCardId, seen[0].runId, seen[0].marker], ["iss-1", "T-1", "own-1", "run-9", "k1"]);
    assert.strictEqual(seen[0].decision, "Approve the rollout?");
    assert.strictEqual(seen[0].recommendation, "roll out to all stores");
  });

  await check("no ask is raised once the person's card is done, or when the latest hop is not the request", async () => {
    const done = board({ "GET /issues/own-1": { id: "own-1", status: "done", description: ownerDescription } });
    const seen = [];
    await poller(done, { onOwnerAsk: async (a) => { seen.push(a); return true; } }).tick();
    const back = JSON.stringify({ ...record, hops: [...record.hops, { from: ME.id, to: ME.id, operation: "record_answer", idempotencyKey: "k2" }], ownerCard: undefined });
    const moved = board({ "GET /issues/iss-1/comments": [{ id: "c1", authorAgentId: ME.id, body: `<!-- process.escalate:${Buffer.from(back).toString("base64url")} -->`, createdAt: "2026-10-21T00:00:00Z" }] });
    await poller(moved, { onOwnerAsk: async (a) => { seen.push(a); return true; } }).tick();
    assert.strictEqual(seen.length, 0);
  });

  await check("a relayed answer is recorded on the seat's card as its newest ask, the person's card closed, the seat's card reopened; steps are not repeated on retry", async () => {
    const b = board();
    const p = poller(b, {});
    const binding = { key: "default:own-1", issueId: "iss-1", ownerCardId: "own-1", ownerCardIdentifier: "R-1", yesAction: "roll out to all stores", steps: {} };
    let saves = 0;
    const out = await p.relayOwnerAnswer(binding, "yes", { text: "yes", link: "https://discord.example/x", by: { id: OWNER, tag: "owner" }, save: () => saves++ });
    assert.strictEqual(out.woke, true);
    assert.deepStrictEqual(b.writes.map((w) => w.key), ["POST /issues/iss-1/comments", "PATCH /issues/own-1", "PATCH /issues/iss-1"]);
    assert.ok(b.writes[0].body.body.startsWith(RELAYED_MARK));
    assert.match(b.writes[0].body.body, /by owner \(Discord user 9000000000000001\)/);
    assert.match(b.writes[0].body.body, /Yes\. Go ahead: roll out to all stores/);
    assert.deepStrictEqual([b.writes[1].body, b.writes[2].body], [{ status: "done" }, { status: "todo" }]);
    await p.relayOwnerAnswer(binding, "yes", { text: "yes", save: () => saves++ });
    assert.strictEqual(b.writes.length, 3);
    assert.strictEqual(saves, 3);
  });

  await check("a relayed answer counts as the card's ask, and the woken seat is told who answered", () => {
    const comments = [
      { id: "c0", authorUserId: "u", body: "please decide", createdAt: "2026-10-21T00:00:00Z" },
      { id: "c1", authorAgentId: ME.id, body: "I need a decision", createdAt: "2026-10-21T01:00:00Z" },
      { id: "c2", authorAgentId: ME.id, body: `${RELAYED_MARK}\nYes. Go ahead.`, createdAt: "2026-10-22T00:00:00Z" },
    ];
    assert.strictEqual(askOf(comments, ME.id).id, "c2");
    const prompt = buildTaskPrompt({ identifier: "T-1", title: "Rollout", description: "" }, comments, ME, "https://board.example.com");
    assert.match(prompt, /The person you asked, answering on Discord/);
  });

  await check("the answer failing to wake the card is reported as such, not as an unrecorded answer", async () => {
    const b = board(); const inner = b.fetch;
    b.fetch = async (url, init) => (init.method === "PATCH" ? { ok: false, status: 403, text: async () => "{}" } : inner(url, init));
    const p = poller(b, {});
    const out = await p.relayOwnerAnswer({ key: "k", issueId: "iss-1", ownerCardId: "own-1", yesAction: "x", steps: {} }, "yes", { text: "yes", save() {} });
    assert.strictEqual(out.woke, false);
  });

  await check("S1: a coworker's bare yes, or reply to the announcement, leaves the ask open and both cards untouched; the owner's answer records who gave it", async () => {
    const r = fresh(); const { binding } = await post(r, 1, "m-1");
    const writes = [];
    const relays = { default: async (b, v, o) => { writes.push([b.issueId, v, o.by]); return { woke: true }; } };
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", userId: COWORKER }).kind, "none");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "m-1", userId: COWORKER }).kind, "none");
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", referenceId: "m-1" }).kind, "none");
    // Even if a caller hands the binding straight to answerAsk, the sender is checked again.
    const out = await answerAsk({ registry: r, binding, verdict: "yes", text: "yes", relays, by: { id: COWORKER, tag: "cw" } });
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(writes, []);
    assert.strictEqual(r.get(binding.key).state, "open");
    assert.strictEqual(r.get(binding.key).answer, undefined);
    const mine = routeReply({ registry: r, channelId: CH, text: "yes", userId: OWNER });
    assert.strictEqual(mine.kind, "resolve");
    await answerAsk({ registry: r, binding: mine.binding, verdict: "yes", text: "yes", relays, by: { id: OWNER, tag: "owner" } });
    assert.deepStrictEqual(writes, [["iss-1", "yes", { id: OWNER, tag: "owner" }]]);
    assert.deepStrictEqual(r.get(binding.key).answer.by, { id: OWNER, tag: "owner" });
  });

  await check("S1: an ask with no recorded answerer can be answered by no one; two asks to different people do not make a bare yes ambiguous for either", async () => {
    const r = fresh();
    await announceAsk({ registry: r, ask: ASK(1), channelId: CH, send: async () => ({ id: "m-1" }) });
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", userId: OWNER }).kind, "none");
    await announceAsk({ registry: r, ask: ASK(2), channelId: CH, answerers: [COWORKER], send: async () => ({ id: "m-2" }) });
    assert.strictEqual(routeReply({ registry: r, channelId: CH, text: "yes", userId: COWORKER }).binding.cardIdentifier, "T-2");
    assert.deepStrictEqual(idsIn("<@9000000000000001> <@!9000000000000002>"), [OWNER, COWORKER]);
    assert.deepStrictEqual(idsIn(""), []);
  });

  await check("S2: the gate admits only the asked person's answer in the announcement channel, even unmonitored and without a mention", () => {
    const gate = bot.indexOf("const isAskAnswer");
    assert.ok(gate > 0, "bot.js computes isAskAnswer");
    const block = bot.slice(gate, gate + 600);
    assert.match(block, /!msg\.author\.bot && OWNER_ASKS/);
    assert.match(block, /userId: msg\.author\.id/);
    assert.match(block, /kind !== "none"/);
    assert.match(bot, /!isDM && !isMentioned && !isMonitored && !isAskAnswer\) return/);
    // what it admits: routeReply says "none" for everything but the asked person's answer or reply
    const r = fresh();
    return post(r, 1, "m-1").then(() => {
      const kind = (o) => routeReply({ registry: r, channelId: CH, ...o }).kind;
      assert.strictEqual(kind({ text: "yes", userId: OWNER }), "resolve");
      assert.strictEqual(kind({ text: "so what do you think?", referenceId: "m-1", userId: OWNER }), "context");
      assert.strictEqual(kind({ text: "yes", userId: COWORKER }), "none");
      assert.strictEqual(kind({ text: "hello there", userId: OWNER }), "none");
      assert.strictEqual(routeReply({ registry: r, channelId: "2234567890123456", text: "yes", userId: OWNER }).kind, "none");
    });
  });

  await check("S2: a reply routed to a connected agent carries the replied-to words and the bound-ask context", () => {
    const src = bot.match(/function routeToAgents\([\s\S]*?\n\}\n/)[0];
    const sentWs = [];
    const connectedAgents = new Map([["a1", { channels: { listen: [CH] }, ws: { send: (m) => sentWs.push(JSON.parse(m)) } }]]);
    const routeToAgents = new Function("connectedAgents", "log", `${src}; return routeToAgents;`)(connectedAgents, silent);
    const msg = { channel: { id: CH }, author: { id: OWNER, username: "owner" }, id: "d1", attachments: { map: () => [] } };
    const runPrompt = `${replyContext({ author: "bot", content: "Please approve the rollout", binding: { cardIdentifier: "T-1", decision: "Approve?", yesAction: "ship" } })}\n\nyes`;
    assert.strictEqual(routeToAgents(msg, runPrompt, { messageId: "m-1", author: "bot", content: "Please approve the rollout" }), true);
    assert.match(sentWs[0].text, /Please approve the rollout/);
    assert.match(sentWs[0].text, /open ask for a decision on T-1/);
    assert.strictEqual(sentWs[0].replyTo.content, "Please approve the rollout");
    assert.match(bot, /routeToAgents\(msg, runPrompt, replied \?/);
  });

  await check("S3: an ask that could not be announced is tried again after OWNER_SCAN_MS, not cached for the life of the process", async () => {
    const b = board(); let now = 1e6; const calls = [];
    const p = poller(b, { clock: () => now, onOwnerAsk: async (a) => { calls.push(a.ownerCardId); return calls.length > 1; } });
    await p.tick(); assert.strictEqual(calls.length, 1);
    await p.tick(); assert.strictEqual(calls.length, 1, "not retried within the window");
    now += 301000;
    await p.tick(); assert.strictEqual(calls.length, 2, "retried once the window passed");
    now += 301000;
    await p.tick(); assert.strictEqual(calls.length, 2, "accepted, so never announced again");
  });

  // The ask kept on the seat's own card: the hop names no person's card, the question is the marker comment itself.
  const originRecord = (key) => ({ card: "iss-1", hops: [{ from: ME.id, to: "user-1", operation: ASK_OPERATION, idempotencyKey: key, at: "2026-10-21T00:00:00Z" }] });
  const originMarker = (key) => `<!-- process.escalate:${Buffer.from(JSON.stringify(originRecord(key))).toString("base64url")} -->\n\n**Decision**\n> Approve the rollout?\n\n**Recommendation**\n> roll out to all stores`;
  const originBoard = (key) => board({ "GET /issues/iss-1/comments": [{ id: "c1", authorAgentId: ME.id, body: originMarker(key), createdAt: "2026-10-21T00:00:00Z", createdByRunId: "run-9" }] });

  await check("an ask with no person's card is announced as bound to the origin card, the question read off the marker comment", async () => {
    const b = originBoard("k1"); const seen = [];
    const p = poller(b, { onOwnerAsk: async (a) => { seen.push(a); return true; } });
    await p.tick(); await p.tick();
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual([seen[0].issueId, seen[0].ownerCardId, seen[0].onOrigin, seen[0].marker], ["iss-1", "iss-1", true, "k1"]);
    assert.strictEqual(seen[0].decision, "Approve the rollout?");
    assert.strictEqual(seen[0].recommendation, "roll out to all stores");
    assert.ok(!b.gets.includes("GET /issues/own-1"), "a person's card was read");
  });

  await check("an ask naming a confirmation links to that decision on the card; one with none links to the card", async () => {
    const rec = { ...originRecord("k1"), askInteraction: "int-1" };
    const body = `<!-- process.escalate:${Buffer.from(JSON.stringify(rec)).toString("base64url")} -->\n\n**Decision**\n> Approve the rollout?`;
    const withIt = board({ "GET /issues/iss-1/comments": [{ id: "c1", authorAgentId: ME.id, body, createdAt: "2026-10-21T00:00:00Z" }], "GET /issues/iss-1/interactions": [{ id: "int-1", kind: "request_confirmation", status: "pending" }] });
    const seen = [];
    await poller(withIt, { onOwnerAsk: async (a) => { seen.push(a); return true; } }).tick();
    assert.strictEqual(seen[0].link, "https://board.example.com/T/issues/T-1#interaction-int-1");
    const none = originBoard("k2"); const seen2 = [];
    await poller(none, { onOwnerAsk: async (a) => { seen2.push(a); return true; } }).tick();
    assert.strictEqual(seen2[0].link, "https://board.example.com/T/issues/T-1");
  });

  await check("an origin-bound ask is not announced once the card is done, or when a later hop moved on", async () => {
    const seen = [];
    await poller(board({ ...originBoard("k1").routes, "GET /issues/iss-1": { id: "iss-1", identifier: "T-1", assigneeAgentId: ME.id, status: "done" } }), { onOwnerAsk: async (a) => { seen.push(a); return true; } }).tick();
    assert.strictEqual(seen.length, 0);
  });

  await check("a second ask on the same origin card is a new ask: bound under its own key, announced again", async () => {
    const r = fresh(); const sent = [];
    const ask = (key) => ({ ...ASK(1), ownerCardId: "iss-1", onOrigin: true, dedupeId: `iss-1:${key}`, marker: key });
    const send = async (t) => { sent.push(t); return { id: `m-${sent.length}` }; };
    await announceAsk({ registry: r, ask: ask("k1"), channelId: CH, answerers: [OWNER], send });
    await announceAsk({ registry: r, ask: ask("k1"), channelId: CH, answerers: [OWNER], send });
    assert.strictEqual(sent.length, 1, "the same ask was posted twice");
    const second = await announceAsk({ registry: r, ask: ask("k2"), channelId: CH, answerers: [OWNER], send });
    assert.strictEqual(second.posted, true);
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(second.binding.onOrigin, true);
    // A legacy ask is still keyed by its person's card.
    assert.strictEqual((await announceAsk({ registry: r, ask: ASK(3), channelId: CH, answerers: [OWNER], send })).binding.key, "default:own-3");
  });

  await check("a yes on an origin-bound ask is relayed as the answer comment on the origin, with no person's card to close; the card is woken once", async () => {
    const b = board();
    const p = poller(b, {});
    const binding = { key: "default:iss-1:k1", issueId: "iss-1", ownerCardId: "iss-1", onOrigin: true, yesAction: "roll out to all stores", steps: {} };
    const out = await p.relayOwnerAnswer(binding, "yes", { text: "yes", by: { id: OWNER, tag: "owner" }, save() {} });
    assert.strictEqual(out.woke, true);
    assert.deepStrictEqual(b.writes.map((w) => w.key), ["POST /issues/iss-1/comments", "PATCH /issues/iss-1"]);
    assert.ok(b.writes[0].body.body.startsWith(RELAYED_MARK));
    assert.deepStrictEqual(b.writes[1].body, { status: "todo" });
  });

  // slashbin_mcp_services#597: the ask's record names a pending request_confirmation on the origin.
  // The person's verified Discord answer resolves it as them, with the owner key, before the relay comment.
  const confirmRecord = (key, extra = {}) => ({ card: "iss-1", hops: [{ from: ME.id, to: "user-1", operation: ASK_OPERATION, idempotencyKey: key, at: "2026-10-21T00:00:00Z" }], askInteraction: "int-1", ...extra });
  const confirmMarker = (rec) => `<!-- process.escalate:${Buffer.from(JSON.stringify(rec)).toString("base64url")} -->\n\n**Decision**\n> Approve the rollout?`;
  function confirmBoard({ rec = confirmRecord("k1"), interaction = { id: "int-1", kind: "request_confirmation", status: "pending" }, keyUser = "user-1", acceptFails = null } = {}) {
    const writes = [], gets = [];
    const routes = {
      "GET /agents/me": ME,
      "GET /issues/iss-1": { id: "iss-1", identifier: "T-1", assigneeAgentId: ME.id, status: "blocked" },
      "GET /issues/iss-1/comments": [{ id: "c1", authorAgentId: ME.id, body: confirmMarker(rec), createdAt: "2026-10-21T00:00:00Z" }],
      "GET /issues/iss-1/interactions": [interaction],
      "GET /cli-auth/me": { userId: keyUser },
    };
    const fetch = async (url, init) => {
      const key = `${init.method} ${url.replace(/^.*\/api/, "")}`;
      const auth = init.headers?.Authorization ?? init.headers?.authorization;
      if (init.method !== "GET") {
        writes.push({ key, auth, body: init.body ? JSON.parse(init.body) : null });
        if (acceptFails && key.endsWith(acceptFails.path)) { acceptFails.after?.(routes); return { ok: false, status: 409, text: async () => "conflict" }; }
        return { ok: true, text: async () => "{}" };
      }
      gets.push({ key, auth });
      if (!(key in routes)) return { ok: false, status: 404, text: async () => "nf" };
      return { ok: true, text: async () => JSON.stringify(routes[key]) };
    };
    return { fetch, writes, gets, routes };
  }
  const originBinding = () => ({ key: "default:iss-1:k1", issueId: "iss-1", ownerCardId: "iss-1", onOrigin: true, marker: "k1", cardIdentifier: "T-1", yesAction: "roll out", steps: {} });

  await check("#597: a Discord yes accepts the pending confirmation with the owner key, checked to be the person asked, before the relay comment", async () => {
    const b = confirmBoard();
    const p = poller(b, { ownerKey: "owner-key" });
    const out = await p.relayOwnerAnswer(originBinding(), "yes", { text: "yes", by: { id: OWNER }, save() {} });
    assert.strictEqual(out.woke, true);
    assert.deepStrictEqual(b.writes.map((w) => w.key), ["POST /issues/iss-1/interactions/int-1/accept", "POST /issues/iss-1/comments", "PATCH /issues/iss-1"]);
    assert.strictEqual(b.writes[0].auth, "Bearer owner-key");
    assert.strictEqual(b.writes[1].auth, "Bearer k", "the relay comment left the seat's key");
    assert.ok(b.gets.some((g) => g.key === "GET /cli-auth/me" && g.auth === "Bearer owner-key"), "the key's user was not checked");
  });

  await check("#597: a Discord no rejects it, with his words as the reason", async () => {
    const b = confirmBoard();
    await poller(b, { ownerKey: "owner-key" }).relayOwnerAnswer(originBinding(), "no", { text: "no, hold it", by: { id: OWNER }, save() {} });
    assert.strictEqual(b.writes[0].key, "POST /issues/iss-1/interactions/int-1/reject");
    assert.match(b.writes[0].body.reason, /no, hold it/);
  });

  await check("#597: an owner key that is not the person asked writes nothing and tells him to answer on the card", async () => {
    const b = confirmBoard({ keyUser: "someone-else" });
    await assert.rejects(poller(b, { ownerKey: "owner-key" }).relayOwnerAnswer(originBinding(), "yes", { text: "yes", by: { id: OWNER }, save() {} }),
      (e) => /not yours/.test(e.ownerReply) && /T-1/.test(e.ownerReply));
    assert.deepStrictEqual(b.writes, []);
  });

  await check("#597: with no owner key, nothing is written and Discord says to answer on the card (answerAsk returns that reply)", async () => {
    const b = confirmBoard();
    const p = poller(b, {});
    const r = fresh();
    const { binding } = await announceAsk({ registry: r, ask: { ...ASK(1), ...originBinding(), dedupeId: "iss-1:k1" }, channelId: CH, answerers: [OWNER], send: async () => ({ id: "m-1" }) });
    const out = await answerAsk({ registry: r, binding, verdict: "yes", text: "yes", by: { id: OWNER }, relays: { default: p.relayOwnerAnswer } });
    assert.strictEqual(out.ok, false);
    assert.match(out.reply, /Answer on the card instead/);
    assert.deepStrictEqual(b.writes, []);
    assert.strictEqual(r.get(binding.key).state, "open");
  });

  await check("#597: a confirmation he already accepted on the card is not resolved again; his card yes is relayed and the card woken so the holder continues", async () => {
    const b = confirmBoard({ interaction: { id: "int-1", kind: "request_confirmation", status: "accepted", resolvedByUserId: "user-1" } });
    const out = await poller(b, { ownerKey: "owner-key" }).relayOwnerAnswer(originBinding(), "yes", { text: "yes", by: { id: OWNER }, save() {} });
    assert.deepStrictEqual(b.writes.map((w) => w.key), ["POST /issues/iss-1/comments", "PATCH /issues/iss-1"]);
    assert.match(b.writes[0].body.body, /given on this card \(confirmation accepted\)/);
    assert.match(b.writes[0].body.body, /Yes\. Go ahead: roll out\./);
    assert.deepStrictEqual(out.standing, { status: "accepted", verdict: "yes" });
  });

  // Tech Lead S2 on #168 (R1-R3): his answer on the card wins; a conflicting Discord one is never relayed.
  const rejectedOnCard = { id: "int-1", kind: "request_confirmation", status: "rejected", resolvedByUserId: "user-1" };
  async function answerVia(b, binding = originBinding()) {
    const r = fresh();
    const { binding: bound } = await announceAsk({ registry: r, ask: { ...ASK(1), ...binding, dedupeId: "iss-1:k1" }, channelId: CH, answerers: [OWNER], send: async () => ({ id: "m-1" }) });
    const out = await answerAsk({ registry: r, binding: bound, verdict: "yes", text: "yes ship it", by: { id: OWNER }, relays: { default: poller(b, { ownerKey: "owner-key" }).relayOwnerAnswer } });
    return { out, saved: r.get(bound.key) };
  }

  const noGoAhead = (b) => b.writes.filter((w) => w.key === "POST /issues/iss-1/comments").forEach((w) => {
    assert.match(w.body.body, /No\. Do not go ahead/);
    assert.doesNotMatch(w.body.body, /Go ahead: |yes ship it/, "the losing Discord yes reached the relay");
  });

  await check("R1: a Discord yes that loses the race to his rejection on the card relays his no, saves no, and says his card answer stands", async () => {
    const b = confirmBoard({ acceptFails: { path: "/accept", after: (routes) => { routes["GET /issues/iss-1/interactions"] = [rejectedOnCard]; } } });
    const { out, saved } = await answerVia(b);
    assert.deepStrictEqual(b.writes.map((w) => w.key), ["POST /issues/iss-1/interactions/int-1/accept", "POST /issues/iss-1/comments", "PATCH /issues/iss-1"]);
    noGoAhead(b);
    assert.strictEqual(saved.answer.verdict, "no");
    assert.strictEqual(saved.state, "answered");
    assert.strictEqual(out.ok, false);
    assert.match(out.reply, /already answered no on the card/);
    assert.doesNotMatch(out.reply, /Recorded: yes/);
  });

  await check("R3: a confirmation already rejected on the card before the Discord yes is processed: his no is relayed, no saved yes, no go-ahead", async () => {
    const b = confirmBoard({ interaction: rejectedOnCard });
    const { out, saved } = await answerVia(b);
    assert.deepStrictEqual(b.writes.map((w) => w.key), ["POST /issues/iss-1/comments", "PATCH /issues/iss-1"]);
    noGoAhead(b);
    assert.strictEqual(saved.answer.verdict, "no");
    assert.match(out.reply, /not recorded/);
  });

  await check("R2: the only relay the task prompt can pick up is his card no; no Discord approval comment exists", async () => {
    const b = confirmBoard({ interaction: rejectedOnCard });
    await answerVia(b);
    noGoAhead(b);
    assert.ok(b.writes.every((w) => !/given on Discord/.test(w.body?.body ?? "")));
  });

  await check("a Discord yes on a card he already accepted is acknowledged as recorded, and the holder is woken onto it", async () => {
    const b = confirmBoard({ interaction: { id: "int-1", kind: "request_confirmation", status: "accepted", resolvedByUserId: "user-1" } });
    const { out, saved } = await answerVia(b);
    assert.strictEqual(out.ok, true);
    assert.match(out.reply, /Recorded: yes/);
    assert.strictEqual(saved.answer.verdict, "yes");
    assert.ok(b.writes.some((w) => w.key === "PATCH /issues/iss-1" && w.body.status === "todo"));
  });

  await check("a confirmation closed on the card by someone else is reported closed, with no verdict saved as his", async () => {
    const b = confirmBoard({ interaction: { id: "int-1", kind: "request_confirmation", status: "rejected", resolvedByUserId: "someone-else" } });
    const { out, saved } = await answerVia(b);
    assert.deepStrictEqual(b.writes, []);
    assert.strictEqual(saved.answer.verdict, null);
    assert.match(out.reply, /already closed on the card \(rejected\)/);
  });

  await check("pre-#597: an ask whose record names no confirmation is relayed exactly as before, owner key or not", async () => {
    const b = confirmBoard({ rec: confirmRecord("k1", { askInteraction: undefined }) });
    await poller(b, { ownerKey: "owner-key" }).relayOwnerAnswer(originBinding(), "yes", { text: "yes", by: { id: OWNER }, save() {} });
    assert.deepStrictEqual(b.writes.map((w) => w.key), ["POST /issues/iss-1/comments", "PATCH /issues/iss-1"]);
    assert.ok(!b.gets.some((g) => g.key === "GET /cli-auth/me"), "the owner key was used for a pre-#597 ask");
  });

  await check("the owner key is a connector key: withheld from every run, and handed only to the first board's poller", () => {
    assert.match(bot, /connectorKeys: \[\.\.\.boardKeyEnvs\(process\.env\), \.\.\.escalateBearer\(\), \.\.\.ownerKeyEnv\(\)\],/);
    assert.match(bot, /ownerKey: board\.id \? null : /);
  });

  await check("section parser and wiring", () => {
    assert.strictEqual(sectionOf(ownerDescription, "Decision"), "Approve the rollout?");
    assert.strictEqual(sectionOf(ownerDescription, "Evidence"), "");
    assert.match(bot, /onOwnerAsk: async \(ask\) =>/);
    assert.match(bot, /OWNER_RELAYS\[board\.id \?\? "default"\] = poller\.relayOwnerAnswer/);
  });

  await check("a failed open of the owner-ask state is retried with bounded backoff, recovery runs once on success", () => {
    const a = bot.indexOf("const OWNER_ASKS_RETRY_MS"), b = bot.indexOf("const PAPERCLIP_EVENTS =");
    assert.ok(a > -1 && b > a, "tryOpenOwnerAsks not found in bot.js");
    const src = bot.slice(a, b);
    assert.match(src, /OWNER_ASKS_RETRY_MS = \[5_000, 15_000, 60_000\]/);
    assert.match(src, /OWNER_ASKS_RETRY_REPEAT_MS = 300_000/);
    assert.match(src, /setTimeout\(/);
    // an open that returns false and one that throws both come back false, and both are retried
    assert.match(src, /if \(!\(await store\.open\(\)\)\) return false;/);
    assert.match(src, /catch \(err\) \{[\s\S]*?\n\s*return false;\n\s*\}/);
    assert.match(src, /still not readable; retrying/);
    assert.match(src, /announced on Discord again/);
    // recovery is started only inside the successful open, once per success, and each retry builds a fresh store
    assert.strictEqual((src.match(/recoverUnsentAsks\(/g) || []).length, 1);
    assert.ok(src.indexOf("recoverUnsentAsks(") > src.indexOf("store.open()"));
    assert.strictEqual((src.match(/createOwnerAskStore\(/g) || []).length, 1);
    // the old file is never touched here
    assert.ok(!/unlink|rename|rmSync|truncate|writeFileSync/.test(src));
    // the startup path awaits only the first attempt
    assert.match(bot, /await openOwnerAsks\(\);/);
  });

  await check("the pollers read the registry when they scan, so a later successful open turns announcements on, after recovery", async () => {
    // after the guard, both wait for startup recovery, so recovery and an announcement never race into a duplicate send
    for (const name of ["onOwnerAsk: async (ask)", "onGrantAsks: async (cards)"]) {
      const at = bot.indexOf(name);
      assert.ok(at > -1, `${name} not found`);
      const body = bot.slice(at, at + 700);
      assert.ok(body.indexOf("if (!OWNER_ASKS) return false;") > -1 && body.indexOf("await ownerAsksRecovery;") > body.indexOf("if (!OWNER_ASKS) return false;"), `${name} must read the registry, then wait for recovery`);
    }
    assert.ok(!/onOwnerAsk: OWNER_ASKS \?/.test(bot) && !/onGrantAsks: OWNER_ASKS \?/.test(bot), "a callback fixed at construction");
    // behaviour of that shape: a callback that reads the variable per call announces once it is set
    let REG = null, recovery = Promise.resolve(); const sent = [], order = [];
    const cb = async (a) => { if (!REG) return false; await recovery; sent.push(a); order.push("sent"); return true; };
    assert.strictEqual(await cb(1), false);
    REG = {}; let done; recovery = new Promise((r) => { done = r; });
    const pending = cb(2);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(sent, [], "nothing is sent while recovery is still running");
    order.push("recovered"); done();
    assert.strictEqual(await pending, true);
    assert.deepStrictEqual(order, ["recovered", "sent"]);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
