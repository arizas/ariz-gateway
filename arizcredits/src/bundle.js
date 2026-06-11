import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Build the JavaScript bundle that gets posted to arizcredits.near via
 * `post_javascript`. The bundle is the concatenation, in order, of:
 *   1. `aiconversation.js` — existing on-chain FT logic (with the refund
 *      signature public key substituted).
 *   2. `web4_get.js` — the AI-proxy web4 UI that backs arizcredits.near.page;
 *      vendored verbatim from the current on-chain JS so deployments don't
 *      silently drop the frontend.
 *   3. `operator-deduction.js` — gateway-driven usage metering.
 *
 * @param {object} options
 * @param {Uint8Array | number[]} options.refundSignaturePublicKey
 *   Ed25519 public key whose signatures `refund_unspent` will accept. The
 *   aiconversation source has `REPLACE_REFUND_SIGNATURE_PUBLIC_KEY` as a
 *   placeholder substituted here.
 * @param {string} [options.extra]
 *   Optional extra JS to append (for tests that need helpers exposed).
 * @returns {Promise<string>} the assembled JS module text.
 */
export async function buildArizCreditsJs({ refundSignaturePublicKey, extra = "" }) {
  if (!refundSignaturePublicKey) {
    throw new Error("refundSignaturePublicKey is required");
  }
  const bytes = Array.from(refundSignaturePublicKey);
  if (bytes.length !== 32) {
    throw new Error(`refundSignaturePublicKey must be 32 bytes, got ${bytes.length}`);
  }
  const [aiconv, web4get, deduction] = await Promise.all([
    readFile(join(HERE, "aiconversation.js"), "utf8"),
    readFile(join(HERE, "web4_get.js"), "utf8"),
    readFile(join(HERE, "operator-deduction.js"), "utf8"),
  ]);
  const patched = aiconv.replace(
    "REPLACE_REFUND_SIGNATURE_PUBLIC_KEY",
    `[${bytes.join(",")}]`,
  );
  return [patched, web4get, deduction, extra].filter(Boolean).join("\n");
}

/**
 * Same shape as buildArizCreditsJs but returns the bundle that's currently
 * on arizcredits.near — i.e. aiconversation.js + web4_get.js, WITHOUT the
 * operator-deduction module. Used by the upgrade test to simulate the
 * pre-upgrade state of the chain.
 */
export async function buildLegacyArizCreditsJs({ refundSignaturePublicKey }) {
  if (!refundSignaturePublicKey) {
    throw new Error("refundSignaturePublicKey is required");
  }
  const bytes = Array.from(refundSignaturePublicKey);
  const [aiconv, web4get] = await Promise.all([
    readFile(join(HERE, "aiconversation.js"), "utf8"),
    readFile(join(HERE, "web4_get.js"), "utf8"),
  ]);
  const patched = aiconv.replace(
    "REPLACE_REFUND_SIGNATURE_PUBLIC_KEY",
    `[${bytes.join(",")}]`,
  );
  return [patched, web4get].join("\n");
}
