/**
 * One small document of the bot's state, held in the company record's keyed
 * state (the same client and signing key as lib/schedule-store.js), never in a
 * local file.
 *
 * Key: `state/<bot>/<name>`, value an object. The bot is the only writer. The
 * bot reads a synchronous in-memory copy; every change is an operation (value ->
 * value, pure and safe to apply twice) applied to that copy at once and queued
 * for the record. A flush reads the record's current version, re-applies the
 * queued operations to what it read, and writes with compare-and-set on that
 * version; on a conflict it re-reads and re-applies, so a concurrent change is
 * never lost. A change that could not be written stays queued and goes out on
 * the next flush. A failed read is never read as empty.
 *
 * A value is at most 256 KB at the receiver: this is for small documents, not
 * logs or collections.
 */
const { ScheduleStore } = require("./schedule-store");

const MAX_ATTEMPTS = 5;

/** `state/<bot>/<name>`, with nothing unsafe in either part. */
function docKey(bot, name) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
  return `state/${clean(bot)}/${clean(name)}`;
}

class KeyedDoc {
  /**
   * @param {object} o
   * @param {ScheduleStore} o.store  the record client (get/set with compare-and-set)
   * @param {string} o.key           the document's key (docKey)
   * @param {object} o.empty         the value of a document that does not exist yet
   * @param {() => (Function|null)} [o.seed]  returns the operation that imports an old local
   *   file; applied by every read that finds the document absent (load and flush alike), so a
   *   change made before the first load still imports it, and an existing document stays authoritative
   */
  constructor({ store, key, empty, seed = null, log = console }) {
    this.seedFn = seed;
    this.store = store; this.key = key; this.empty = empty; this.log = log;
    this.value = empty; this.version = 0; this.loaded = false; this.pending = []; this.flushing = null;
    this.warned = false;
  }

  get configured() { return this.store.configured; }

  _warn(msg) { if (this.warned) return; this.warned = true; this.log.warn?.(msg); }

  /**
   * Read the record into the in-memory copy, with every queued change applied on top.
   * When the document does not exist yet, `seed` (an operation, e.g. the import of an
   * old local file) is queued and written. Resolves true when the copy is the record's.
   */
  async load({ seed = this.seedFn?.() ?? null } = {}) {
    if (!this.configured) { this._warn(`${this.key}: the company record is not configured for this bot`); return false; }
    try {
      const row = await this.store.get(this.key);
      this.version = row?.version ?? 0;
      this.value = row ? row.value : this.empty;
      if (!row && seed) this.pending.push(seed);
      for (const op of this.pending) this.value = op(this.value);
      this.loaded = true;
    } catch (e) {
      this.log.warn?.(`${this.key} not loaded: ${this.store._fail(e)}`);
      return false;
    }
    return this.pending.length ? this.flush() : true;
  }

  /** Apply a change to the in-memory copy now and queue it for the record. */
  mutate(op) {
    this.value = op(this.value);
    this.pending.push(op);
  }

  flush() {
    if (!this.flushing) this.flushing = this._flush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async _flush() {
    if (!this.configured) { this._warn(`${this.key}: the company record is not configured for this bot`); return false; }
    while (this.pending.length) {
      let done = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt++) {
        const ops = this.pending.slice();
        try {
          const row = await this.store.get(this.key);
          let value = row ? row.value : this.empty;
          const seedOp = !row ? this.seedFn?.() : null;
          if (seedOp) value = seedOp(value);
          for (const op of ops) value = op(value);
          const r = await this.store.set(this.key, value, row?.version ?? 0);
          if (!r.ok) continue;
          this.pending.splice(0, ops.length);
          this.version = r.row?.version ?? this.version;
          this.value = value;
          for (const op of this.pending) this.value = op(this.value);
          this.loaded = true;
          done = true;
        } catch (e) {
          this.log.warn?.(`${this.key} not saved: ${this.store._fail(e)}; ${this.pending.length} change(s) stay queued`);
          return false;
        }
      }
      if (!done) { this.log.warn?.(`${this.key} not saved: version conflict, will retry`); return false; }
    }
    return true;
  }
}

module.exports = { KeyedDoc, docKey };
