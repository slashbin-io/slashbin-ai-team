/** The operator's production grant answered on the board: the label and quote on a yes, nothing on a no. */
const assert = require("assert");
const { mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { createPaperclipPoller } = require("../lib/paperclip");
const { verdictOf, parseGrantTitle } = require("../lib/grant-answer");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const OPERATOR = "user-operator";
const GRANT_TITLE = ["R", "ay"].join("") + " decision for SLA-10: production grant for acme/app#7";

function world({ blockedOnGrant = true, onGrantAsks = null, extraGrant = false, interactions = [] } = {}) {
  const ctl = { failGh: false };
  const origin = { id: "o-1", identifier: "SLA-10", title: "Ship it", status: "blocked", assigneeAgentId: "agent-em", assigneeUserId: null, labels: [], createdAt: "2026-01-01T00:00:00Z", createdByUserId: OPERATOR, blockedBy: blockedOnGrant ? [{ id: "g-1" }] : [], requestDepth: 0 };
  const grant = { id: "g-1", identifier: "SLA-11", title: GRANT_TITLE, status: "todo", assigneeUserId: OPERATOR, assigneeAgentId: null, createdAt: "2026-01-02T00:00:00Z",
    description: "Decision needed for SLA-10.\n\n**Decision**\nGrant production for acme/app#7?\n\n**Evidence**\nDev verified.\n\n**Recommendation**\nYes, ship it." };
  const grant2 = { ...grant, id: "g-2", identifier: "SLA-12", title: GRANT_TITLE.replace("#7", "#8"), description: grant.description.replace("#7", "#8") };
  const comments = { "o-1": [], "g-1": [], "g-2": [] }, writes = [], gh = [];
  let t = 0; const now = () => new Date(Date.parse("2026-01-03T00:00:00Z") + ++t * 1000).toISOString();
  const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: "agent-em", name: "EM", companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok([{ id: "agent-em", name: "EM" }]);
    if (path === "/companies/co-1/user-directory") return ok({ users: [] });
    if (path === "/agents/me/inbox-lite") return ok([{ id: "o-1", status: "blocked", unresolvedBlockerIssueIds: ["g-1"] }]);
    if (path.startsWith("/companies/co-1/issues")) return ok(path.includes("production") ? (extraGrant ? [grant, grant2] : [grant]) : []);
    if (path === "/issues/g-1/interactions") return ok(interactions);
    if (path === "/issues/o-1/runs") return ok([{ id: "r1", agentId: "agent-em", status: "running" }]);
    if (path === "/heartbeat-runs/r1") return ok({ contextSnapshot: {} });
    const m = path.match(/^\/issues\/([^/]+)(\/comments|\/activity|\/runs)?$/);
    if (!m) return { ok: false, status: 404, text: async () => "" };
    const card = [origin, grant, grant2].find((c) => [c.id, c.identifier].includes(m[1]));
    if (!card) return { ok: false, status: 404, text: async () => "" };
    if (m[2] === "/comments") {
      if (init.method === "POST") {
        const body = JSON.parse(init.body).body;
        const run = init.headers["x-paperclip-run-id"] ?? null;
        writes.push({ card: card.id, body, run });
        comments[card.id].push({ id: `b${writes.length}`, body, authorAgentId: "agent-em", createdAt: now(), createdByRunId: run });
        return ok({});
      }
      return ok(comments[card.id]);
    }
    if (m[2] === "/activity") return ok([]);
    return ok(card);
  };
  const ghFake = async (args) => {
    if (ctl.failGh) throw new Error("gh issue edit: HTTP 403 rate limit");
    gh.push(args.join(" "));
    if (args[1] === "view") return JSON.stringify({ comments: gh.filter((a) => a.startsWith("issue comment")).map((a) => ({ body: a })) });
    return "";
  };
  const poller = createPaperclipPoller({ url: "http://b", apiKey: "k", stateFile: join(mkdtempSync(join(tmpdir(), "grant-")), "s.json"), log: silent, fetch,
    grant: { gh: ghFake, operator: OPERATOR }, ...(onGrantAsks ? { onGrantAsks } : {}), answer: async () => "MODEL RAN" });
  const operator = (card, body) => comments[card].push({ id: `operator${comments[card].length}${card}`, body, authorUserId: OPERATOR, authorAgentId: null, createdAt: now() });
  return { poller, operator, writes, gh, ctl, comments };
}
const labelled = (w) => w.gh.some((a) => a.startsWith("issue edit 7 -R acme/app --add-label deliver-to-prod"));
const quoted = (w, text) => w.gh.some((a) => a.startsWith("issue comment 7") && a.includes(`${["R", "ay"].join("")}, verbatim: "${text}"`) && a.includes("SLA-11") && a.includes("CT"));
const held = (w) => w.writes.some((x) => /stopped by someone else/.test(x.body));

(async () => {
  await check("verdicts", () => {
    assert.equal(verdictOf("yes, please deliver to prod"), "yes");
    assert.equal(verdictOf("No"), "no");
    assert.equal(verdictOf("wait until Monday"), "unclear");
    for (const t of ["I cannot approve this", "yes after the fix ships", "yes, staging only", "Is it okay to ship", "don't deliver to prod", "no, do not ship", "yes?", "do you ship to prod", "do you deliver to prod", "ship to prod", "you approve", "deliver", "approve only the docs change"]) assert.notEqual(verdictOf(t), "yes", t);
    for (const t of ["Yes.", "yes, please deliver to prod", "Approved", "go ahead", "ship it"]) assert.equal(verdictOf(t), "yes", t);
    assert.equal(verdictOf("yes but wait for the fix"), "unclear");
    assert.deepEqual(parseGrantTitle(GRANT_TITLE), { origin: "SLA-10", ref: "acme/app#7" });
  });
  await check("yes on the origin card: label, quote, no held note", async () => {
    const w = world(); w.operator("o-1", "yes, please deliver to prod");
    await w.poller.tick();
    assert.ok(labelled(w), w.gh.join("\n")); assert.ok(quoted(w, "yes, please deliver to prod"));
    assert.ok(!held(w));
    assert.ok(w.writes.some((x) => x.card === "o-1" && x.run === "r1" && /Recorded your go/.test(x.body)));
  });
  await check("yes on the grant card: same", async () => {
    const w = world(); w.operator("g-1", "Yes");
    await w.poller.tick();
    assert.ok(labelled(w)); assert.ok(quoted(w, "Yes")); assert.ok(!held(w));
  });
  await check("the same yes is recorded once across polls", async () => {
    const w = world(); w.operator("g-1", "yes");
    await w.poller.tick(); await w.poller.tick();
    assert.equal(w.gh.filter((a) => a.startsWith("issue edit")).length, 1);
    assert.equal(w.gh.filter((a) => a.startsWith("issue comment")).length, 1);
  });
  for (const word of ["no", "wait", "yes but wait for the fix"]) {
    await check(`"${word}" on either card: no label, one yes/no ask each`, async () => {
      const w = world(); w.operator("o-1", word); w.operator("g-1", word);
      await w.poller.tick(); await w.poller.tick();
      assert.ok(!w.gh.length, w.gh.join("\n"));
      assert.equal(w.writes.filter((x) => /yes or no/.test(x.body) && x.card === "o-1").length, 2);
      assert.equal(w.writes.filter((x) => /yes or no/.test(x.body) && x.card === "g-1").length, 1);
    });
  }
  await check("a comment on a blocked card with no grant blocker: as before", async () => {
    const w = world({ blockedOnGrant: false }); w.operator("o-1", "yes, please deliver to prod");
    await w.poller.tick();
    assert.ok(!w.gh.length);
    assert.ok(!w.writes.some((x) => /Recorded your go/.test(x.body)));
  });
  const failedNotes = (w, card) => w.writes.filter((x) => x.card === card && /NOT recorded yet/.test(x.body));
  await check("a failed record posts one note where he wrote, across two polls; a later success records and says so", async () => {
    const w = world(); w.ctl.failGh = true; w.operator("g-1", "yes");
    await w.poller.tick(); await w.poller.tick();
    assert.equal(failedNotes(w, "g-1").length, 1);
    const n = failedNotes(w, "g-1")[0].body;
    assert.ok(/rate limit/.test(n) && /every poll/.test(n) && /deliver-to-prod/.test(n) && /acme\/app#7/.test(n) && /<!-- grant-answer-failed:operator0g-1 -->/.test(n), n);
    assert.ok(!w.gh.length);
    w.ctl.failGh = false;
    await w.poller.tick();
    assert.ok(labelled(w)); assert.ok(quoted(w, "yes"));
    assert.ok(w.writes.some((x) => x.card === "g-1" && /Recorded your go/.test(x.body)));
    assert.equal(failedNotes(w, "g-1").length, 1);
  });
  await check("origin wake: a failed record posts the note under the run and no held note", async () => {
    const w = world(); w.ctl.failGh = true; w.operator("o-1", "yes, please deliver to prod");
    await w.poller.tick(); await w.poller.tick();
    assert.ok(!held(w));
    assert.equal(failedNotes(w, "o-1").length, 1);
    assert.equal(failedNotes(w, "o-1")[0].run, "r1");
  });
  await check("origin wake with the yes on the grant card: the run is still settled, no held note", async () => {
    const w = world(); w.ctl.failGh = true; w.operator("g-1", "yes");
    await w.poller.tick(); await w.poller.tick();
    assert.ok(!held(w));
    assert.equal(failedNotes(w, "g-1").length, 1);
    assert.ok(w.writes.some((x) => x.card === "o-1" && x.run === "r1" && /not recorded yet/.test(x.body)), JSON.stringify(w.writes));
  });
  await check("an open grant card is announced once; with a pending confirmation the link is to that decision, without one to the card", async () => {
    const sent = [];
    const w = world({ interactions: [{ id: "i-1", kind: "request_confirmation", status: "pending" }], onGrantAsks: async (cards) => { sent.push(cards); return true; } });
    await w.poller.tick(); await w.poller.tick();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].map((c) => [c.cardIdentifier, c.what]), [["SLA-11", "production grant for acme/app#7"]]);
    assert.equal(sent[0][0].link, "http://b/SLA/issues/SLA-11#interaction-i-1");
    const bare = []; const w2 = world({ onGrantAsks: async (cards) => { bare.push(cards); return true; } });
    await w2.poller.tick();
    assert.equal(bare[0][0].link, "http://b/SLA/issues/SLA-11");
  });
  await check("his Confirm on the decision records the grant once; his Decline records none and says so", async () => {
    const yes = world({ interactions: [{ id: "i-1", kind: "request_confirmation", status: "accepted", resolvedByUserId: OPERATOR, resolvedAt: "2026-01-04T00:00:00Z" }] });
    await yes.poller.tick(); await yes.poller.tick();
    assert.equal(yes.gh.filter((a) => a.startsWith("issue edit") && a.includes("deliver-to-prod")).length, 1, yes.gh.join("|"));
    assert.ok(yes.gh.some((a) => a.includes("grant-answer:i-1")));
    const other = world({ interactions: [{ id: "i-2", kind: "request_confirmation", status: "accepted", resolvedByUserId: "someone-else", resolvedAt: "2026-01-04T00:00:00Z" }] });
    await other.poller.tick();
    assert.equal(other.gh.length, 0);
    const no = world({ interactions: [{ id: "i-3", kind: "request_confirmation", status: "rejected", resolvedByUserId: OPERATOR, resolvedAt: "2026-01-04T00:00:00Z" }] });
    await no.poller.tick(); await no.poller.tick();
    assert.equal(no.gh.length, 0);
    assert.equal(no.writes.filter((x) => x.card === "g-1" && /Recorded your decline/.test(x.body)).length, 1, JSON.stringify(no.writes));
  });
  await check("several open grant cards in one poll go in one call", async () => {
    const sent = [];
    const w = world({ extraGrant: true, onGrantAsks: async (cards) => { sent.push(cards.map((c) => c.cardIdentifier)); return true; } });
    await w.poller.tick(); await w.poller.tick();
    assert.deepEqual(sent, [["SLA-11", "SLA-12"]]);
  });
  await check("an announcement that fails is retried next poll", async () => {
    let n = 0; const sent = [];
    const w = world({ onGrantAsks: async (cards) => { sent.push(cards.length); return ++n > 1; } });
    await w.poller.tick(); await w.poller.tick(); await w.poller.tick();
    assert.deepEqual(sent, [1, 1]);
  });
  await check("announceGrantAsks: one message, one binding per card, no repeat, retry only the unposted, replies never answer", async () => {
    const { createOwnerAsks, announceGrantAsks, routeReply } = require("../lib/owner-asks");
    const file = join(mkdtempSync(join(tmpdir(), "ga-")), "a.json");
    const registry = createOwnerAsks({ file }); const msgs = []; let fail = true;
    const send = async (t) => { msgs.push(t); return fail ? null : { id: `m${msgs.length}` }; };
    const cards = [1, 2].map((i) => ({ ownerCardId: `g-${i}`, cardIdentifier: `SLA-${i}`, link: `https://b/SLA/issues/SLA-${i}#interaction-i${i}`, what: `production grant ${i}`, decision: `Grant ${i}?`, recommendation: "Yes" }));
    assert.equal(await announceGrantAsks({ registry, cards, channelId: "c", send }), false);
    fail = false;
    assert.equal(await announceGrantAsks({ registry, cards, channelId: "c", send }), true);
    assert.equal(await announceGrantAsks({ registry, cards, channelId: "c", send }), true);
    assert.equal(msgs.length, 2);
    assert.ok(/2 production grants/.test(msgs[1]) && cards.every((c) => msgs[1].includes(`${c.what}: ${c.link}`) && !msgs[1].includes(c.decision) && !msgs[1].includes("Recommendation")));
    assert.ok(registry.all().every((b) => b.discordMessageId === "m2" && b.state === "notice"));
    const again = createOwnerAsks({ file });
    assert.equal(await announceGrantAsks({ registry: again, cards, channelId: "c", send }), true);
    assert.equal(msgs.length, 2);
    assert.equal(routeReply({ registry, channelId: "c", text: "yes", referenceId: "m2", userId: "u1" }).kind, "none");
    assert.equal(routeReply({ registry, channelId: "c", text: "yes", userId: "u1" }).kind, "none");
  });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
