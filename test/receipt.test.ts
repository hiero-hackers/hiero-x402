// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { settlementReceiptHTML, verdictLine, verifySettlement } from "../src/index.js";
import {
  HBAR_REQUEST,
  REQUIREMENTS,
  SETTLEMENT_ID,
  fetchStub,
  hbarRow,
  tokenRow,
} from "./helpers.js";

async function verdictFor(credited: number) {
  const { fetchImpl } = fetchStub([hbarRow(credited)]);
  return verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, { fetchImpl });
}

describe("verdictLine", () => {
  it("speaks plainly for each outcome", async () => {
    expect(verdictLine(await verdictFor(5_000_000))).toMatch(/Paid in full/);
    expect(verdictLine(await verdictFor(4_000_000))).toMatch(/Underpaid/);
    expect(verdictLine(await verdictFor(6_000_000))).toMatch(/more than asked/);
  });

  it("covers no-payment outcomes", async () => {
    const { fetchImpl } = fetchStub(undefined, 404);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, {
      fetchImpl,
    });
    expect(verdictLine(verdict)).toMatch(/Not paid/);
  });

  it("covers wrong-asset via a token where HBAR was asked", async () => {
    const { fetchImpl } = fetchStub([tokenRow(5_000_000)]);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, {
      fetchImpl,
    });
    expect(verdictLine(verdict)).toMatch(/wrong asset or wrong destination/);
  });

  it("covers expired and unknown statuses on hand-built verdicts", async () => {
    const base = await verdictFor(5_000_000);
    expect(verdictLine({ ...base, fulfilment: { status: "expired" } })).toMatch(/deadline passed/);
    expect(verdictLine({ ...base, fulfilment: { status: "novel" } as never })).toMatch(
      /Outcome: novel/,
    );
  });
});

describe("settlementReceiptHTML", () => {
  it("carries the verdict, the reference, both proof links, and the receipt body", async () => {
    const verdict = await verdictFor(5_000_000);
    const html = settlementReceiptHTML(verdict);
    // The mirror rung is a "mirror receipt", never "verified" — the banner
    // must not contradict the UNVERIFIED-stamped body (review request).
    expect(html).toContain("Mirror receipt");
    expect(html).toContain("AGENT RAIL · x402"); // the rail chip — evidence, not species
    expect(html).toContain("Paid in full");
    expect(html).toContain(HBAR_REQUEST.reference);
    expect(html).toContain("hashscan.io/testnet/transaction/");
    expect(html).toContain("/api/v1/transactions/"); // the raw mirror-node record link
    expect(html).toContain("public mirror node");
    expect(html).toContain("not the facilitator");
  });

  it("says block proof — not mirror — when the receipts are cryptographically verified", async () => {
    const { verifySettlementFromBlock } = await import("../src/index.js");
    const { readFileSync } = await import("node:fs");
    const fixture = (name: string): Buffer =>
      readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
    const verdict = verifySettlementFromBlock(
      {
        scheme: "exact",
        network: "hedera:previewnet",
        amount: "1",
        asset: "0.0.0",
        payTo: "11.12.98",
        maxTimeoutSeconds: 180,
        extra: { feePayer: "11.12.2" },
      },
      "11.12.2@1774994518.000002058",
      "r",
      { blockBytes: fixture("467.blk.gz"), genesisBytes: fixture("0.blk.gz") },
    );
    const html = settlementReceiptHTML(verdict);
    expect(html).toContain("block proof");
    expect(html).toContain("independently verified"); // this is the rung we DO call verified
    expect(html).not.toContain("mirror node");
    expect(html).not.toContain("/api/v1/transactions/"); // no mirror is consulted on this path
  });

  it("answers 'did I pay what was asked?' from the receipt alone — quoted next to settled", async () => {
    const exact = settlementReceiptHTML(await verdictFor(5_000_000));
    expect(exact).toContain("5000000 atomic units"); // the quote
    expect(exact).toContain("5000000 atomic units — exact"); // the chain's answer
    const over = settlementReceiptHTML(await verdictFor(6_000_000));
    expect(over).toContain("6000000 atomic units — 1000000 over");
    const under = settlementReceiptHTML(await verdictFor(4_000_000));
    expect(under).toContain("4000000 atomic units — 1000000 short");
  });

  it("says 'nothing credited' plainly when no payment fulfils the terms", async () => {
    const { fetchImpl } = fetchStub(undefined, 404);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, {
      fetchImpl,
    });
    expect(settlementReceiptHTML(verdict)).toContain("nothing credited under these terms");
  });

  it("shows settled without a qualifier for late — a fact, not exact/over/short", async () => {
    const base = await verdictFor(5_000_000);
    const arrived = base.fulfilment as { status: string; received: bigint };
    const html = settlementReceiptHTML({
      ...base,
      fulfilment: { ...arrived, status: "novel" } as never,
    });
    expect(html).toContain("5000000 atomic units</code>");
  });

  it("renders no content panel unless the agent has content facts to show", async () => {
    const html = settlementReceiptHTML(await verdictFor(5_000_000));
    expect(html).not.toContain("Delivered content");
  });

  it("shows WHO approved THIS payment when a wallet signed the challenge — re-verifiable", async () => {
    const verdict = await verdictFor(5_000_000);
    // No consent → no panel: an autonomous run is the thesis, not a warning.
    expect(settlementReceiptHTML(verdict)).not.toContain("Human approval");
    const approved = settlementReceiptHTML(verdict, {
      consent: {
        approver: "0.0.4242",
        terms: "hiero-x402 approval · pay 0.05 ℏ · nonce abc123 · issued 2026-07-31T12:00:00Z",
        signatureB64: "c2ln",
        verified: true,
      },
    });
    expect(approved).toContain("Human approval");
    expect(approved).toContain("HUMAN APPROVED");
    expect(approved).toContain("0.0.4242");
    expect(approved).toContain("nonce abc123"); // the run-binding, visible
    expect(approved).toContain("does not move money"); // scope honesty
    // A claimed consent that does not verify is loud, never displayed as fact.
    const broken = settlementReceiptHTML(verdict, {
      consent: {
        approver: "0.0.4242",
        terms: "<script>alert(1)</script>",
        signatureB64: "c2ln",
        verified: false,
      },
    });
    expect(broken).toContain("CONSENT UNVERIFIED");
    expect(broken).toContain("unattested");
    expect(broken).not.toContain("<script>alert(1)</script>"); // escaped
  });

  it("shows the proof's working when the caller ran one — and nothing when it didn't", async () => {
    const verdict = await verdictFor(5_000_000);
    // The mirror path ran no block proof — claiming one would be the lie
    // this repo exists to end.
    expect(settlementReceiptHTML(verdict)).not.toContain("proof&#39;s working");
    const html = settlementReceiptHTML(verdict, {
      proof: {
        source: "block 467 · hedera:previewnet (committed fixture, real block)",
        anchor: "genesis block 0 — the chain of block hashes ends here",
        checks: ["the block's merkle root, recomputed <from> its own items"],
      },
    });
    expect(html).toContain("The proof&#39;s working");
    expect(html).toContain("block 467");
    expect(html).toContain("genesis block 0");
    expect(html).toContain("one flipped byte"); // falsifiability, stated
    expect(html).not.toContain("<from>"); // checks are escaped
    // Anchor is optional — a future source may anchor differently.
    const anchorless = settlementReceiptHTML(verdict, {
      proof: { source: "block 9", checks: ["a check"] },
    });
    expect(anchorless).toContain("The proof&#39;s working");
    expect(anchorless).not.toContain("Anchor");
  });

  it("renders a caveat only when the caller owns up to one, escaped", async () => {
    const verdict = await verdictFor(5_000_000);
    expect(settlementReceiptHTML(verdict)).not.toContain('<p class="x402-caveat">');
    const html = settlementReceiptHTML(verdict, { caveat: "Beta <fixture> demonstration" });
    expect(html).toContain('<p class="x402-caveat">');
    expect(html).toContain("Beta &#60;fixture&#62; demonstration");
    expect(html).not.toContain("Beta <fixture>");
  });

  it("keeps the content panel OUTSIDE the settlement seal's authority, in its own register", async () => {
    const verdict = await verdictFor(5_000_000);
    const sha = "a".repeat(64);
    // COMMITTED — the server signed the exact bytes; non-repudiation.
    const committed = settlementReceiptHTML(verdict, {
      content: {
        sha256: sha,
        commitment: { signer: "0.0.7000009", signatureB64: "c2ln", verified: true },
      },
    });
    expect(committed).toContain("Delivered content");
    expect(committed).toContain("SERVER COMMITTED");
    expect(committed).toContain("cannot later deny");
    expect(committed).toContain(sha);
    expect(committed).toContain("0.0.7000009");
    // The honesty line: bytes-to-payment binding is not data truth.
    expect(committed).toContain("does not make the data true");
    // BROKEN — a claimed commitment that does not verify is loud, not hidden.
    const broken = settlementReceiptHTML(verdict, {
      content: {
        sha256: sha,
        commitment: { signer: "0.0.7000009", signatureB64: "c2ln", verified: false },
      },
    });
    expect(broken).toContain("COMMITMENT BROKEN");
    expect(broken).toContain("does NOT verify");
    // AGENT RECORD — no commitment offered. Named for what it IS: the
    // agent's own note. Must never read as a failure — the payment is
    // proven either way.
    const record = settlementReceiptHTML(verdict, { content: { sha256: sha } });
    expect(record).toContain("AGENT RECORD");
    expect(record).toContain("does not offer content commitments");
    expect(record).toContain("proven either way");
    expect(record).not.toContain("Signer");
    expect(record).not.toContain("failed");
  });

  it("escapes attacker-controlled content facts before rendering them", async () => {
    const verdict = await verdictFor(5_000_000);
    const html = settlementReceiptHTML(verdict, {
      content: {
        sha256: `<img src=x onerror=alert(1)>`,
        commitment: {
          signer: `<script>alert(2)</script>`,
          signatureB64: `"><script>alert(3)</script>`,
          verified: true,
        },
      },
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).not.toContain("<script>alert(3)</script>");
  });

  it("omits the proof link when the mirror has no transaction, and escapes what it prints", async () => {
    const { fetchImpl } = fetchStub(undefined, 404);
    const verdict = await verifySettlement(
      REQUIREMENTS,
      SETTLEMENT_ID,
      `<script>alert(1)</script>`,
      { fetchImpl },
    );
    const html = settlementReceiptHTML(verdict);
    expect(html).not.toContain("View on HashScan");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
