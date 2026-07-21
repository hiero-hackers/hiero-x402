// SPDX-License-Identifier: Apache-2.0
/**
 * The trust ladder's top rung, demonstrated end to end: the SAME verdict
 * pipeline as `npm run e2e`, judging a specific payment — but against a
 * **cryptographically proven block** instead of the mirror's attested record.
 *
 *   1. the facilitator's word        — where every x402 flow stops
 *   2. the public mirror node        — `npm run e2e` (receipt stamped
 *                                      UNVERIFIED: operator-attested data)
 *   3. the block stream's own proof  — THIS: `verifySettlementFromBlock`
 *
 * Honesty first: block streams (HIP-1056) are not on testnet yet, so this
 * cannot verify our x402 settlement — the committed fixtures are real blocks
 * from the block-stream preview network, and the payment judged below is one
 * that actually happened there. The day block streams reach testnet, the
 * e2e's verdict gains this provenance by swapping the source.
 *
 * No keys, no env, no network: run it anywhere.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { settlementReceiptHTML, verdictLine, verifySettlementFromBlock } from "../src/index.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

// The known payment inside fixture block 467: 1 tinybar to 11.12.98,
// identified by its TRUE transaction id (payer@validStart — streams-node
// exposes it since 0.2.0, a change this build fed upstream).
const requirements = {
  scheme: "exact",
  network: "hedera:previewnet" as const,
  amount: "1",
  asset: "0.0.0",
  payTo: "11.12.98",
  maxTimeoutSeconds: 180,
  extra: { feePayer: "11.12.2" },
};
const transactionId = "11.12.2@1774994518.000002058";

console.log("[provenance] judging the settlement against block 467's OWN proof…");
const verdict = verifySettlementFromBlock(requirements, transactionId, "demo/preview-payment", {
  blockBytes: fixture("467.blk.gz"),
  genesisBytes: fixture("0.blk.gz"),
});

console.log(`[provenance] ${verdictLine(verdict)}`);
const provenance = verdict.receipts[0]?.provenance;
console.log(
  `[provenance] receipt provenance: ${provenance?.kind ?? "none"} — proof checked before a single field was believed`,
);
writeFileSync("verified-receipt.html", settlementReceiptHTML(verdict));
console.log("[provenance] receipt written to verified-receipt.html");
console.log("[provenance] when HIP-1056 block streams reach testnet, the x402 e2e verdict");
console.log("[provenance] gains this provenance by swapping the source — nothing else changes.");
