/**
 * A reply that says work was filed with no link to it.
 *
 * 2026-11-26: the EM bot told a customer in #jerky-em that an SRE request was
 * "filed; request link to be posted" when no request existed. A claim of filed
 * work is only checkable through its link, so a reply that makes the claim and
 * carries no GitHub issue/PR URL and no Paperclip identifier (SLA-123) is marked
 * as not filed. Checked on the WHOLE reply text, before it is split into chunks.
 */

const CLAIM = /\b(filed|opened|raised|created)\b.{0,40}\b(issue|request|PR|pull request|card|ticket)\b/i;
const PROMISED_LINK = /\blink\s+(to\s+be\s+posted|to\s+follow)\b/i;
const GITHUB_LINK = /github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+/i;
const PAPERCLIP_ID = /\bSLA-\d+\b/;

const NO_LINK_WARNING =
  "⚠️ No link: this reply says something was filed but names no issue link, so treat it as not filed.";

function claimsFiledWithoutLink(text) {
  if (typeof text !== "string" || !text) return false;
  if (!CLAIM.test(text) && !PROMISED_LINK.test(text)) return false;
  return !GITHUB_LINK.test(text) && !PAPERCLIP_ID.test(text);
}

/** The reply to send: unchanged, or with one visible warning line appended. */
function withNoLinkWarning(text) {
  return claimsFiledWithoutLink(text) ? `${text}\n\n${NO_LINK_WARNING}` : text;
}

module.exports = { claimsFiledWithoutLink, withNoLinkWarning, NO_LINK_WARNING };
