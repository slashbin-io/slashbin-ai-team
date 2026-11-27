/**
 * A keyed collection too big for one record value, held in the company record's
 * keyed state as a fixed number of bucket documents (lib/keyed-doc.js).
 *
 * The record keeps one value of at most 256 KB per exact key and cannot list
 * keys, so a collection that outgrew one key is split by a stable hash of each
 * entry's id into `state/<bot>/<name>-<nn>` (nn = 00..63). The bucket keys are
 * known up front, so nothing has to be listed to find them. Each bucket holds
 * `{ entries: { id: value } }`. An entry too big to share a bucket is written to
 * a document of its own first, and the bucket holds a pointer to it; the pointer
 * is written only after the entry is safe, so a pointer never leads nowhere.
 *
 * `put(id, value)` and `del(id)` change the in-memory copy at once and mark the
 * id dirty. `flush()` groups the dirty ids by bucket and writes each bucket once
 * (one compare-and-set per bucket per flush, however many entries changed), and
 * resolves true only when everything marked dirty is in the record. A flush that
 * fails leaves the ids dirty and schedules itself again, so a down record drains
 * without another change being made. A caller that must not act before its change
 * is durable awaits `flush()`.
 *
 * `open()` returns true only when every bucket was read and any one-time import of
 * an old local file is in the record: the import is committed before the
 * collection is usable, so a restart after it never imports again. A bucket that
 * exists is authoritative; the old file only fills buckets that do not exist yet.
 * A failed read is never read as empty.
 */
const { createHash } = require("crypto");
const { KeyedDoc, docKey } = require("./keyed-doc");

const BUCKETS = 64;
const BIG = 8000;            // an entry whose JSON is longer than this gets a document of its own
const RETRY_MS = [1000, 5000, 30000];
const entriesOf = (v) => (v && typeof v.entries === "object" && v.entries && !Array.isArray(v.entries) ? v.entries : {});
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha = (s) => createHash("sha1").update(String(s));

class ShardedRecord {
  /**
   * @param {object} o
   * @param {import("./schedule-store").ScheduleStore} o.store
   * @param {string} o.bot
   * @param {string} o.name        the collection's name; bucket keys are `<name>-<nn>`
   * @param {() => (object|null)} [o.legacy]  the old local file's entries, read only when a bucket is absent
   * @param {number[]} [o.retryMs]  delays before a failed flush runs again
   */
  constructor({ store, bot, name, buckets = BUCKETS, legacy = null, retryMs = RETRY_MS, log = console }) {
    this.store = store; this.bot = bot; this.name = name; this.n = buckets; this.log = log; this.legacy = legacy; this.retryMs = retryMs;
    this.map = new Map(); this.dirty = new Map(); this.rev = 0;
    this.inflight = Array.from({ length: buckets }, () => null);
    this.failures = 0; this.timer = null; this._p = null;
    this.docs = Array.from({ length: buckets }, (_, i) => new KeyedDoc({
      store, key: docKey(bot, `${name}-${String(i).padStart(2, "0")}`), empty: { entries: {} }, log,
    }));
  }

  get configured() { return this.docs[0].configured; }

  bucketOf(id) { return sha(id).digest().readUInt32BE(0) % this.n; }

  _overflowKey(id) { return docKey(this.bot, `${this.name}-x-${sha(id).digest("hex").slice(0, 24)}`); }

  /** Read every bucket and every overflow entry, then commit the import of the old file. False leaves the collection unusable. */
  async open() {
    this.closed = false;
    try {
      if (!(await Promise.all(this.docs.map((d) => d.load()))).every(Boolean)) return false;
      const loaded = new Map();
      await Promise.all(this.docs.flatMap((d) => Object.entries(entriesOf(d.value))).map(async ([id, v]) => {
        if (v && typeof v === "object" && typeof v.$ref === "string") {
          const row = await this.store.get(v.$ref);
          if (!row) throw new Error(`entry ${id} is missing its document`);
          loaded.set(id, row.value?.v);
        } else loaded.set(id, v);
      }));
      this.map = loaded; this.dirty.clear();
      const absent = new Set(this.docs.map((d, i) => (d.version === 0 ? i : -1)).filter((i) => i >= 0));
      if (absent.size && this.legacy) {
        const old = this.legacy();
        if (old) {
          for (const [id, v] of Object.entries(old)) if (absent.has(this.bucketOf(id))) this._set(id, v);
          // The imported entries first, and only once they are in the record the marker for each absent bucket
          // (a bucket that exists is "imported"): a marker written first would stand for contents that never arrived.
          if (!(await this.flush())) throw new Error("the one-time import is not in the record yet");
          const bare = [...absent].filter((i) => this.docs[i].version === 0);
          for (const i of bare) this.docs[i].mutate((d) => ({ entries: entriesOf(d) }));
          if (!(await Promise.all(bare.map((i) => this.docs[i].flush()))).every(Boolean)) throw new Error("the one-time import is not marked in the record yet");
        }
      }
    } catch (e) {
      this.log.warn?.(`state not loaded: ${e.message}`);
      this._abandon();
      return false;
    }
    if (!(await this.flush())) { this.log.warn?.("state not loaded: the one-time import is not in the record yet"); this._abandon(); return false; }
    return true;
  }

  /**
   * A collection whose open failed is closed for good: the write retry a failed one-time import left queued is
   * cancelled, so this object can never write into the record after another one has opened it and saved an
   * answer (a later retry would put the old file's entries back over it).
   */
  _abandon() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.dirty.clear();
  }

  get(id) { return this.map.get(id); }

  _set(id, v) { this.map.set(id, v); this.dirty.set(id, ++this.rev); }

  put(id, value) { this._set(id, clone(value)); this._kick(); }

  del(id) {
    if (!this.map.delete(id)) return;
    this.dirty.set(id, ++this.rev);
    this._kick();
  }

  /** Flush after the current burst of changes, so many changes made together are written together. */
  _kick() {
    if (this.kicked || this.closed) return;
    this.kicked = true;
    setImmediate(() => { this.kicked = false; if (this.closed) return; this.flush().catch((e) => this.log.warn?.(`state not saved: ${e.message}`)); });
  }

  /** Write every change made so far. True only when the record holds all of it. */
  async flush() {
    for (let round = 0; round < 4; round++) {
      if (!this.dirty.size && !this.inflight.some(Boolean)) return true;
      if (!this._p) this._p = this._run().finally(() => { this._p = null; });
      if (!(await this._p)) return false;
    }
    return !this.dirty.size;
  }

  async _run() {
    let ok = false;
    try {
      const groups = new Map();
      for (const [id, rev] of this.dirty) {
        const i = this.bucketOf(id);
        if (!groups.has(i)) groups.set(i, []);
        groups.get(i).push([id, rev]);
      }
      for (let i = 0; i < this.n; i++) if (this.inflight[i] && !groups.has(i)) groups.set(i, []);
      const results = await Promise.all([...groups].map(([i, ids]) => this._bucket(i, ids).catch((e) => {
        this.log.warn?.(`state not saved: ${e.message}`); return false;
      })));
      ok = results.every(Boolean);
    } finally { this._after(ok); }
    return ok;
  }

  _after(ok) {
    if (this.closed) return;
    if (ok) { this.failures = 0; if (this.timer) { clearTimeout(this.timer); this.timer = null; } if (!this.dirty.size) return; }
    if (this.timer) return;
    const wait = this.retryMs[Math.min(this.failures++, this.retryMs.length - 1)];
    this.timer = setTimeout(() => { this.timer = null; if (!this.closed) this._kick(); }, wait);
    this.timer.unref?.();
  }

  async _bucket(i, ids) {
    const doc = this.docs[i];
    if (!this.inflight[i] && ids.length) {
      const set = {}, del = [], revs = new Map();
      for (const [id, rev] of ids) {
        revs.set(id, rev);
        if (!this.map.has(id)) { del.push(id); continue; }
        const v = this.map.get(id);
        if (JSON.stringify(v).length > BIG) {
          const key = this._overflowKey(id);
          if (!(await this._overflow(key, v))) return false;
          set[id] = { $ref: key };
        } else set[id] = v;
      }
      doc.mutate((d) => { const e = { ...entriesOf(d), ...set }; for (const id of del) delete e[id]; return { entries: e }; });
      this.inflight[i] = revs;
    }
    if (!(await doc.flush()) || doc.pending.length) return false;
    for (const [id, rev] of this.inflight[i]) if (this.dirty.get(id) === rev) this.dirty.delete(id);
    this.inflight[i] = null;
    return true;
  }

  async _overflow(key, value) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.store.get(key);
      if ((await this.store.set(key, { v: value }, row?.version ?? 0)).ok) return true;
    }
    return false;
  }
}

module.exports = { ShardedRecord, entriesOf, BUCKETS };
