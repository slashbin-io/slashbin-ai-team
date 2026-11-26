// A reply that claims work was filed must carry the link, or it is marked not filed
// (2026-11-26: "filed; request link to be posted" with no request behind it).

const assert = require("assert");
const { claimsFiledWithoutLink, withNoLinkWarning, NO_LINK_WARNING } = require("../lib/filed-claim");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log("filed-claim:");
check("a claim with a GitHub issue URL passes", () =>
  assert.strictEqual(claimsFiledWithoutLink("Filed the issue: https://github.com/slashbin-io/foo/issues/12"), false));
check("a claim with a PR URL passes", () =>
  assert.strictEqual(claimsFiledWithoutLink("I opened a pull request https://github.com/o/r/pull/7"), false));
check("a claim without a URL is flagged", () =>
  assert.strictEqual(claimsFiledWithoutLink("I filed an SRE request for this."), true));
check("'link to be posted' is flagged", () =>
  assert.strictEqual(claimsFiledWithoutLink("Done, request link to be posted."), true));
check("'link to follow' is flagged", () =>
  assert.strictEqual(claimsFiledWithoutLink("Ticket is in, link to follow."), true));
check("SLA-123 counts as a link", () =>
  assert.strictEqual(claimsFiledWithoutLink("I created a ticket, SLA-123."), false));
check("ordinary text is untouched", () => {
  const t = "The deploy finished and the logs look clean.";
  assert.strictEqual(claimsFiledWithoutLink(t), false);
  assert.strictEqual(withNoLinkWarning(t), t);
});
check("non-strings are not flagged", () => {
  assert.strictEqual(claimsFiledWithoutLink(undefined), false);
  assert.strictEqual(claimsFiledWithoutLink(""), false);
});
check("a flagged reply gets one warning line appended", () => {
  const out = withNoLinkWarning("Filed a request.");
  assert.ok(out.startsWith("Filed a request."));
  assert.ok(out.endsWith(NO_LINK_WARNING));
  assert.strictEqual(out.split(NO_LINK_WARNING).length, 2);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
