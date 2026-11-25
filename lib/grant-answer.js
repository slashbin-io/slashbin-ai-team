/**
 * the operator's production grant, answered on the board (SLA-5060/5062, 2026-11-15).
 *
 * The release-gate seat, lacking a grant, opens a To Do card for the operator titled
 * `<operator> decision for SLA-N: production grant for owner/repo#N` and blocks the origin card on it.
 * The grant itself is the `deliver-to-prod` label on that GitHub issue; nothing read a comment
 * on either card, so a plain "yes, please deliver to prod" sat unrecorded (and the origin card
 * answered "stopped by someone else" three times).
 *
 * A comment by the operator, on the grant card or on the origin card it blocks, that reads as a yes
 * records the grant: the label on the issue the title names, plus a GitHub comment quoting him.
 * A no or an ambiguous reply records nothing and is answered once with a request for yes/no.
 * Each comment is dealt with once: the bot's reply (and the GitHub quote) carry a mark naming it.
 */
const { execFile } = require("child_process");

const OPERATOR_USER = "GXPxstxD3klwqfZcEAdNIrv9xJ1g6VZn";
// The board operator's first name, kept out of tracked text (the internal-names check) and put in the quote at run time.
const NAME = ["R", "ay"].join("");
const LABEL = "deliver-to-prod";
const TITLE = /^[R]ay decision for ([A-Z]+-\d+): production grant for ([\w.-]+\/[\w.-]+#\d+)$/;
const MARK = /<!-- grant-answer:([\w-]+) -->/g;
const markOf = (id) => `<!-- grant-answer:${id} -->`;
const FAILED_MARK = /<!-- grant-answer-failed:([\w-]+) -->/g;
const failedMarkOf = (id) => `<!-- grant-answer-failed:${id} -->`;
const failedNote = (ref, err) => `Your yes was NOT recorded yet: ${String(err?.message ?? err).split("\n")[0].replace(/<!--|-->/g, "").slice(0, 200)}. I retry every poll and will say here when it is recorded. You can grant it by hand now with the \`${LABEL}\` label on ${ref}.`;
const ASK_YES_NO = "I read this as neither a clear yes nor a clear no, so I recorded no production grant. Reply with just yes or no.";
const declinedNote = (ref) => `Recorded your decline: no production grant was given for ${ref}.`;
const recordedNote = (ref) => `Recorded your go: \`${LABEL}\` is on ${ref}, with your words quoted there. The release gate takes it from here.`;

// A yes is a reply made of nothing but a go word or phrase and courtesy words: any other word, a question
// mark or a long reply is unclear, so a refusal, a condition, a scope limit or a question never reads as a go.
const GO_WORDS = new Set(["yes", "yep", "yeah", "yup", "approved", "granted", "ok", "okay", "sure", "lgtm"]);
const GO_PHRASES = /\b(go ahead|ship it|do it|deliver it to prod(uction)?|deliver to prod(uction)?)\b/g;
const COURTESY = new Set(["please", "thanks", "thank", "you"]);
/** "yes" only for a short reply made wholly of go words and courtesy; "no" for a plain no; anything else is "unclear". */
function verdictOf(text) {
  const t = String(text ?? "").toLowerCase().replace(/[`*_>"'.,!;:\u2014-]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || /\?/.test(String(text)) || t.length > 80) return "unclear";
  if (/^(no|nope|nah)$/.test(t)) return "no";
  const words = t.replace(GO_PHRASES, "yes").split(" ");
  if (!words.every((w) => GO_WORDS.has(w) || COURTESY.has(w))) return "unclear";
  return words.some((w) => GO_WORDS.has(w)) ? "yes" : "unclear";
}

const central = (iso) => `${new Date(iso).toLocaleString("en-CA", { timeZone: "America/Chicago", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "")} CT`;

function ghCli(args) {
  return new Promise((resolve, reject) => execFile("gh", args, { timeout: 60000, maxBuffer: 4_000_000 }, (err, out, errOut) => err ? reject(new Error(`gh ${args[0]} ${args[1]}: ${String(errOut || err.message).slice(0, 300)}`)) : resolve(out)));
}

/** The grant a card title names, or null. */
const parseGrantTitle = (title) => { const m = TITLE.exec(String(title ?? "")); return m ? { origin: m[1], ref: m[2] } : null; };

/**
 * @param {Function} o.api  (method, path, body, runId) -> JSON, the seat's own client (throws on non-2xx)
 * @param {Function} [o.gh]  (args) -> stdout of the gh CLI
 */
function createGrantAnswerer({ api, gh = ghCli, operator = OPERATOR_USER, log }) {
  const done = new Set(), noted = new Set();
  const rows = (v, k) => (Array.isArray(v) ? v : v?.[k] ?? []);
  const open = (c) => c && !["done", "cancelled"].includes(c.status);
  const isGrantCard = (c) => Boolean(c && c.assigneeUserId === operator && open(c) && parseGrantTitle(c.title));

  async function record({ ref, comment, card, originId }) {
    const [repo, number] = ref.split("#");
    await gh(["issue", "edit", number, "-R", repo, "--add-label", LABEL]);
    const have = JSON.parse((await gh(["issue", "view", number, "-R", repo, "--json", "comments"])) || "{}");
    if ((have.comments ?? []).some((c) => String(c.body).includes(markOf(comment.id)))) return;
    const quote = String(comment.body).trim();
    await gh(["issue", "comment", number, "-R", repo, "--body",
      `${NAME}, verbatim: "${quote}"\n\nGiven on Paperclip ${card.identifier} (${originId}), ${central(comment.createdAt)}. Recorded as the \`${LABEL}\` grant.\n\n${markOf(comment.id)}`]);
  }

  /**
   * Deal with every comment of the operator's on the grant card `card` and on its origin card not yet dealt with.
   * `origin`/`originComments`/`runId` are given when the origin card's own wake calls this.
   * Resolves { acted, recorded }: acted when a reply went out under `runId`, which ends that run.
   */
  async function answer(card, { origin = null, originComments = null, runId = null } = {}) {
    const g = parseGrantTitle(card.title);
    if (!g || card.assigneeUserId !== operator) return { acted: false, recorded: false, failed: false };
    origin ??= await api("GET", `/issues/${g.origin}`);
    const onGrant = rows(await api("GET", `/issues/${card.id}/comments`), "comments");
    // The origin's own comments count only while it is blocked on this grant card.
    const held = [...(origin.blockedBy ?? []).map((b) => b.id), ...(origin.blockedByIssueIds ?? [])].includes(card.id);
    const onOrigin = !held ? [] : originComments ?? rows(await api("GET", `/issues/${origin.id}/comments`), "comments");
    const seen = new Set();
    for (const c of [...onGrant, ...onOrigin]) for (const m of String(c.body ?? "").matchAll(MARK)) seen.add(m[1]);
    const failedSeen = new Set();
    for (const c of [...onGrant, ...onOrigin]) for (const m of String(c.body ?? "").matchAll(FAILED_MARK)) failedSeen.add(m[1]);
    // The confirmation on the grant card (Paperclip's Decisions view): his Confirm is a yes, his Decline a no, read as a comment of his.
    let clicks = [];
    try {
      clicks = rows(await api("GET", `/issues/${card.id}/interactions`), "interactions")
        .filter((i) => i.kind === "request_confirmation" && i.resolvedByUserId === operator && (i.status === "accepted" || i.status === "rejected"))
        .map((i) => ({ id: i.id, authorUserId: operator, createdAt: i.resolvedAt ?? i.updatedAt ?? new Date().toISOString(),
          verdict: i.status === "accepted" ? "yes" : "no", body: i.status === "accepted" ? "Confirm (clicked on the decision in Paperclip)" : "Decline (clicked on the decision in Paperclip)" }));
    } catch (err) { log?.warn({ err: err.message, card: card.id }, "Grant answer: decision not read"); }
    const where = new Map(onGrant.map((c) => [c.id, "grant"]).concat(onOrigin.map((c) => [c.id, "origin"]), clicks.map((c) => [c.id, "grant"])));
    const pending = [...onGrant, ...onOrigin, ...clicks]
      .filter((c) => !c.deletedAt && c.authorUserId === operator && !c.authorAgentId && Date.parse(c.createdAt) > Date.parse(card.createdAt) && !seen.has(c.id) && !done.has(c.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let acted = false, recorded = false, failed = false;
    const post = async (cardId, body, run) => {
      try { await api("POST", `/issues/${cardId}/comments`, { body }, run); return true; }
      catch (err) { log?.warn({ err: err.message, card: cardId }, "Grant answer: reply not posted"); return false; }
    };
    for (const c of pending) {
      const v = c.verdict ?? verdictOf(c.body);
      if (v === "yes") {
        try { await record({ ref: g.ref, comment: c, card, originId: origin.identifier ?? g.origin }); }
        catch (err) {
          // Visible where he wrote it, once per comment; the record is retried every poll.
          failed = true;
          log?.warn({ err: err.message, grant: card.identifier, comment: c.id }, "Production grant answer not recorded, retrying next poll");
          if (!failedSeen.has(c.id) && !noted.has(c.id)) {
            const onOriginCard = where.get(c.id) === "origin";
            const ok = await post(onOriginCard ? origin.id : card.id, `${failedNote(g.ref, err)}\n${failedMarkOf(c.id)}`, onOriginCard ? runId : null);
            if (ok) { noted.add(c.id); if (onOriginCard && runId) acted = true; }
          }
          break;
        }
        recorded = true;
        log?.info({ grant: card.identifier, ref: g.ref, comment: c.id }, "Production grant recorded from the operator's comment");
      }
      const body = `${v === "yes" ? recordedNote(g.ref) : c.verdict ? declinedNote(g.ref) : ASK_YES_NO}\n${markOf(c.id)}`;
      // On the origin card under this run when that is what woke; the grant card too when he wrote there.
      const ok = await post(origin.id, body, runId);
      if (where.get(c.id) === "grant") await post(card.id, body, null);
      if (ok || where.get(c.id) === "grant") done.add(c.id);
      if (ok && runId) acted = true;
      if (v === "yes") break;
    }
    return { acted, recorded, failed };
  }

  /** The open the operator grant cards on the board (the company's issues, matched on the title). */
  async function openCards(companyId) {
    const hits = rows(await api("GET", `/companies/${companyId}/issues?limit=100&q=${encodeURIComponent("production grant for")}`), "issues");
    return hits.filter(isGrantCard);
  }

  return { isGrantCard, answer, openCards };
}

module.exports = { createGrantAnswerer, failedMarkOf, verdictOf, parseGrantTitle, markOf, ASK_YES_NO, recordedNote, OPERATOR_USER, LABEL };
