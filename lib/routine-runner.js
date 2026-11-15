/**
 * Routine runner — a routine's card answered by a command, with no model run.
 *
 * A routine's card often asks for nothing a model adds: "run this job and post
 * what it reported". A model run to relay that costs a full session each time
 * the routine fires. With PAPERCLIP_ROUTINE_RUNNER set, the harness hands such
 * a card to that command first, and starts the model only when the command
 * does not answer it.
 *
 * The command's contract:
 *
 *   stdin   one JSON object: { identifier, title, description } of the card
 *   exit 0  stdout is the answer, posted as the model's reply would be. It may
 *           end with an outcome line (lib/paperclip.js OUTCOME_MARK) to leave
 *           the card blocked.
 *   exit 3  "not mine": the model is started on the card, as without a runner
 *   other   a failure of the command itself: logged, and the model is started
 *
 * The command may be started again for the same card (a restarted bot, a run
 * the board lost), so it must be safe to repeat. It runs in the run's working
 * directory with the run's environment, and it is the operator's own code: it
 * is not confined as a model run is.
 */
const { spawn: nodeSpawn } = require("child_process");

const DECLINED = 3;
const MAX_ANSWER_BYTES = 60_000;
const CUT = "\n[The rest of the runner's output is left out: it is longer than one answer may be.]";

/** PAPERCLIP_ROUTINE_RUNNER as [bin, ...args], or null when unset. Split on spaces; no shell reads it. */
function parseRoutineRunner(value) {
  const parts = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * @param {string[]} o.command   [bin, ...args] (parseRoutineRunner)
 * @param {string} o.cwd         the run's working directory
 * @param {Function} o.env       () => the run's environment, built per start
 * @param {number} o.timeoutMs   how long the command may take; 0, no limit
 * @returns {(issue: object) => Promise<string|null>}  the answer, or null when the command declined
 */
function createRoutineRunner({ command, cwd, env, timeoutMs = 0, log, spawn = nodeSpawn }) {
  const [bin, ...args] = command;
  return (issue) => new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try { child = spawn(bin, args, { cwd, env: env(), stdio: ["pipe", "pipe", "pipe"] }); } catch (err) { reject(err); return; }
    let out = "", errText = "", bytes = 0, cut = false, timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs) : null;
    child.stdout.on("data", (d) => {
      if (cut) return;
      bytes += d.length;
      if (bytes > MAX_ANSWER_BYTES) { cut = true; return; }
      out += d;
    });
    child.stderr.on("data", (d) => { errText = `${errText}${d}`.slice(-2000); });
    child.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const ms = Date.now() - started;
      if (timedOut) return reject(new Error(`routine runner stopped after ${timeoutMs} ms without an answer`));
      if (code === DECLINED) return resolve(null);
      if (code !== 0) return reject(new Error(`routine runner exited ${code ?? signal}: ${errText.trim().slice(-500) || "no error output"}`));
      const answer = `${out.trim()}${cut ? CUT : ""}`;
      if (!answer) return reject(new Error("routine runner exited 0 with no answer"));
      log?.info({ issue: issue.identifier, ms }, "Routine card answered by its runner — no model run");
      resolve(answer);
    });
    // A command that never reads stdin must not take the bot down with EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ identifier: issue.identifier ?? null, title: issue.title ?? "", description: issue.description ?? "" }));
  });
}

module.exports = { parseRoutineRunner, createRoutineRunner, DECLINED, MAX_ANSWER_BYTES };
