/**
 * The bot's schedules list lives in the company record's keyed state, never in
 * a local file.
 *
 * One key per scope: `schedules/<bot>` (or `schedules/<bot>/<scope>` for a
 * private-channel scope), value `{ "jobs": [...] }`. The bot is the only writer.
 * The scheduler reads a synchronous in-memory copy; every change is an
 * operation (jobs -> jobs) applied to that copy at once and queued for the
 * record. A flush reads the record's current version, re-applies the queued
 * operations to what it read, and writes with compare-and-set on that version;
 * on a conflict it re-reads and re-applies, so a concurrent entry is never lost
 * and nothing is overwritten blindly.
 *
 * Runs never write jobs themselves: they leave a request file (lib/schedule-requests.js)
 * that the bot applies.
 *
 * Reads: GET /company-record/keyed-state/:owner/:key with the read bearer.
 * Writes: PUT /slashbin/:owner/state, HMAC-signed over the exact body bytes.
 * Env: COMPANY_RECORD_BASE_URL, SLASHBIN_STATE_SIGNING_KEY__TEAM_BOT (write),
 * COMPANY_RECORD_READ_TOKEN (read). The write key is taken out of process.env
 * when this module loads, so no agent run inherits it.
 */
const { createHmac } = require("crypto");
const { HARNESS_ENV: JOB_ENV, BASE_VAR, READ_VAR } = require("./job-runs");

const OWNER = "team-bot";
const STATE_KEY_VAR = "SLASHBIN_STATE_SIGNING_KEY__TEAM_BOT";
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;

const HARNESS_ENV = Object.freeze({ [BASE_VAR]: JOB_ENV[BASE_VAR], [READ_VAR]: JOB_ENV[READ_VAR], [STATE_KEY_VAR]: process.env[STATE_KEY_VAR] });
delete process.env[STATE_KEY_VAR];

/** `schedules/<bot>` or `schedules/<bot>/<scope>`. */
function keyFor(bot, scope = null) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
  return scope == null ? `schedules/${clean(bot)}` : `schedules/${clean(bot)}/${clean(scope)}`;
}

/** The jobs in a stored value. Anything else is no jobs. */
function jobsOf(value) {
  const list = Array.isArray(value) ? value : value && Array.isArray(value.jobs) ? value.jobs : [];
  return list.filter((j) => j && typeof j === "object");
}

const sign = (body, key) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

class ScheduleStore {
  constructor({ env = HARNESS_ENV, bot = "bot", log = console, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
    this.env = env; this.bot = bot; this.log = log; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    this.scopes = new Map(); // key -> { jobs, version, loaded, pending: [], flushing: Promise|null }
    this.warned = new Set();
  }

  get configured() { return Boolean(this.env[BASE_VAR] && this.env[READ_VAR] && this.env[STATE_KEY_VAR]); }

  keyFor(scope = null) { return keyFor(this.bot, scope); }

  _warnOnce(k, msg) { if (this.warned.has(k)) return; this.warned.add(k); this.log.warn?.(msg); }

  _state(key) {
    if (!this.scopes.has(key)) this.scopes.set(key, { jobs: [], version: 0, loaded: false, pending: [], flushing: null });
    return this.scopes.get(key);
  }

  _url(path) { return `${this.env[BASE_VAR].replace(/\/+$/, "")}${path}`; }

  /** The row {value, version}, or null when the key is absent. Throws on anything else. */
  async get(key) {
    const res = await this.fetch(this._url(`/company-record/keyed-state/${OWNER}/${encodeURIComponent(key)}`), {
      method: "GET", headers: { authorization: `Bearer ${this.env[READ_VAR]}` }, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(text);
  }

  /** Compare-and-set. {ok:true,row} | {ok:false,currentVersion}; anything else throws. */
  async set(key, value, expectedVersion) {
    const body = Buffer.from(JSON.stringify({ key, expected_version: expectedVersion, value }), "utf8");
    const res = await this.fetch(this._url(`/slashbin/${OWNER}/state`), {
      method: "PUT",
      headers: { "content-type": "application/json", "x-slashbin-signature": sign(body, this.env[STATE_KEY_VAR]) },
      body, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.status === 409) return { ok: false, currentVersion: parsed?.current_version ?? null };
    if (res.status === 200) return { ok: true, row: parsed };
    throw new Error(`HTTP ${res.status}`);
  }

  _fail(e) {
    const why = e?.name === "TimeoutError" ? "timeout" : (e?.cause?.code ?? e?.code ?? e?.message ?? "network error");
    return String(why);
  }

  /** Load a scope's jobs from the record into the in-memory copy. Resolves true when loaded. */
  async load(scope = null) {
    if (!this.configured) { this._warnOnce("cfg", "schedules not available: the company record is not configured for this bot"); return false; }
    const key = this.keyFor(scope), s = this._state(key);
    try {
      const row = await this.get(key);
      s.version = row?.version ?? 0;
      s.jobs = jobsOf(row?.value);
      for (const op of s.pending) s.jobs = op(s.jobs);
      s.loaded = true;
      return true;
    } catch (e) {
      this.log.warn?.(`schedules not loaded (${key}): ${this._fail(e)}`);
      return false;
    }
  }

  isLoaded(scope = null) { return this._state(this.keyFor(scope)).loaded; }

  /** The scope's jobs as last loaded, plus every change made since (a copy). */
  jobs(scope = null) { return this._state(this.keyFor(scope)).jobs.slice(); }

  /**
   * Apply a change (jobs -> jobs, pure and safe to apply twice) to the in-memory copy now and queue it for the record.
   * A scope that never loaded refuses it, so nothing is written over a list that was never read.
   */
  mutate(scope, op) {
    const s = this._state(this.keyFor(scope));
    if (!s.loaded) throw new Error("schedules not loaded: not changed");
    s.jobs = op(s.jobs);
    s.pending.push(op);
  }

  /** Write every queued change of one scope. Resolves true when nothing is left queued. */
  flush(scope = null) {
    const s = this._state(this.keyFor(scope));
    if (!s.flushing) {
      s.flushing = this._flush(this.keyFor(scope), s).finally(() => { s.flushing = null; });
    }
    return s.flushing;
  }

  async flushAll() {
    let ok = true;
    for (const key of this.scopes.keys()) {
      const s = this.scopes.get(key);
      if (!s.pending.length && !s.flushing) continue;
      if (!s.flushing) s.flushing = this._flush(key, s).finally(() => { s.flushing = null; });
      ok = (await s.flushing) && ok;
    }
    return ok;
  }

  async _flush(key, s) {
    while (s.pending.length) {
      let done = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt++) {
        const ops = s.pending.slice();
        try {
          const row = await this.get(key);
          let jobs = jobsOf(row?.value);
          for (const op of ops) jobs = op(jobs);
          const r = await this.set(key, { jobs }, row?.version ?? 0);
          if (!r.ok) continue; // a version conflict: re-read, re-apply
          s.pending.splice(0, ops.length);
          s.version = r.row?.version ?? s.version;
          s.jobs = jobs;
          for (const op of s.pending) s.jobs = op(s.jobs);
          done = true;
        } catch (e) {
          this.log.warn?.(`schedules not saved (${key}): ${this._fail(e)}; ${s.pending.length} change(s) stay queued`);
          return false;
        }
      }
      if (!done) { this.log.warn?.(`schedules not saved (${key}): version conflict, will retry`); return false; }
    }
    return true;
  }

  /**
   * One-time import of a list into a key that does not exist yet. {status}: "imported" | "exists" | "empty".
   * Never overwrites: an existing key is left as it is.
   */
  async importList(scope, list) {
    const key = this.keyFor(scope);
    const row = await this.get(key);
    if (row) return { status: "exists", key, version: row.version };
    const jobs = jobsOf(list);
    const r = await this.set(key, { jobs }, 0);
    if (!r.ok) return { status: "exists", key, version: r.currentVersion };
    return { status: "imported", key, jobs: jobs.length };
  }
}

module.exports = { ScheduleStore, keyFor, jobsOf, HARNESS_ENV, OWNER, STATE_KEY_VAR };
