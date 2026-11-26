#!/usr/bin/env node
/**
 * One-time import of a bot's local schedules file(s) into the company record's keyed state.
 *
 *   node scripts/import-schedules.mjs --bot <name> --state-dir <dir> [--private]
 *
 * Idempotent: a key that already exists is left alone and reported `exists`;
 * a missing key is created (expected_version 0) and reported `imported`. It
 * only reads the local files and writes nothing locally. With --private it
 * imports each channel folder's own list under its own key.
 * Needs COMPANY_RECORD_BASE_URL, COMPANY_RECORD_READ_TOKEN and
 * SLASHBIN_STATE_SIGNING_KEY__TEAM_BOT in the environment. Prints no secret.
 */
import { createRequire } from "module";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const require = createRequire(import.meta.url);

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

function readList(file) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

export async function importSchedules({ bot, stateDir, priv = false, env = { ...process.env }, fetchImpl = fetch, out = console.log }) {
  const { ScheduleStore } = require("../lib/schedule-store.js");
  const privateChannels = require("../lib/private-channels.js");
  const store = new ScheduleStore({ env, bot, fetchImpl, log: { warn: (m) => out(`warn ${m}`) } });
  if (!store.configured) throw new Error("the company record is not configured (base url, read token and signing key are all required)");
  const targets = [];
  if (!priv) targets.push({ scope: null, file: join(stateDir, "schedules.json") });
  else {
    let names = [];
    try { names = readdirSync(join(stateDir, "channels")); } catch { /* none */ }
    for (const n of names.filter((x) => /^[A-Za-z0-9._-]{1,120}$/.test(x))) {
      targets.push({ scope: n, file: privateChannels.channelPaths(stateDir, n).schedules });
    }
  }
  const results = [];
  for (const t of targets) {
    const r = await store.importList(t.scope, readList(t.file));
    out(`${r.status} ${r.key}${r.jobs != null ? ` jobs=${r.jobs}` : ""}${r.version != null ? ` version=${r.version}` : ""}`);
    results.push(r);
  }
  if (!targets.length) out("nothing to import");
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const bot = arg(argv, "--bot"), stateDir = arg(argv, "--state-dir");
  if (!bot || !stateDir) { console.error("usage: import-schedules.mjs --bot <name> --state-dir <dir> [--private]"); process.exit(2); }
  importSchedules({ bot, stateDir, priv: argv.includes("--private") }).catch((e) => { console.error(`import failed: ${e.message}`); process.exit(1); });
}
