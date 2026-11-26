/**
 * Preloaded into every test process by scripts/test.mjs (node --require).
 *
 * The bridge state and the owner-ask bindings live in the company record in production. Most
 * tests only need them to survive "a restart" and to be inspectable, so they pass a file path
 * (`stateFile`, `file`) and this stand-in keeps them in that file, in the same shape the state
 * had when it was one file. The record-backed stores have their own tests (sharded-state.test.js).
 */
const { readFileSync, writeFileSync, renameSync, mkdirSync } = require("fs");
const { dirname } = require("path");

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch (err) { if (err.code === "ENOENT") return null; throw err; } };
const writeJson = (file, v) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${file}.tmp`, file); };

function fileStateStore(file) {
  return {
    read: () => readJson(file),
    write: (raw) => writeJson(file, raw),
    getDoc: (name) => readJson(`${file}.${name}.json`),
    putDoc: (name, value) => { if (value == null) { try { require("fs").unlinkSync(`${file}.${name}.json`); } catch { /* none kept */ } } else writeJson(`${file}.${name}.json`, value); },
  };
}

function fileAskStore(file) {
  const asks = readJson(file)?.asks ?? {};
  return { all: () => ({ ...asks }), put: (id, v) => { asks[id] = JSON.parse(JSON.stringify(v)); writeJson(file, { asks }); } };
}

// Patched when a test first requires the module, never before: loading them here would
// load the record client early, ahead of the test that sets its environment.
const Module = require("module");
const { resolve } = require("path");
const PATCH = {
  [resolve(__dirname, "../../lib/paperclip.js")]: (m) => { const make = m.createPaperclipPoller; m.createPaperclipPoller = (o) => make(o.stateFile && !o.stateStore ? { ...o, stateStore: fileStateStore(o.stateFile) } : o); },
  [resolve(__dirname, "../../lib/owner-asks.js")]: (m) => { const make = m.createOwnerAsks; m.createOwnerAsks = (o) => make(o.file && !o.store ? { ...o, store: fileAskStore(o.file) } : o); },
};
const done = new Set();
const load = Module.prototype.require;
Module.prototype.require = function (id) {
  const m = load.apply(this, arguments);
  let file; try { file = Module._resolveFilename(id, this); } catch { return m; }
  if (PATCH[file] && !done.has(file)) { done.add(file); PATCH[file](m); }
  return m;
};

module.exports = { fileStateStore, fileAskStore };
