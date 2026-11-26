/**
 * How a run books or removes a scheduled job.
 *
 * A run holds no credential for the company record, so it cannot write the
 * schedules list. It leaves a request file in `schedule-requests/` beside the
 * schedules view it was given (BOT_SCHEDULES_FILE); the bot reads the folder after
 * the run and applies each request to the record, then deletes the file. A request
 * is one JSON object: `{ "op": "add", "job": {...} }` or `{ "op": "remove", "id": "..." }`.
 *
 * The folder is a run's to write, so the bot reads it as untrusted: it must be a
 * real folder (never a link), each entry a plain file of bounded size, and a job
 * is judged by its content, never by where it was found.
 */
const { join } = require("path");
const { readdirSync, lstatSync, openSync, closeSync, fstatSync, readFileSync, unlinkSync, constants } = require("fs");

const REQUESTS_DIR = "schedule-requests";
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 100;
const NAME = /^[A-Za-z0-9._-]{1,120}\.json$/;

const requestsDirFor = (viewFile) => join(require("path").dirname(viewFile), REQUESTS_DIR);

/** The request or the reason it is refused. */
function parseRequest(text) {
  let r;
  try { r = JSON.parse(text); } catch { return { problem: "not valid JSON" }; }
  if (!r || typeof r !== "object" || Array.isArray(r)) return { problem: "not an object" };
  if (r.op === "remove") {
    if (typeof r.id !== "string" || !r.id || r.id.length > 200) return { problem: "remove needs an id" };
    return { request: { op: "remove", id: r.id } };
  }
  if (r.op === "add") {
    const j = r.job;
    if (!j || typeof j !== "object" || Array.isArray(j)) return { problem: "add needs a job" };
    if (typeof j.id !== "string" || !j.id || j.id.length > 200) return { problem: "job needs an id" };
    if (typeof j.prompt !== "string" || !j.prompt) return { problem: "job needs a prompt" };
    if (typeof j.cron !== "string" && typeof j.runAt !== "string") return { problem: "job needs a cron or a runAt" };
    if (j.channel == null || !/^\d+$/.test(String(j.channel))) return { problem: "job needs a Discord channel id" };
    return { request: { op: "add", job: j } };
  }
  return { problem: "unknown op" };
}

/**
 * Every request waiting in a folder: [{ file, request }] and [{ file, problem }] for the ones refused.
 * A missing folder is no requests; a link or non-folder in its place is refused whole.
 */
function readRequests(dir) {
  let st;
  try { st = lstatSync(dir); } catch { return { requests: [], refused: [], dirId: null }; }
  if (!st.isDirectory()) return { requests: [], refused: [{ file: dir, problem: "not a plain folder" }], dirId: null };
  const dirId = { dev: st.dev, ino: st.ino };
  const requests = [], refused = [];
  let names = readdirSync(dir).sort();
  if (names.length > MAX_FILES) names = names.slice(0, MAX_FILES);
  for (const name of names) {
    const file = join(dir, name);
    if (!NAME.test(name)) { refused.push({ file, problem: "unexpected name" }); continue; }
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const fst = fstatSync(fd);
      if (!fst.isFile()) { refused.push({ file, problem: "not a plain file" }); continue; }
      if (fst.size > MAX_FILE_BYTES) { refused.push({ file, problem: "too large" }); continue; }
      const parsed = parseRequest(readFileSync(fd, "utf8"));
      if (parsed.problem) refused.push({ file, problem: parsed.problem }); else requests.push({ file, name, request: parsed.request });
    } catch (e) {
      refused.push({ file, problem: `not read (${e.code || e.message})` });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return { requests, refused, dirId };
}

/**
 * Delete one request file, only inside the folder it was read from.
 *
 * The folder is a run's to write, so it can be swapped for a link between the read and
 * the delete. The folder is opened without following a link and checked to be the same
 * one that was read; the file is then removed through that open handle, so a later swap
 * of the path cannot send the delete anywhere else. Throws, leaving the file, when it
 * cannot be sure.
 */
function deleteRequest(dir, name, dirId) {
  if (!NAME.test(name)) throw new Error("not a request name");
  if (!dirId) throw new Error("folder identity unknown");
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (st.dev !== dirId.dev || st.ino !== dirId.ino) throw new Error("the folder is no longer the one that was read");
    unlinkSync(`/proc/self/fd/${fd}/${name}`);
  } finally {
    closeSync(fd);
  }
}

/** The list after a remove request: only a job the scope owns goes; a foreign row sharing the id stays. */
const withoutOwn = (jobs, id, isOwn) => jobs.filter((j) => !(j.id === id && isOwn(j)));

module.exports = { withoutOwn, REQUESTS_DIR, requestsDirFor, parseRequest, readRequests, deleteRequest };
