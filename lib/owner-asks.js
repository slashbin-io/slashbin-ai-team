const { createHash } = require("node:crypto");
/**
 * Asks to a person, answered by a bare "yes" on Discord.
 *
 * A seat that concludes a decision is only the board operator's makes it with
 * the shared ask operation (ASK_OPERATION): one to-do card for that person,
 * linked to the seat's own card, which stays blocked on it. Nothing in that
 * path tells the person — the escalation policy reports no notification — so an
 * ask sat unseen for days (a card waiting "for a yes", 2026-10-21). And when a
 * person did say "yes" in a channel, the harness passed a fresh session only
 * the replied-to message's attachments, never its words, and the session asked
 * "What are you saying yes to?".
 *
 * This module is the two halves that close that gap:
 *
 *   1. announce — one Discord message per ask, in plain business terms, and a
 *      binding (message id -> card, the owner card, what a yes does) kept in the
 *      bot's state folder. Keyed by board and owner card, so a re-wake, a poll
 *      that sees the same ask again, or a restart posts nothing twice.
 *   2. resolve — a human message that is a reply to a bound ask, or a bare
 *      yes/no while exactly one ask is open in the channel, is the answer. It
 *      is never guessed: a bare yes with several open asks asks which.
 *
 * Pure decisions and the binding store live here; Discord and the board are
 * injected, so nothing in this file logs a bot in or writes to a board.
 */

const { readFileSync } = require("fs");
const { ShardedRecord } = require("./sharded-record");

// What a bare reply means. "stop" is NOT a negative: it is already a kill
// command the harness answers before anything here sees the message.
const YES = ["yes", "y", "yep", "proceed", "go", "go ahead", "approved", "do it", "ship it"];
const NO = ["no", "n", "hold", "don't", "dont", "do not"];

/**
 * "yes" | "no" | null. Case-insensitive, trailing punctuation allowed, any
 * leading bot mentions ignored. The whole message must be the word: "yes, but
 * only the first" is a conversation, not an answer, and goes to the model.
 */
function classifyReply(text) {
  const t = String(text ?? "")
    .replace(/^(?:<@!?\d+>\s*)+/, "")
    .replace(/[’‘]/g, "'")
    .trim().toLowerCase()
    .replace(/[\s.!?,;:]+$/, "")
    .replace(/\s+/g, " ");
  if (YES.includes(t)) return "yes";
  if (NO.includes(t)) return "no";
  return null;
}

/**
 * First line of the comment the harness writes on the seat's card when it
 * relays an answer. The seat's own comments are not asks (askOf), so without
 * this mark the relayed answer would leave the card's ask unchanged and the
 * woken seat would be told it already answered. askOf and the prompt both
 * recognise it.
 */
const RELAYED_MARK = "<!-- owner.answer:discord -->";
const isRelayedAnswer = (body) => String(body ?? "").startsWith(RELAYED_MARK);

/** The text under a `**Label**` heading in a owner card's description (quoted lines, `> ` stripped). */
function sectionOf(description, label) {
  const lines = String(description ?? "").split("\n");
  const at = lines.findIndex((l) => l.trim() === `**${label}**`);
  if (at < 0) return "";
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith(">")) { if (out.length) break; if (l.trim()) break; continue; }
    out.push(l.replace(/^>\s?/, ""));
  }
  return out.join("\n").trim();
}

// The shared process service's own wire names for the ask operation and the
// two fields its hop record carries (the person's card and its identifier).
// They belong to that service, not to this harness: they cannot be renamed
// here, so they live in this one place and nowhere else says them.
const ASK_OPERATION = "request_ray_action";
const ASK_CARD_FIELD = "rayCard";
const ASK_CARD_IDENTIFIER_FIELD = "rayCardIdentifier";

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the ask is and what a yes will do, in business terms. The recommendation
 * is what the seat proposes, so it is what a yes approves; with none written, a
 * yes only releases the card to carry on as the seat recommended in its notes.
 */
function describeAsk({ decision, recommendation, evidence }) {
  return {
    decision: decision || "A decision is waiting on you.",
    yesAction: recommendation || "the card goes back to the team to carry on with what it proposed",
    evidence: evidence || "",
  };
}

/** The one Discord message an ask is announced with. No internal names beyond the card's own link. */
function askMessage(b, { withRef = true } = {}) {
  return [
    `Decision needed from you: ${clip(b.decision, 700)}`,
    "",
    `If you say yes: ${clip(b.yesAction, 500)}`,
    "If you say no: the team is told not to go ahead and works out what to do instead.",
    "",
    "Reply to this message with yes or no.",
    ...(b.link ? [b.link] : []),
    ...(withRef ? [`ref: ${askRef(b)}`] : []),
  ].join("\n");
}

/** What is unique to one ask, so recovery can tell its announcement from an identical earlier one. */
function askRef(b) {
  return createHash("sha1").update(`${b.key}\n${b.createdAt}`).digest("hex").slice(0, 12);
}

const DISCORD_EPOCH_MS = 1420070400000n;
/** The time a Discord message id was created at (ms). */
function snowflakeMs(id) { return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS); }

const REF_AT_END = /\nref: ([0-9a-f]{12})\s*$/;
const TEXT_START = "Decision needed from you:";

/**
 * The bot's own history messages (oldest first, as the channel pages them) indexed once: by the ref a current
 * announcement ends with, and, for an announcement sent before refs existed, by its whole text. `taken` is the
 * set of message ids already bound to an ask, built once per recovery and shared.
 */
function indexAnnouncements(messages, taken) {
  const byRef = new Map();
  const byText = new Map();
  for (const m of messages) {
    if (typeof m.content !== "string") continue;
    const ref = REF_AT_END.exec(m.content);
    const bucket = ref ? byRef : byText;
    const key = ref ? ref[1] : m.content.slice(Math.max(0, m.content.indexOf(TEXT_START)));
    const list = bucket.get(key);
    if (list) list.push(m); else bucket.set(key, [m]);
  }
  return { byRef, byText, taken };
}

const takenIds = (registry) => new Set(registry.all().map((a) => a.discordMessageId).filter(Boolean));

/**
 * The announcement of each binding in an index, as a Map binding -> message; each message is used once and its id
 * joins `taken`. A binding takes the earliest message ending in its own ref, created at or after it. Bindings with
 * none take, in creation order, the next unused message of the same text sent before refs existed (identical text
 * is told apart only by order, so only such a group is ordered). Work is linear in bindings plus messages.
 */
function matchAnnouncements(index, bindings) {
  const out = new Map();
  const legacy = new Map();
  for (const b of bindings) {
    const since = Date.parse(b.createdAt);
    if (!Number.isFinite(since)) continue;
    const text = askMessage(b);
    let best = null;
    for (const m of index.byRef.get(askRef(b)) ?? []) {
      if (!m.content.includes(text) || snowflakeMs(m.id) < since || index.taken.has(m.id)) continue;
      if (!best || BigInt(m.id) < BigInt(best.id)) best = m;
    }
    if (best) { index.taken.add(best.id); out.set(b, best); continue; }
    const key = askMessage(b, { withRef: false });
    const group = legacy.get(key);
    if (group) group.push({ b, since }); else legacy.set(key, [{ b, since }]);
  }
  for (const [key, group] of legacy) {
    const queue = index.byText.get(key);
    if (!queue) continue;
    if (group.length > 1) group.sort((x, y) => x.since - y.since);
    let at = 0;
    for (const { b, since } of group) {
      while (at < queue.length && (snowflakeMs(queue[at].id) < since || index.taken.has(queue[at].id))) at++;
      if (at >= queue.length) break;
      index.taken.add(queue[at].id);
      out.set(b, queue[at++]);
    }
  }
  return out;
}

/**
 * One Discord message for the production-grant cards open at a poll (a release's holds, signed in one pass).
 * The grant is answered on each card (lib/grant-answer.js reads his comment there), so no reply to this
 * message is read as an answer: the bindings are state "notice" with no answerers, which routeReply ignores.
 * Each card has its own binding, so a card is announced once; a send that fails leaves them unposted and
 * the next poll sends the cards still unposted. Returns true when every card is posted.
 *
 * @param {{ registry: ReturnType<typeof createOwnerAsks>, cards: object[], board?: string|null, channelId: string,
 *   send: (text: string) => Promise<{ id: string }|null> }} o
 */
async function announceGrantAsks({ registry, cards, board = null, channelId, send }) {
  const todo = [];
  for (const c of cards) {
    const key = registry.keyOf(board, `grant:${c.ownerCardId}`);
    let binding = registry.get(key);
    if (binding?.discordMessageId) continue;
    const { decision, yesAction } = describeAsk({});
    binding ??= registry.create({ key, state: "notice", board, channelId, cardIdentifier: c.cardIdentifier, issueId: c.ownerCardId, ownerCardId: c.ownerCardId,
      ownerCardIdentifier: c.cardIdentifier, onOrigin: false, operator: null, decision, yesAction, link: c.link ?? null, answerers: [] });
    todo.push({ binding, c });
  }
  if (!todo.length) return true;
  if (!(await registry.flush())) return false; // the binding is in the record before the message goes out
  // A heads-up only: what needs him and where to click. The decision, evidence and recommendation stay on the card.
  // Messages are cut to fit Discord's limit (with room for the mention the bot prepends); each posted message marks its own cards.
  const LIMIT = 1800;
  const lines = todo.map(({ c }) => `${clip(c.what || "production grant", 140)}: ${c.link ?? c.cardIdentifier}`);
  const heads = (n) => (n === 1 ? "A production grant is waiting on you:" : `${n} production grants are waiting on you:`);
  const groups = [];
  for (let i = 0; i < todo.length; i++) {
    let g = groups[groups.length - 1];
    if (!g || [heads(g.n + 1), ...g.lines, lines[i]].join("\n").length > LIMIT) groups.push(g = { n: 0, lines: [], items: [] });
    g.n++; g.lines.push(lines[i]); g.items.push(todo[i]);
  }
  let all = true;
  for (const g of groups) {
    const sent = await send([heads(g.n), ...g.lines].join("\n"));
    if (!sent?.id) { all = false; continue; }
    for (const { binding } of g.items) { binding.discordMessageId = sent.id; registry.put(binding); }
    await registry.flush();
  }
  return all;
}

/**
 * The bindings, one record entry per ask, sharded (lib/sharded-record.js): the
 * company record keeps a value of at most 256 KB per key, and the bindings
 * outgrew one. `open()` reads every shard (false: the feature stays off, since
 * read as empty every ask would be announced again). The old local file is read
 * once to seed shards that do not exist yet, never over one that does.
 */
function createOwnerAskStore({ store, bot, name = "owner-asks", legacyFile = null, log = console }) {
  const legacy = legacyFile ? () => {
    try { return JSON.parse(readFileSync(legacyFile, "utf8")).asks ?? {}; } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  } : null;
  const record = new ShardedRecord({ store, bot, name, log, legacy });
  return { record, open: () => record.open(), flush: () => record.flush(), all: () => Object.fromEntries(record.map), put: (id, binding) => record.put(id, binding) };
}

/**
 * The binding registry over a store ({ all(): { key: binding }, put(key, binding) }). A change is
 * applied in memory at once and handed to the store, which writes it to the record without blocking.
 */
function createOwnerAsks({ store, clock = () => new Date().toISOString() }) {
  const asks = store.all();
  const save = (key) => store.put(key, asks[key]);
  const keyOf = (board, ownerCardId) => `${board ?? "default"}:${ownerCardId}`;
  return {
    keyOf,
    /** True when every change so far is in the record. */
    flush: async () => (await store.flush?.()) !== false,
    get: (key) => asks[key] ?? null,
    all: () => Object.values(asks),
    byMessage: (channelId, messageId) => Object.values(asks).find((a) => a.channelId === channelId && a.discordMessageId === messageId) ?? null,
    /** Asks posted to a channel and still waiting, oldest first. */
    open: (channelId) => Object.values(asks).filter((a) => a.state === "open" && a.discordMessageId && a.channelId === channelId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    put(binding) { asks[binding.key] = binding; save(binding.key); return binding; },
    create(fields) { return this.put({ state: "open", discordMessageId: null, createdAt: clock(), steps: {}, ...fields }); },
  };
}

/**
 * Announce an ask once. Idempotent: an ask already posted is returned as it is.
 * The binding is written BEFORE the post (without a message id), so a restart
 * between the two retries the post: at-least-once. The other order could lose
 * an ask for good, which is the failure this exists to end.
 *
 * @param {{ registry: ReturnType<typeof createOwnerAsks>, ask: object, board?: string|null, channelId: string,
 *   send: (text: string) => Promise<{ id: string }|null> }} o
 * @returns {Promise<{ binding: object, posted: boolean }>}
 */
async function announceAsk({ registry, ask, board = null, channelId, send, answerers = [], scan = null }) {
  // An ask held on its own card (onOrigin: no person's card was opened) is one
  // per request: the card id alone would swallow a second ask on the same card.
  const key = registry.keyOf(board, ask.dedupeId ?? ask.ownerCardId);
  let binding = registry.get(key);
  if (binding?.discordMessageId) return { binding, posted: false };
  const { decision, yesAction } = describeAsk(ask);
  binding ??= registry.create({
    key, board, channelId, cardIdentifier: ask.cardIdentifier, issueId: ask.issueId, runId: ask.runId ?? null,
    onOrigin: Boolean(ask.onOrigin), ownerCardId: ask.ownerCardId, ownerCardIdentifier: ask.ownerCardIdentifier ?? null, marker: ask.marker ?? null,
    // Whom the request named (the hop's `to`): the one user the board key may answer as.
    operator: ask.operator ?? null,
    decision, yesAction, link: ask.link ?? null, answerers: [...answerers],
  });
  // The binding is in the record before the message goes out: a restart between the two retries the post.
  if (!(await registry.flush())) return { binding, posted: false };
  // A binding with no message id may already have been sent (the bot restarted before the id was recorded):
  // look for the message in the channel and adopt it rather than post a second copy. A lookup that does not
  // complete sends nothing: the ask stays unannounced and the next attempt looks again.
  const text = askMessage(binding);
  let found = null;
  if (scan) {
    try { found = matchAnnouncements(indexAnnouncements(await scan(binding.channelId, Date.parse(binding.createdAt)), takenIds(registry)), [binding]).get(binding) ?? null; } catch { return { binding, posted: false }; }
  }
  const sent = found?.id ? found : await send(text);
  if (!sent?.id) return { binding, posted: false };
  binding.discordMessageId = sent.id;
  registry.put(binding);
  await registry.flush();
  return { binding, posted: true };
}

/**
 * Startup recovery: every ask whose message id was not recorded is looked for in its channel's history and, when
 * found, takes the original's id, so a reply to it routes and the ask is not sent again. A lookup that errors
 * leaves that binding as it is (announceAsk looks again before it sends). Returns how many were adopted.
 *
 * @param {{ registry: ReturnType<typeof createOwnerAsks>, scan: (channelId: string, fromMs: number) => Promise<{ id: string, content: string }[]> }} o
 */
async function recoverUnsentAsks({ registry, scan }) {
  const byChannel = new Map();
  for (const b of registry.all()) {
    if (b.discordMessageId || b.state !== "open") continue;
    const list = byChannel.get(b.channelId);
    if (list) list.push(b); else byChannel.set(b.channelId, [b]);
  }
  const taken = takenIds(registry);
  let adopted = 0;
  // One pass over each channel's history, from its oldest unannounced binding, indexed once: the work is the
  // channels', the bindings' and the history's total, never a scan or a registry walk per binding.
  for (const [channelId, bindings] of byChannel) {
    const from = bindings.reduce((min, b) => Math.min(min, Date.parse(b.createdAt)), Infinity);
    let index;
    try { index = indexAnnouncements(await scan(channelId, from), taken); } catch { continue; }
    for (const [b, found] of matchAnnouncements(index, bindings)) {
      b.discordMessageId = found.id;
      registry.put(b);
      adopted++;
    }
  }
  if (adopted) await registry.flush();
  return adopted;
}

/**
 * The prompt block for a reply to a message: what it said, and, when it was a
 * bound ask, which card it concerns and what a yes does. Without it a fresh
 * session is handed "yes" and nothing else.
 */
function replyContext({ author, content, binding = null }) {
  const said = String(content ?? "").trim();
  const lines = [`[This message is a reply to ${author ? `${author}'s` : "an earlier"} message${said ? `: "${clip(said, 2000)}"` : " (no text)"}]`];
  if (binding) {
    lines.push(`[That message is an open ask for a decision on ${binding.cardIdentifier}: ${clip(binding.decision, 700)} A yes would: ${clip(binding.yesAction, 500)}.]`);
  }
  return lines.join("\n");
}

/**
 * Whether this Discord user is the person the ask was put to. The ids are
 * fixed on the binding when the ask is announced (the board's escalation
 * mention); a binding with none can be answered by no one, never by everyone.
 */
function mayAnswer(binding, userId) {
  return Boolean(userId) && Array.isArray(binding?.answerers) && binding.answerers.includes(String(userId));
}

/** Discord user ids named in a mention string such as `<@1234> <@!5678>`. */
const idsIn = (mention) => [...String(mention ?? "").matchAll(/<@!?(\d{15,25})>/g)].map((m) => m[1]);

/**
 * Decide what a human message in a channel means for the asks bound there.
 *
 *   { kind: "none" }                                  not about an ask: carry on as before
 *   { kind: "context", binding }                      a reply to an open ask that is not a yes/no: the model, with the ask in its prompt
 *   { kind: "resolve", binding, verdict }             an answer
 *   { kind: "which", open }                           a bare yes/no with several asks open: ask which, never guess
 *   { kind: "closed", binding }                       a reply to an ask already answered
 */
function routeReply({ registry, channelId, text, referenceId = null, userId = null }) {
  const verdict = classifyReply(text);
  const bound = referenceId ? registry.byMessage(channelId, referenceId) : null;
  if (bound) {
    // Only the person asked may answer: anyone else's reply is an ordinary message.
    if (!mayAnswer(bound, userId)) return { kind: "none" };
    if (bound.state !== "open") return verdict ? { kind: "closed", binding: bound } : { kind: "context", binding: bound };
    return verdict ? { kind: "resolve", binding: bound, verdict } : { kind: "context", binding: bound };
  }
  // A reply to some other message is that message's business, not an ask's.
  if (!verdict || referenceId) return { kind: "none" };
  const open = registry.open(channelId).filter((b) => mayAnswer(b, userId));
  if (open.length === 1) return { kind: "resolve", binding: open[0], verdict };
  if (open.length > 1) return { kind: "which", open };
  return { kind: "none" };
}

/** The question a bare yes with several open asks gets back. */
// Discord refuses a message over 2000 characters, and a refused reply is a
// silent drop: the owner's yes vanishes (2026-11-20 1:53 pm, 2026-11-21 11:36 am
// and 3:49 pm, with 115 asks open). List only the newest few and count the rest,
// so the message is bounded by construction, never by how many asks pile up.
const WHICH_SHOWN = 5;
const WHICH_MAX_CHARS = 1900;
function whichMessage(open) {
  const newest = open.slice(-WHICH_SHOWN).reverse();
  const older = open.length - newest.length;
  const text = [
    `${open.length} decisions are waiting on you, so I can't tell which one that answers. The newest:`,
    ...newest.map((b, i) => `${i + 1}. ${clip(String(b.decision ?? ""), 160)}`),
    ...(older > 0 ? [`…and ${older} older.`] : []),
    "Reply (Discord's reply button) to the one you mean with yes or no.",
  ].join("\n");
  return clip(text, WHICH_MAX_CHARS);
}

/**
 * Resolve a bound ask with a yes/no: relay it to the board, mark the binding
 * answered, and say what happened. Never throws. A relay that fails leaves the
 * binding open (what already landed is kept in its steps), so saying yes again
 * retries without repeating anything.
 *
 * @param {{ registry: ReturnType<typeof createOwnerAsks>, binding: object, verdict: "yes"|"no", text: string,
 *   relays: Record<string, Function>, link?: string|null, clock?: () => string }} o
 * @returns {Promise<{ ok: boolean, reply: string }>}
 */
async function answerAsk({ registry, binding, verdict, text, relays, link = null, by = null, clock = () => new Date().toISOString() }) {
  if (!mayAnswer(binding, by?.id)) return { ok: false, reply: "That decision was put to someone else, so nothing was recorded." };
  const relay = relays[binding.board ?? "default"];
  if (!relay) return { ok: false, reply: "I can't reach the board this decision belongs to right now, so nothing was recorded. Say it again once it is back." };
  try {
    const { woke, standing } = await relay(binding, verdict, { text, link, by, save: () => registry.put(binding) });
    if (standing) {
      // The card already holds the answer (his click, or someone closing the ask): it stands.
      binding.state = "answered";
      binding.answer = { verdict: standing.verdict ?? null, text: `answered on the card (${standing.status})`, by: null, at: clock() };
      registry.put(binding);
      const onCard = standing.verdict ? `You already answered ${standing.verdict} on the card, and that answer stands: the team has it.` : `That decision was already closed on the card (${standing.status}).`;
      const same = standing.verdict === verdict;
      const reply = same ? `Recorded: ${verdict}. ${onCard}` : `${onCard} Your "${clip(text, 80)}" here was not recorded; change it on the card if you meant it.`;
      return { ok: same, reply: woke || !standing.verdict ? reply : `${reply}\nI could not wake the card: the team may need a nudge.` };
    }
    binding.state = "answered";
    binding.answer = { verdict, text: String(text).slice(0, 500), by: by ? { id: String(by.id), tag: by.tag ?? null } : null, at: clock() };
    registry.put(binding);
    const what = verdict === "yes" ? `Recorded: yes. ${clip(binding.yesAction, 300)}` : "Recorded: no. The team has been told not to go ahead.";
    return { ok: true, reply: woke ? what : `${what}\nThe answer is on the card, but I could not wake it: the team may need a nudge.` };
  } catch (err) {
    registry.put(binding);
    // A relay that can never land from Discord says where the answer goes instead.
    if (err?.ownerReply) return { ok: false, reply: err.ownerReply };
    return { ok: false, reply: "I couldn't record that on the card, so nothing has changed. Your answer is not lost: say it again to retry." };
  }
}

module.exports = { ASK_OPERATION, ASK_CARD_FIELD, ASK_CARD_IDENTIFIER_FIELD, answerAsk, classifyReply, RELAYED_MARK, isRelayedAnswer, sectionOf, describeAsk, askMessage, createOwnerAsks, createOwnerAskStore, announceAsk, announceGrantAsks, recoverUnsentAsks,
  replyContext, routeReply, mayAnswer, idsIn, whichMessage, YES, NO };
