/**
 * scripts/import-schedules.mjs moves a bot's local schedules file(s) into keyed state once:
 * a missing key is created, an existing key is left alone and reported `exists`, and nothing is
 * written locally. Runs against a loopback stand-in for the record.
 */
const { mkdtempSync, mkdirSync, writeFileSync, readdirSync } = require("fs");
const { join } = require("path");
const os = require("os");
const assert = require("assert");
const { spawn } = require("child_process");
const runNode = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { env }); let stdout = "", stderr = "";
  c.stdout.on("data", (d) => { stdout += d; }); c.stderr.on("data", (d) => { stderr += d; });
  c.on("close", (status) => resolve({ status, stdout, stderr }));
});
const { startReceiver } = require("./fake-receiver");

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); } catch (err) { console.log(`  FAIL ${name}\n       ${err.message}`); failed++; }
}
const job = (id, channel = "111") => ({ id, channel, cron: "0 9 * * *", prompt: `do ${id}` });
const snapshot = (dir) => JSON.stringify(readdirSync(dir, { recursive: true }).sort());

(async () => {
  console.log("\nImport schedules — local files into keyed state, once");
  const rec = await startReceiver();
  const { env: creds } = rec;
  const script = join(__dirname, "..", "scripts", "import-schedules.mjs");
  const run = (args) => runNode([script, ...args], { PATH: process.env.PATH, ...creds });

  await check("a bot's file is imported once; a re-run prints exists and writes nothing", async () => {
    const state = mkdtempSync(join(os.tmpdir(), "imp-"));
    writeFileSync(join(state, "schedules.json"), JSON.stringify([job("a"), job("b")]));
    const before = snapshot(state);
    const first = await run(["--bot", "eng", "--state-dir", state]);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.match(first.stdout, /^imported schedules\/eng jobs=2/);
    assert.deepStrictEqual(rec.jobs("schedules/eng").map((j) => j.id), ["a", "b"]);
    const puts = rec.log.filter((l) => l.startsWith("PUT")).length;
    const again = await run(["--bot", "eng", "--state-dir", state]);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stdout, /^exists schedules\/eng/);
    assert.strictEqual(rec.log.filter((l) => l.startsWith("PUT")).length, puts, "a re-run wrote");
    assert.strictEqual(snapshot(state), before, "the import wrote locally");
  });

  await check("private mode imports each channel folder under its own key, keeping its rows as they are", async () => {
    const state = mkdtempSync(join(os.tmpdir(), "imp-"));
    for (const [n, list] of [["alpha", [job("x", "1"), job("foreign", "9")]], ["beta", [job("y", "2")]]]) {
      mkdirSync(join(state, "channels", n, "jobs"), { recursive: true });
      writeFileSync(join(state, "channels", n, "jobs", "schedules.json"), JSON.stringify(list));
    }
    const r = await run(["--bot", "privbot", "--state-dir", state, "--private"]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(rec.jobs("schedules/privbot/alpha").map((j) => j.id), ["x", "foreign"]);
    assert.deepStrictEqual(rec.jobs("schedules/privbot/beta").map((j) => j.id), ["y"]);
    assert.match((await run(["--bot", "privbot", "--state-dir", state, "--private"])).stdout, /exists schedules\/privbot\/alpha[\s\S]*exists schedules\/privbot\/beta/);
  });

  await check("no file imports an empty list; an unconfigured record fails and prints no secret", async () => {
    const state = mkdtempSync(join(os.tmpdir(), "imp-"));
    assert.match((await run(["--bot", "empty", "--state-dir", state])).stdout, /^imported schedules\/empty jobs=0/);
    const bad = await runNode([script, "--bot", "x", "--state-dir", state], { PATH: process.env.PATH });
    assert.notStrictEqual(bad.status, 0);
    assert.ok(!/test-signing-key|test-read-token/.test(bad.stdout + bad.stderr));
  });

  await rec.close();
  process.exit(failed ? 1 : 0);
})();
