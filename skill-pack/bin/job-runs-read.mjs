// Reads the bot's scheduled-job history from the company record (job_runs table), newest first,
// mapped back to the old job-history record shape. Standalone: a skill script has no access to lib/.
// Throws Error("job history unavailable: ...") when it cannot read.
export async function listRuns({ limit = 100, env = process.env, fetchImpl = fetch } = {}) {
  for (const v of ["SLASHBIN_DATA_RECEIVER_BASE_URL", "COMPANY_RECORD_READ_TOKEN"]) {
    if (!env[v]) throw new Error(`job history unavailable: ${v} is not set`);
  }
  const q = new URLSearchParams({ limit: String(Math.min(Math.max(1, limit | 0), 500)) });
  let res;
  try {
    res = await fetchImpl(`${env.SLASHBIN_DATA_RECEIVER_BASE_URL.replace(/\/+$/, "")}/company-record/job-runs/team-bot?${q}`, {
      headers: { authorization: `Bearer ${env.COMPANY_RECORD_READ_TOKEN}` }, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { throw new Error(`job history unavailable: ${e?.cause?.code ?? e?.name ?? "network error"}`); }
  if (res.status !== 200) throw new Error(`job history unavailable: HTTP ${res.status}`);
  const { runs } = await res.json();
  return (runs || []).map(rowToRecord);
}

export function rowToRecord(row) {
  let extra = {};
  try { const p = JSON.parse(row.evidence); if (p && typeof p === "object") extra = p; } catch { /* free text */ }
  return {
    id: row.job, ...extra,
    scheduledFor: row.scheduled_for ?? row.started_at,
    firedAt: row.finished_at ?? row.started_at,
    success: row.outcome === "ok",
  };
}
