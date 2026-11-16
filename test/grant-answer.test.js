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

function world({ blockedOnGrant = true } = {}) {
  const origin = { id: "o-1", identifier: "SLA-10", title: "Ship it", status: "blocked", assigneeAgentId: "agent-em", assigneeUserId: null, labels: [], createdAt: "2026-01-01T00:00:00Z", createdByUserId: OPERATOR, blockedBy: blockedOnGrant ? [{ id: "g-1" }] : [], requestDepth: 0 };
  const grant = { id: "g-1", identifier: "SLA-11", title: GRANT_TITLE, status: "todo", assigneeUserId: OPERATOR, assigneeAgentId: null, createdAt: "2026-01-02T00:00:00Z" };
  const comments = { "o-1": [], "g-1": [] }, writes = [], gh = [];
  let t = 0; const now = () => new Date(Date.parse("2026-01-03T00:00:00Z") + ++t * 1000).toISOString();
  const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: "agent-em", name: "EM", companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok([{ id: "agent-em", name: "EM" }]);
    if (path === "/companies/co-1/user-directory") return ok({ users: [] });
    if (path === "/agents/me/inbox-lite") return ok([{ id: "o-1", status: "blocked", unresolvedBlockerIssueIds: ["g-1"] }]);
    if (path.startsWith("/companies/co-1/issues")) return ok(path.includes("production") ? [grant] : []);
    if (path === "/issues/o-1/runs") return ok([{ id: "r1", agentId: "agent-em", status: "running" }]);
    if (path === "/heartbeat-runs/r1") return ok({ contextSnapshot: {} });
    const m = path.match(/^\/issues\/([^/]+)(\/comments|\/activity|\/runs)?$/);
    if (!m) return { ok: false, status: 404, text: async () => "" };
    const card = [origin, grant].find((c) => [c.id, c.identifier].includes(m[1]));
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
    gh.push(args.join(" "));
    if (args[1] === "view") return JSON.stringify({ comments: gh.filter((a) => a.startsWith("issue comment")).map((a) => ({ body: a })) });
    return "";
  };
  const poller = createPaperclipPoller({ url: "http://b", apiKey: "k", stateFile: join(mkdtempSync(join(tmpdir(), "grant-")), "s.json"), log: silent, fetch,
    grant: { gh: ghFake, operator: OPERATOR }, answer: async () => "MODEL RAN" });
  const operator = (card, body) => comments[card].push({ id: `operator${comments[card].length}${card}`, body, authorUserId: OPERATOR, authorAgentId: null, createdAt: now() });
  return { poller, operator, writes, gh };
}
const labelled = (w) => w.gh.some((a) => a.startsWith("issue edit 7 -R acme/app --add-label deliver-to-prod"));
const quoted = (w, text) => w.gh.some((a) => a.startsWith("issue comment 7") && a.includes(`${["R", "ay"].join("")}, verbatim: "${text}"`) && a.includes("SLA-11") && a.includes("CT"));
const held = (w) => w.writes.some((x) => /stopped by someone else/.test(x.body));

(async () => {
  await check("verdicts", () => {
    assert.equal(verdictOf("yes, please deliver to prod"), "yes");
    assert.equal(verdictOf("No"), "no");
    assert.equal(verdictOf("wait until Monday"), "unclear");
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
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
