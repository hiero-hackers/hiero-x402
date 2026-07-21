// SPDX-License-Identifier: Apache-2.0
/**
 * The keepsake: a settlement verdict as a self-contained HTML document the
 * agent (or its operator) files away. The receipt bodies are rendered by
 * hiero-receipts (`toHTML` — inline CSS, no external assets, printable); this
 * module only adds the verdict banner and the proof link on top, because
 * those are x402 facts, not receipt facts.
 */
import { toHTML } from "@hiero-hackers/hiero-receipts";
import type { SettlementVerdict } from "./verify.js";

const escapeHTML = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One line of plain language per verdict status. */
export function verdictLine(verdict: SettlementVerdict): string {
  const { fulfilment } = verdict;
  switch (fulfilment.status) {
    case "paid":
      return "Paid in full — the chain confirms the exact amount landed.";
    case "overpaid":
      return "Paid — more than asked arrived (overpayment is a fact, not a failure).";
    case "underpaid":
      return "Underpaid — less than the required amount landed.";
    case "unpaid":
      return "Not paid — the settlement transaction credits nothing that fulfils these terms.";
    case "wrong-asset":
      return "Something arrived, but not what these terms ask for — wrong asset or wrong destination.";
    case "expired":
      return "Expired — the request's deadline passed before payment landed.";
    default:
      return `Outcome: ${(fulfilment as { status: string }).status}.`;
  }
}

/**
 * The verdict + receipts as one printable HTML document. Everything shown is
 * derived from the *verified* verdict — never echoed from a facilitator's
 * response — so what the reader sees is what the chain said.
 */
export function settlementReceiptHTML(verdict: SettlementVerdict): string {
  // Say HOW it was verified — the receipts carry their provenance, and the
  // banner must not claim the mirror for a block-proof verdict (or vice versa).
  const proven = verdict.receipts.some((receipt) => receipt.provenance.kind === "verified");
  const method = proven
    ? "Verified against the ledger&#39;s own block proof — cryptography, not the facilitator&#39;s word."
    : "Verified against the public mirror node, not the facilitator&#39;s word.";
  const banner = `<header style="padding:1rem;border:1px solid #ccc;border-radius:8px;background:#fff">
  <h1 style="font-size:1.1rem;margin:0 0 .5rem">x402 settlement — independently verified</h1>
  <p style="margin:0 0 .5rem"><span style="display:inline-block;padding:.1rem .5rem;border-radius:999px;background:#eef;border:1px solid #99f;font-size:.75rem;letter-spacing:.03em">AGENT RAIL · x402</span>
  <span style="color:#555;font-size:.8rem">machine-payable: fee-payer sponsored, no wallet memo — the rail, not the species, is what the chain can prove</span></p>
  <p style="margin:.25rem 0">${escapeHTML(verdictLine(verdict))}</p>
  <p style="margin:.25rem 0">Reference: <code>${escapeHTML(verdict.request.reference)}</code></p>
  <p style="margin:.25rem 0">Transaction: <code>${escapeHTML(verdict.transactionId)}</code></p>
  ${
    verdict.hashscanUrl !== undefined
      ? `<p style="margin:.25rem 0"><a href="${escapeHTML(verdict.hashscanUrl)}">View on HashScan</a> — anyone can re-check this.</p>`
      : ""
  }
  <p style="margin:.25rem 0;color:#555">${method}</p>
</header>`;
  const bodies = verdict.receipts.map((receipt) => toHTML(receipt)).join("\n");
  // ONE column for everything — the banner and the receipt bodies share the
  // same width and left edge, instead of two containers eyeballing centers.
  // hiero-receipts caps its card at 420px; stretch it to the shared column
  // (the override <style> must come after the bodies' own <style> blocks).
  return `<div style="font-family:system-ui,sans-serif;max-width:36rem;margin:1.5rem auto;padding:0 1rem;display:flex;flex-direction:column;gap:1rem">
${banner}
<div style="display:flex;flex-direction:column;gap:1rem">${bodies}</div>
<style>.rcpt{max-width:none;width:100%;box-sizing:border-box}</style>
</div>`;
}
