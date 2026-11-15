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
    // Its own process group, so a command past its time is stopped with everything it started.
    try { child = spawn(bin, args, { cwd, env: env(), stdio: ["pipe", "pipe", "pipe"], detached: true }); } catch (err) { reject(err); return; }
    const chunks = [];
    let errText = "", bytes = 0, cut = false, settled = false, timer = null;
    const settle = (fn, value) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(value); };
    if (timeoutMs > 0) timer = setTimeout(() => {
      // The deadline settles the card here. Waiting for "close" would wait on any
      // subprocess still holding the command's output open, with no limit.
      stopGroup(child);
      child.stdout?.destroy?.(); child.stderr?.destroy?.();
      settle(reject, new Error(`routine runner stopped after ${timeoutMs} ms without an answer`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (cut) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      const room = MAX_ANSWER_BYTES - bytes;
      if (chunk.length > room) { cut = true; if (room > 0) chunks.push(chunk.subarray(0, room)); bytes = MAX_ANSWER_BYTES; return; }
      chunks.push(chunk); bytes += chunk.length;
    });
    child.stderr.on("data", (d) => { errText = `${errText}${d}`.slice(-2000); });
    child.on("error", (err) => settle(reject, err));
    child.on("close", (code, signal) => {
      if (settled) return;
      const ms = Date.now() - started;
      if (code === DECLINED) return settle(resolve, null);
      if (code !== 0) return settle(reject, new Error(`routine runner exited ${code ?? signal}: ${errText.trim().slice(-500) || "no error output"}`));
      const answer = answerText(Buffer.concat(chunks), cut);
      if (!answer) return settle(reject, new Error("routine runner exited 0 with no answer"));
      log?.info({ issue: issue.identifier, ms }, "Routine card answered by its runner — no model run");
      settle(resolve, answer);
    });
    // A command that never reads stdin must not take the bot down with EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ identifier: issue.identifier ?? null, title: issue.title ?? "", description: issue.description ?? "" }));
  });
}

/** Stops the command and what it started; the command alone where it has no group of its own. */
function stopGroup(child) {
  try { if (child.pid) { process.kill(-child.pid, "SIGKILL"); return; } } catch { /* no such group: fall through */ }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

/**
 * The command's output as one answer of at most MAX_ANSWER_BYTES, the notice included.
 * Decoded once, whole: a character split across two reads is still one character.
 */
function answerText(buf, cut) {
  if (!cut) return buf.toString("utf8").trim();
  let end = Math.min(buf.length, MAX_ANSWER_BYTES - Buffer.byteLength(CUT));
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // never end inside a character
  return `${buf.subarray(0, end).toString("utf8").trim()}${CUT}`;
}

module.exports = { parseRoutineRunner, createRoutineRunner, DECLINED, MAX_ANSWER_BYTES };
