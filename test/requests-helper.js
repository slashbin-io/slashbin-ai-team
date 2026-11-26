/**
 * The jobs a schedule.mjs run has booked, as the bot would apply them: the add and remove
 * requests left beside the schedules view (lib/schedule-requests.js), in order. A test of the
 * CLI reads them here instead of from a schedules file, which nothing writes any more.
 */
const { readdirSync, readFileSync } = require("fs");
const { join, dirname } = require("path");
const { REQUESTS_DIR } = require("../lib/schedule-requests");

function bookedJobs(viewFile, start = []) {
  const dir = join(dirname(viewFile), REQUESTS_DIR);
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { /* none left */ }
  let jobs = start.slice();
  for (const n of names) {
    const r = JSON.parse(readFileSync(join(dir, n), "utf8"));
    if (r.op === "add") jobs = [...jobs.filter((j) => j.id !== r.job.id), r.job];
    else if (r.op === "remove") jobs = jobs.filter((j) => j.id !== r.id);
  }
  return jobs;
}
module.exports = { bookedJobs };
