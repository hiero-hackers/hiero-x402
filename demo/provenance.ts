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
 * No keys, no env, no network: run it anywhere — `npm run provenance` in a
 * terminal, or the hub's block-proof button (`/demo/provenance`), which runs
 * this same function in-process so a demo never has to leave the screen.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  HBAR_ASSET,
  SCHEME,
  settlementReceiptHTML,
  verdictLine,
  verifySettlementFromBlock,
} from "../src/index.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url));

// The known payment inside fixture block 467: 1 tinybar to 11.12.98,
// identified by its TRUE transaction id (payer@validStart — streams-node
// exposes it since 0.2.0, a change this build fed upstream).
const requirements = {
  scheme: SCHEME,
  network: "hedera:previewnet" as const,
  amount: "1",
  asset: HBAR_ASSET,
  payTo: "11.12.98",
  maxTimeoutSeconds: 180,
  extra: { feePayer: "11.12.2" },
};
const transactionId = "11.12.2@1774994518.000002058";

export interface ProvenanceResult {
  /** The narration, line by line — same words in the terminal and the hub. */
  readonly lines: string[];
  /** The verdict's status word ("paid" on the committed fixture). */
  readonly status: string;
}

/** Verify fixture block 467's own proof and write verified-receipt.html. */
export function runProvenance(): ProvenanceResult {
  const lines: string[] = [];
  lines.push("[provenance] judging the settlement against block 467's OWN proof…");
  const verdict = verifySettlementFromBlock(requirements, transactionId, "demo/preview-payment", {
    blockBytes: fixture("467.blk.gz"),
    genesisBytes: fixture("0.blk.gz"),
  });
  lines.push(`[provenance] ${verdictLine(verdict)}`);
  const provenance = verdict.receipts[0]?.provenance;
  lines.push(
    `[provenance] receipt provenance: ${provenance?.kind ?? "none"} — proof checked before a single field was believed`,
  );
  writeFileSync(
    "verified-receipt.html",
    settlementReceiptHTML(verdict, {
      // The artifact explains itself — a reader must not need the README to
      // decode the old date or the unfamiliar network.
      caveat:
        "Beta demonstration: this proof is verified from a committed PREVIEWNET block " +
        "fixture (block 467 — its real consensus date), because HIP-1056 block streams " +
        "have not reached testnet yet. The pipeline is live; the source is the fixture.",
      // The proof's working — WHAT held before a single field was believed.
      proof: {
        source: "block 467 · hedera:previewnet (committed fixture, real block)",
        anchor: "genesis block 0 — the chain of block hashes ends here",
        checks: [
          "the block's merkle root, recomputed from its own items — not read from a header",
          "the in-band block proof's threshold signature, verified against the ledger id",
          "the settlement transaction located INSIDE the proven block, judged against the terms",
        ],
      },
    }),
  );
  lines.push("[provenance] receipt written to verified-receipt.html");
  lines.push("[provenance] when HIP-1056 block streams reach testnet, the x402 e2e verdict");
  lines.push("[provenance] gains this provenance by swapping the source — nothing else changes.");
  return { lines, status: verdict.fulfilment.status };
}

// ── CLI ────────────────────────────────────────────────────────────────────
// `npm run provenance` — same runProvenance(), spoken aloud.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of runProvenance().lines) console.log(line);
}
