/**
 * The two small per-bot documents of the Discord summarizer, kept in the company
 * record (lib/keyed-doc.js):
 *
 *   seen-channels  every channel the bot has spoken in, so the summarizer covers it
 *   checkpoints    per channel, the id of the last message already summarized
 *
 * A failed read is never read as empty: a bot that lost its checkpoints would
 * summarize a whole channel's recent history a second time, and one that lost
 * its seen channels would stop summarizing the conversations it was only
 * mentioned in.
 */
const { readFileSync } = require("fs");
const { ScheduleStore } = require("./schedule-store");
const { KeyedDoc, docKey } = require("./keyed-doc");

/** Discord ids are snowflakes: larger is newer. */
const newer = (a, b) => { try { return BigInt(a) > BigInt(b); } catch { return String(a) > String(b); } };

const idsOf = (v) => (Array.isArray(v?.channels) ? v.channels : []);
const addChannel = (id) => (v) => { const ids = idsOf(v); return ids.includes(id) ? { channels: ids } : { channels: [...ids, id] }; };

const marksOf = (v) => (v && typeof v.channels === "object" && v.channels && !Array.isArray(v.channels) ? v.channels : {});
const setMark = (channelId, messageId) => (v) => {
  const marks = marksOf(v);
  return marks[channelId] && !newer(messageId, marks[channelId]) ? { channels: marks } : { channels: { ...marks, [channelId]: messageId } };
};
const mergeMarks = (old) => (v) => Object.entries(old).reduce((acc, [c, m]) => setMark(c, m)(acc), { channels: marksOf(v) });

/** A local file's JSON, or null when it is missing or unreadable (a one-time import source only). */
function legacyJson(file) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }

function createChannelState({ bot, log = console, store = new ScheduleStore({ bot, log }), legacySeenFile = null, legacyCheckpointFile = null }) {
  const seen = new KeyedDoc({ store, key: docKey(bot, "seen-channels"), empty: { channels: [] }, log });
  const marks = new KeyedDoc({ store, key: docKey(bot, "checkpoints"), empty: { channels: {} }, log });
  const seenSeed = () => {
    const old = legacySeenFile ? legacyJson(legacySeenFile) : null;
    const ids = Array.isArray(old) ? old.map(String) : [];
    return (v) => ids.reduce((acc, id) => addChannel(id)(acc), { channels: idsOf(v) });
  };
  const markSeed = () => {
    const old = legacyCheckpointFile ? legacyJson(legacyCheckpointFile) : null;
    return mergeMarks(old && typeof old === "object" && !Array.isArray(old) ? old : {});
  };
  return {
    store, seen, marks,
    get configured() { return store.configured; },
    /** Load seen channels from the record (importing the old local file once, when the record has none). */
    loadSeen: () => seen.load({ seed: seenSeed() }),
    seenIds: () => new Set(idsOf(seen.value)),
    recordSeen(id) { seen.mutate(addChannel(String(id))); return seen.flush(); },
    /** Read the checkpoints fresh. False when the record could not be read: the caller skips its cycle. */
    loadMarks: () => marks.load({ seed: markSeed() }),
    marksNow: () => ({ ...marksOf(marks.value) }),
    async setMark(channelId, messageId) { marks.mutate(setMark(String(channelId), String(messageId))); return marks.flush(); },
  };
}

module.exports = { createChannelState, addChannel, setMark, mergeMarks, newer };
