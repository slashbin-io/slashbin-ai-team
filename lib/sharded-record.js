/**
 * A keyed collection too big for one record value, held in the company record's
 * keyed state as a fixed number of bucket documents (lib/keyed-doc.js).
 *
 * The record keeps one value of at most 256 KB per exact key and cannot list
 * keys, so a collection that outgrew one key is split by a stable hash of each
 * entry's id into `state/<bot>/<name>-<nn>` (nn = 00..63). The bucket keys are
 * known up front, so nothing has to be listed to find them and no index
 * document can fall behind the entries. Each bucket holds `{ entries: { id: value } }`.
 *
 * Every change is `put(id, value)` or `del(id)`: pure and idempotent, applied
 * to the in-memory copy at once and queued for its bucket, then written with
 * compare-and-set by KeyedDoc (a conflict re-reads and re-applies). Callers
 * never wait on the network, and a failed write stays queued for the next flush.
 * `open()` reads every bucket; one that cannot be read leaves the collection
 * closed, because a failed read must never be read as empty.
 *
 * An old local file is a one-time import source: `legacy()` returns
 * `{ id: value }`, and each bucket takes its share only when that bucket does
 * not exist yet. A bucket that exists is authoritative.
 */
const { createHash } = require("crypto");
const { KeyedDoc, docKey } = require("./keyed-doc");

const BUCKETS = 64;
const entriesOf = (v) => (v && typeof v.entries === "object" && v.entries && !Array.isArray(v.entries) ? v.entries : {});
const clone = (v) => JSON.parse(JSON.stringify(v));

class ShardedRecord {
  /**
   * @param {object} o
   * @param {import("./schedule-store").ScheduleStore} o.store
   * @param {string} o.bot
   * @param {string} o.name        the collection's name; bucket keys are `<name>-<nn>`
   * @param {() => (object|null)} [o.legacy]  the old local file's entries, read only when a bucket is absent
   */
  constructor({ store, bot, name, buckets = BUCKETS, legacy = null, log = console }) {
    this.n = buckets; this.log = log; this.legacy = legacy; this.map = new Map(); this.old = null;
    this.docs = Array.from({ length: buckets }, (_, i) => new KeyedDoc({
      store, key: docKey(bot, `${name}-${String(i).padStart(2, "0")}`), empty: { entries: {} }, log, seed: () => this._seedFor(i),
    }));
  }

  get configured() { return this.docs[0].configured; }

  bucketOf(id) { return createHash("sha1").update(String(id)).digest().readUInt32BE(0) % this.n; }

  _seedFor(i) {
    if (!this.legacy) return null;
    this.old ??= this.legacy() ?? {};
    const mine = Object.fromEntries(Object.entries(this.old).filter(([id]) => this.bucketOf(id) === i));
    return Object.keys(mine).length ? (v) => ({ entries: { ...mine, ...entriesOf(v) } }) : null;
  }

  /** Read every bucket. True when all were read (and any import written); false leaves the collection unusable. */
  async open() {
    try { await Promise.all(this.docs.map((d) => d.load())); } catch (e) {
      this.log.warn?.(`state not loaded: ${e.message}`);
      return false;
    }
    if (!this.docs.every((d) => d.loaded)) return false;
    this.map = new Map(this.docs.flatMap((d) => Object.entries(entriesOf(d.value))));
    return true;
  }

  get(id) { return this.map.get(id); }

  put(id, value) {
    const v = clone(value);
    this.map.set(id, v);
    this.docs[this.bucketOf(id)].mutate((doc) => ({ entries: { ...entriesOf(doc), [id]: v } }));
    this._kick();
  }

  del(id) {
    if (!this.map.delete(id)) return;
    this.docs[this.bucketOf(id)].mutate((doc) => { const e = { ...entriesOf(doc) }; delete e[id]; return { entries: e }; });
    this._kick();
  }

  _kick() { this.flush().catch((e) => this.log.warn?.(`state not saved: ${e.message}`)); }

  /** Write every queued change. True when nothing is left queued. */
  async flush() {
    await Promise.all(this.docs.filter((d) => d.pending.length || d.flushing).map((d) => d.flush()));
    return this.docs.every((d) => !d.pending.length);
  }
}

module.exports = { ShardedRecord, entriesOf, BUCKETS };
