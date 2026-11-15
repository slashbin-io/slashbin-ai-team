/**
 * Routine runner — a routine's card answered by a command, with no model run
 * (lib/routine-runner.js, PAPERCLIP_ROUTINE_RUNNER). The command's contract is
 * tested against real processes; the poller's use of it against a fake board.
 */
const assert = require("assert");
const { mkdtempSync, writeFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { parseRoutineRunner, createRoutineRunner, DECLINED, MAX_ANSWER_BYTES } = require("../lib/routine-runner");
const { createPaperclipPoller } = require("../lib/paperclip");

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); fail++; }
}
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const dir = mkdtempSync(join(tmpdir(), "rr-"));
/** A runner that is this node, running `body` with the card on `card`. */
function runner(body, opts = {}) {
  const file = join(dir, `r${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(file, `let raw = ""; process.stdin.on("data", (d) => { raw += d; }).on("end", () => { const card = JSON.parse(raw); ${body} });`);
  return createRoutineRunner({ command: [process.execPath, file], cwd: dir, env: () => ({ ...process.env, RR_MARK: "from-run-env" }), log: silent, ...opts });
}
const card = { identifier: "SLA-7", title: "Nightly sweep", description: "run the sweep", status: "in_progress" };

const ok = (v) => ({ ok: true, text: async () => JSON.stringify(v) });
const settle = () => new Promise((r) => setTimeout(r, 25));
/** One card assigned to the seat with a live run. `comments` is what has been said on it. */
function board({ routine = true, comments = [] } = {}) {
  const s = {
    card: { id: "c-1", identifier: "SLA-1", title: "Nightly sweep", description: "run the sweep", status: "in_progress", assigneeAgentId: "agent-em", assigneeUserId: null,
      labels: [], createdAt: "2026-01-01T00:00:00Z", createdByUserId: "user-avery", requestDepth: 0, originKind: routine ? "routine_execution" : "manual" },
    comments: [...comments], runs: [{ id: "r1", agentId: "agent-em", status: "running" }], activity: [],
  };
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, "");
    if (path === "/agents/me") return ok({ id: "agent-em", name: "Engineering Manager", companyId: "co-1" });
    if (path === "/companies/co-1/agents") return ok([{ id: "agent-em", name: "Engineering Manager" }]);
    if (path === "/companies/co-1/user-directory") return ok({ users: [] });
    if (path === "/agents/me/inbox-lite") return ok([{ id: s.card.id, identifier: s.card.identifier, status: s.card.status, unresolvedBlockerIssueIds: [] }]);
    if (path.startsWith("/companies/co-1/issues?")) return ok(routine ? [s.card] : []);
    if (path === "/heartbeat-runs/r1") return ok({ contextSnapshot: {} });
    const m = path.match(/^\/issues\/c-1(\/[a-z]+)?$/);
    if (!m) return { ok: false, status: 404, text: async () => "" };
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body);
      if (body.status) s.card.status = body.status;
      if ("comment" in body) { s.comments.push({ id: `c${s.comments.length}`, authorAgentId: "agent-em", createdAt: new Date().toISOString(), body: body.comment }); s.runs[0].status = "succeeded"; }
      return ok({});
    }
    if (!m[1]) return ok({ ...s.card, blockedBy: [] });
    if (m[1] === "/activity") return ok(s.activity);
    if (m[1] === "/comments") return ok(s.comments);
    if (m[1] === "/runs") return ok(s.runs);
    return { ok: false, status: 404, text: async () => "" };
  };
  return { fetch, s };
}
/** Polls once with the given runner; resolves to what the model was asked and what the card holds. */
async function work(b, routineRunner) {
  const asked = [];
  const p = createPaperclipPoller({ url: "https://board.example.com", apiKey: "k", stateFile: join(mkdtempSync(join(tmpdir(), "pc-")), "s.json"),
    answer: async (_, issue) => { asked.push(issue.identifier); return "the model's answer"; }, log: silent, fetch: b.fetch, routineRunner });
  await p.tick("poll"); await settle(); await p.idle();
  return { asked, said: b.s.comments.filter((c) => c.authorAgentId === "agent-em").map((c) => c.body), status: b.s.card.status };
}
const said = { id: "k1", authorAgentId: null, authorUserId: "user-avery", createdAt: "2026-01-01T00:00:01Z", body: "Go." };

(async () => {
  await check("the setting is a command split on spaces, and unset is no runner", () => {
    assert.deepStrictEqual(parseRoutineRunner("node  scripts/card.mjs --quiet "), ["node", "scripts/card.mjs", "--quiet"]);
    for (const none of [undefined, null, "", "   "]) assert.strictEqual(parseRoutineRunner(none), null);
  });

  await check("exit 0: what the command printed is the answer; it is given the card and the run's environment", async () => {
    const answer = await runner('console.log(`${card.identifier}|${card.title}|${card.description}|${process.env.RR_MARK}|${Object.keys(card).sort()}`);')(card);
    assert.strictEqual(answer, "SLA-7|Nightly sweep|run the sweep|from-run-env|description,identifier,title");
  });

  await check(`exit ${DECLINED}: the command declined, and there is no answer`, async () => {
    assert.strictEqual(await runner(`console.log("ignored"); process.exit(${DECLINED});`)(card), null);
  });

  await check("any other exit, no output, and a command that cannot start are failures, never answers", async () => {
    await assert.rejects(runner('console.error("boom"); process.exit(1);')(card), /exited 1: boom/);
    await assert.rejects(runner("process.exit(0);")(card), /no answer/);
    await assert.rejects(createRoutineRunner({ command: [join(dir, "no-such-command")], cwd: dir, env: () => process.env, log: silent })(card), /ENOENT/);
    await assert.rejects(createRoutineRunner({ command: [process.execPath, "-e", "0"], cwd: dir, env: () => { throw new Error("Run environment refused"); }, log: silent })(card), /Run environment refused/);
  });

  await check("a command that runs past its time is stopped and is a failure", async () => {
    await assert.rejects(runner("setTimeout(() => {}, 60000);", { timeoutMs: 200 })(card), /stopped after 200 ms/);
  });

  await check("a command that never reads the card still answers", async () => {
    assert.strictEqual(await createRoutineRunner({ command: [process.execPath, "-e", 'console.log("fine")'], cwd: dir, env: () => process.env, log: silent })(card), "fine");
  });

  await check("an answer longer than one answer may be is cut, and says so", async () => {
    const answer = await runner(`process.stdout.write("x".repeat(${MAX_ANSWER_BYTES} + 5000));`)(card);
    assert.ok(Buffer.byteLength(answer) <= MAX_ANSWER_BYTES + 200, `${Buffer.byteLength(answer)} bytes`);
    assert.match(answer, /left out/);
  });

  // The poller.
  await check("a routine card nothing has been said on is answered by the runner, and no model runs", async () => {
    const seen = [];
    const r = await work(board(), async (issue) => { seen.push(`${issue.identifier}|${issue.description}`); return "Sweep ran: 0 problems."; });
    assert.deepStrictEqual(seen, ["SLA-1|run the sweep"]);
    assert.deepStrictEqual(r.asked, [], "the model was not started");
    assert.strictEqual(r.said.length, 1);
    assert.match(r.said[0], /Sweep ran: 0 problems\./);
  });

  await check("the runner's answer is routed as the model's would be: an outcome line leaves the card blocked", async () => {
    const r = await work(board(), async () => "Sweep failed: 3 problems.\n\nPAPERCLIP-OUTCOME: blocked");
    assert.deepStrictEqual(r.asked, []);
    assert.strictEqual(r.status, "blocked");
    assert.match(r.said[0], /Sweep failed: 3 problems\./);
    assert.doesNotMatch(r.said[0], /PAPERCLIP-OUTCOME/);
  });

  await check("a card the runner declines gets the model", async () => {
    const r = await work(board(), async () => null);
    assert.deepStrictEqual(r.asked, ["SLA-1"]);
    assert.match(r.said[0], /the model's answer/);
  });

  await check("a runner that fails gets the model: a broken command never leaves a card unanswered", async () => {
    const r = await work(board(), async () => { throw new Error("routine runner exited 1: boom"); });
    assert.deepStrictEqual(r.asked, ["SLA-1"]);
    assert.match(r.said[0], /the model's answer/);
  });

  await check("a routine card someone has spoken on is a conversation: the model's, the runner is not asked", async () => {
    let calls = 0;
    const r = await work(board({ comments: [said] }), async () => { calls++; return "runner"; });
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(r.asked, ["SLA-1"]);
  });

  await check("an ordinary card is never the runner's", async () => {
    let calls = 0;
    const r = await work(board({ routine: false }), async () => { calls++; return "runner"; });
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(r.asked, ["SLA-1"]);
  });

  await check("with no runner set a routine card gets the model, as before", async () => {
    const r = await work(board(), null);
    assert.deepStrictEqual(r.asked, ["SLA-1"]);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
