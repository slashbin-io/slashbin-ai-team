/**
 * A stand-in for the company record's keyed-state API, for tests: GET with the read bearer,
 * PUT with an HMAC over the raw body, compare-and-set on expected_version, 409 with the
 * current version. Nothing leaves loopback.
 */
const { createServer } = require("http");
const { createHmac, timingSafeEqual } = require("crypto");

const READ_TOKEN = "test-read-token";
const SIGNING_KEY = "test-signing-key";

async function startReceiver({ beforePut = null } = {}) {
  const rows = new Map(); // "owner/key" -> { value, version }
  const log = []; // "GET key" / "PUT key vN" lines
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (status, obj) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
      const get = req.url.match(/^\/company-record\/keyed-state\/([^/]+)\/(.+)$/);
      if (req.method === "GET" && get) {
        if (req.headers.authorization !== `Bearer ${READ_TOKEN}`) return json(401, { error: "unauthorized" });
        const k = `${get[1]}/${decodeURIComponent(get[2])}`;
        log.push(`GET ${k}`);
        const row = rows.get(k);
        return row ? json(200, { owner: get[1], key: decodeURIComponent(get[2]), value: row.value, version: row.version, updated_at: new Date().toISOString() }) : json(404, { error: "Unknown key" });
      }
      const put = req.url.match(/^\/slashbin\/([^/]+)\/state$/);
      if (req.method === "PUT" && put) {
        const want = `sha256=${createHmac("sha256", SIGNING_KEY).update(body).digest("hex")}`;
        const got = String(req.headers["x-slashbin-signature"] || "");
        if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return json(401, { error: "bad signature" });
        const { key, expected_version: expected, value } = JSON.parse(body.toString("utf8"));
        const k = `${put[1]}/${key}`;
        if (beforePut) beforePut({ rows, key: k });
        const row = rows.get(k);
        const current = row ? row.version : 0;
        if (current !== expected) { log.push(`PUT ${k} conflict`); return json(409, { current_version: current }); }
        rows.set(k, { value, version: current + 1 });
        log.push(`PUT ${k} v${current + 1}`);
        return json(200, { owner: put[1], key, value, version: current + 1, updated_at: new Date().toISOString() });
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, rows, log,
    env: { COMPANY_RECORD_BASE_URL: url, COMPANY_RECORD_READ_TOKEN: READ_TOKEN, SLASHBIN_STATE_SIGNING_KEY__TEAM_BOT: SIGNING_KEY },
    seed(key, value) { const k = `team-bot/${key}`; rows.set(k, { value, version: (rows.get(k)?.version ?? 0) + 1 }); },
    jobs(key) { return rows.get(`team-bot/${key}`)?.value?.jobs ?? null; },
    close: () => new Promise((r) => server.close(r)),
  };
}
module.exports = { startReceiver, READ_TOKEN, SIGNING_KEY };
