/**
 * The bot's scheduled-job history lives in the company record's job_runs table
 * (slashbin_data_receiver), never in a local file.
 *
 * Write: a signed POST to /slashbin/job-run/events. The receiver answers 202
 * before it maps, so a write is best-effort here: it logs one line and never
 * throws into the scheduler. A terminal row is never overwritten receiver-side,
 * so a repeated post is harmless.
 * Read: the bearer routes /company-record/job-runs/team-bot[/:runKey].
 *
 * Env: SLASHBIN_DATA_RECEIVER_BASE_URL, SLASHBIN_EVENTS_SIGNING_KEY__JOB_RUN
 * (write), COMPANY_RECORD_READ_TOKEN (read).
 */
const { createHmac } = require("crypto");
const os = require("os");

const SCHEDULER = "team-bot";
const BASE_VAR = "SLASHBIN_DATA_RECEIVER_BASE_URL";
const KEY_VAR = "SLASHBIN_EVENTS_SIGNING_KEY__JOB_RUN";
const READ_VAR = "COMPANY_RECORD_READ_TOKEN";
const TIMEOUT_MS = 10_000;
const EVIDENCE_MAX = 2000;

const warned = new Set();
function warnOnce(key, msg, log) {
  if (warned.has(key)) return;
  warned.add(key);
  (log || console).warn ? (log || console).warn(msg) : console.log(msg);
}

/** run_key: `<job id>:<firedAt ISO>` with anything outside [A-Za-z0-9._:-] replaced, <= 200 chars. */
function runKeyFor(id, firedAt) {
  return `${id}:${firedAt}`.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 200);
}

/** The old job-history record -> one terminal receiver event body (an object). */
function eventFromRecord(record, { host = os.hostname() } = {}) {
  const { id, scheduledFor, firedAt, success, ...extra } = record;
  let evidence = JSON.stringify(extra);
  if (evidence.length > EVIDENCE_MAX) {
    // Keep it parseable: shorten the error text, the only unbounded field.
    const over = evidence.length - EVIDENCE_MAX;
    if (typeof extra.error === "string" && extra.error.length > over + 1) {
      evidence = JSON.stringify({ ...extra, error: extra.error.slice(0, extra.error.length - over - 1) });
    }
    evidence = evidence.slice(0, EVIDENCE_MAX);
  }
  const fired = firedAt || new Date().toISOString();
  return {
    scheduler: SCHEDULER,
    run_key: runKeyFor(id, fired),
    job: String(id).slice(0, 200),
    scheduled_for: scheduledFor || null,
    started_at: scheduledFor || fired,
    finished_at: fired,
    outcome: success ? "ok" : "failed",
    evidence,
    provenance: { host, producer: "slashbin-ai-team" },
  };
}

function sign(body, key) {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

/**
 * Post one terminal event for an old-shape record. Resolves { ok, status?, error? }; never rejects.
 */
async function recordExecution(record, { env = process.env, log, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    for (const v of [BASE_VAR, KEY_VAR]) {
      if (!env[v]) {
        warnOnce(v, `job history not recorded: ${v} is not set`, log);
        return { ok: false, error: `${v} is not set` };
      }
    }
    const event = eventFromRecord(record);
    const body = Buffer.from(JSON.stringify(event), "utf8");
    const res = await fetchImpl(`${env[BASE_VAR].replace(/\/+$/, "")}/slashbin/job-run/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slashbin-signature": sign(body, env[KEY_VAR]),
        "x-slashbin-job-id": `${SCHEDULER}:${event.run_key}:finished`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => {});
    if (res.status === 202) return { ok: true, status: 202 };
    (log || console).warn?.(`job history not recorded for ${event.run_key}: HTTP ${res.status}`);
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    const why = e?.name === "TimeoutError" ? "timeout" : (e?.cause?.code ?? e?.code ?? e?.name ?? "network error");
    try { (log || console).warn?.(`job history not recorded: ${why}`); } catch { /* never into the scheduler */ }
    return { ok: false, error: String(why) };
  }
}

/** A receiver row -> the old job-history record shape. */
function rowToRecord(row) {
  let extra = {};
  try { const p = JSON.parse(row.evidence); if (p && typeof p === "object") extra = p; } catch { /* free text */ }
  return {
    id: row.job,
    ...extra,
    scheduledFor: row.scheduled_for ?? row.started_at,
    firedAt: row.finished_at ?? row.started_at,
    success: row.outcome === "ok",
    ...(row.outcome === "running" ? { running: true } : {}),
  };
}

/** Recent runs, newest first, as old-shape records. Throws Error("job history unavailable: ...") when it cannot read. */
async function listRuns({ since, limit = 100, env = process.env, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  for (const v of [BASE_VAR, READ_VAR]) {
    if (!env[v]) throw new Error(`job history unavailable: ${v} is not set`);
  }
  const q = new URLSearchParams({ limit: String(Math.min(Math.max(1, limit | 0), 500)) });
  if (since) q.set("since", since);
  const res = await fetchImpl(`${env[BASE_VAR].replace(/\/+$/, "")}/company-record/job-runs/${SCHEDULER}?${q}`, {
    headers: { authorization: `Bearer ${env[READ_VAR]}` }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) { await res.arrayBuffer().catch(() => {}); throw new Error(`job history unavailable: HTTP ${res.status}`); }
  const { runs } = await res.json();
  return (runs || []).map(rowToRecord);
}

module.exports = { SCHEDULER, BASE_VAR, KEY_VAR, READ_VAR, EVIDENCE_MAX, runKeyFor, eventFromRecord, recordExecution, rowToRecord, listRuns };
