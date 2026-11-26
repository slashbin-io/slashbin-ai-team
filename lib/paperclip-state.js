/**
 * The bridge's state (lib/paperclip.js loadState / saveState) in the company
 * record, sharded by card (lib/sharded-record.js).
 *
 * The poller sees a synchronous store: `read()` the whole saved object once at
 * start, `write(object)` after each change, `getDoc` / `putDoc` for the one
 * small stall-card record. A write is diffed against what the record already
 * holds and only the cards that changed are queued, so the many save calls per
 * poll cost memory, not requests; the network write is asynchronous and a
 * failure warns and stays queued.
 *
 * The saved object is split by card: every map keyed by a card id, or by
 * `<card>:<ask>`, goes to that card's entry; the four capped lists (handled
 * runs and the ask lists whose order decides what a cap drops) and the
 * counters each have an entry of their own. A card's entry is kept for as long
 * as the card has an answered ask, which is as long as the old file kept it:
 * dropping it would run an answered ask again.
 */
const { readFileSync } = require("fs");
const { ShardedRecord } = require("./sharded-record");

const TASK_MAPS = ["pendingReplies", "closing", "pendingSince", "decidedFrom", "attemptRuns", "blockedAsks", "continuing", "attemptIds", "attemptSeq",
  "leads", "linked", "linkDone", "lastAnswered", "revisits", "handedTo", "builtOn", "gates", "refused"];
const TASK_LISTS = ["answeredAsks"];
const GLOBAL_LISTS = ["handledRuns", "resumedAsks", "reviewAsks", "continuedAsks"];
const G = "_g:", DOC = "_g:doc:";

const taskOf = (k) => { const s = String(k); const i = s.indexOf(":"); return i < 0 ? s : s.slice(0, i); };

/** The saved object -> { entry id: entry }. */
function splitState(raw) {
  const out = new Map();
  const entry = (id) => { if (!out.has(id)) out.set(id, {}); return out.get(id); };
  for (const f of TASK_MAPS) {
    let m = raw?.[f];
    if (Array.isArray(m)) m = Object.fromEntries(m.map((k) => [k, "earlier"])); // saved before the wait was recorded with its ask
    for (const [k, v] of Object.entries(m ?? {})) { const e = entry(taskOf(k)); (e[f] ??= {})[k] = v; }
  }
  for (const f of TASK_LISTS) for (const k of raw?.[f] ?? []) { const e = entry(taskOf(k)); (e[f] ??= []).push(k); }
  for (const f of GLOBAL_LISTS) if (raw?.[f]?.length) out.set(`${G}${f}`, { list: raw[f] });
  out.set(`${G}scalars`, { seq: raw?.seq ?? 0, runnerRefusedUntil: raw?.runnerRefusedUntil ?? 0 });
  return out;
}

/** { entry id: entry } -> the saved object, or null when there is nothing saved. */
function joinState(entries) {
  const raw = {};
  let any = false;
  for (const [id, e] of entries) {
    if (id.startsWith(DOC)) continue;
    any = true;
    if (id === `${G}scalars`) { raw.seq = e.seq; raw.runnerRefusedUntil = e.runnerRefusedUntil; continue; }
    if (id.startsWith(G)) { raw[id.slice(G.length)] = e.list; continue; }
    for (const f of TASK_MAPS) if (e[f]) Object.assign(raw[f] ??= {}, e[f]);
    for (const f of TASK_LISTS) if (e[f]) (raw[f] ??= []).push(...e[f]);
  }
  return any ? raw : null;
}

/** The old local file as entries, or null when there is none. Anything but a missing file throws: read as empty it would run every answered ask again. */
function legacyEntries(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  return Object.fromEntries(splitState(JSON.parse(text)));
}

/**
 * @param {object} o
 * @param {import("./schedule-store").ScheduleStore} o.store  the record client
 * @param {string} o.bot
 * @param {string} o.name         this board's name for the collection
 * @param {string|null} [o.legacyFile]  the old state file, imported once
 */
function createPaperclipStore({ store, bot, name, legacyFile = null, log = console }) {
  const record = new ShardedRecord({ store, bot, name, log, legacy: legacyFile ? () => legacyEntries(legacyFile) : null });
  const known = new Map(); // entry id -> its JSON as last queued
  const jsonOf = (id) => { if (!known.has(id)) known.set(id, JSON.stringify(record.get(id))); return known.get(id); };
  return {
    record,
    open: () => record.open(),
    read: () => joinState(record.map),
    write(raw) {
      const next = splitState(raw);
      for (const [id, e] of next) {
        const s = JSON.stringify(e);
        if (record.get(id) !== undefined && jsonOf(id) === s) continue;
        record.put(id, e); known.set(id, s);
      }
      for (const id of [...record.map.keys()]) if (!id.startsWith(DOC) && !next.has(id)) { record.del(id); known.delete(id); }
    },
    getDoc: (n) => record.get(`${DOC}${n}`)?.v ?? null,
    putDoc(n, value) { if (value == null) record.del(`${DOC}${n}`); else record.put(`${DOC}${n}`, { v: value }); },
  };
}

module.exports = { createPaperclipStore, splitState, joinState };
