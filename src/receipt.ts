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
  // Status word drives the accent — a fact from the verified verdict, never
  // an assumption ("paid"/"overpaid" read as good; anything else is flagged).
  const status = verdict.fulfilment.status;
  const good = status === "paid" || status === "overpaid";
  // The seal is the document's signature device: a stamped mark whose word
  // states HOW the chain was consulted. Gold rim = block proof (cryptography);
  // emerald = mirror-confirmed; amber = a verdict that needs a human's eye.
  const sealWord = good ? (proven ? "BLOCK PROOF" : "VERIFIED") : "REVIEW";
  const sealClass = good ? (proven ? "seal-proof" : "seal-ok") : "seal-warn";
  const banner = `<header class="x402-card">
  <div class="x402-seal ${sealClass}" aria-hidden="true">
    <span class="x402-seal-glyph">${good ? "&check;" : "!"}</span>
    <span class="x402-seal-word">${sealWord}</span>
  </div>
  <div class="x402-top">
    <span class="x402-badge ${good ? "ok" : "warn"}">${escapeHTML(status.toUpperCase())}</span>
    <span class="x402-chip">AGENT RAIL · x402</span>
  </div>
  <p class="x402-eyebrow">Certificate of settlement</p>
  <h1 class="x402-title">x402 settlement — independently verified</h1>
  <p class="x402-verdict">${escapeHTML(verdictLine(verdict))}</p>
  <p class="x402-note">machine-payable: fee-payer sponsored, no wallet memo — the rail, not the species, is what the chain can prove</p>
  <dl class="x402-meta">
    <div><dt>Reference</dt><dd><code>${escapeHTML(verdict.request.reference)}</code></dd></div>
    <div><dt>Transaction</dt><dd><code>${escapeHTML(verdict.transactionId)}</code></dd></div>
  </dl>
  ${
    verdict.hashscanUrl !== undefined
      ? `<p class="x402-proof"><a href="${escapeHTML(verdict.hashscanUrl)}">View on HashScan <span aria-hidden="true">↗</span></a> — anyone can re-check this.</p>`
      : ""
  }
  <p class="x402-method">${method}</p>
</header>`;
  const bodies = verdict.receipts.map((receipt) => toHTML(receipt)).join("\n");
  // ONE column for everything — the banner and the receipt bodies share the
  // same width and left edge, instead of two containers eyeballing centers.
  // hiero-receipts caps its card at 420px and ships a LIGHT card; the trailing
  // override <style> (source-order wins) both stretches it to the shared column
  // AND re-themes .rcpt to this document's dark instrument palette, so the
  // embedded ledger and the certificate above it read as one artifact.
  const theme = `<style>
  :root{
    --ink:#0b0a10;--panel:#151220;--panel-2:#100e19;--line:#272235;--line-2:#332c46;
    --text:#eceaf4;--muted:#9d97ae;--faint:#6c657d;
    --brand:#8071ff;--brand-soft:#b7adff;--proof:#3dd4a0;--gold:#e6b968;
    --warn:#f3b64d;--danger:#f4746b;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  html{color-scheme:dark}
  body{margin:0;-webkit-font-smoothing:antialiased;color:var(--text);background:
    radial-gradient(1100px 560px at 82% -14%,rgba(128,113,255,.15),transparent 58%),
    radial-gradient(820px 480px at -6% 4%,rgba(61,212,160,.07),transparent 55%),
    repeating-linear-gradient(115deg,rgba(255,255,255,.014) 0 1px,transparent 1px 8px),
    var(--ink)}
  .x402-wrap{font-family:var(--sans);line-height:1.55;max-width:41rem;margin:0 auto;
    padding:2.25rem 1.25rem 3rem;display:flex;flex-direction:column;gap:1.15rem}
  .x402-card{position:relative;overflow:hidden;background:
    linear-gradient(180deg,var(--panel),var(--panel-2));border:1px solid var(--line);border-radius:18px;
    padding:1.5rem 1.6rem;box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 28px 56px -34px rgba(0,0,0,.9)}
  .x402-card::before{content:"402";position:absolute;top:-1.6rem;right:6.2rem;font:800 6rem/1 var(--mono);
    color:rgba(255,255,255,.028);letter-spacing:-.04em;pointer-events:none}
  .x402-seal{position:absolute;top:1.25rem;right:1.4rem;width:76px;height:76px;border-radius:50%;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.14rem;text-align:center;
    transform:rotate(-9deg);border:2px solid var(--proof);
    box-shadow:0 0 0 3px rgba(11,10,16,.9),0 0 0 4px rgba(61,212,160,.25);
    background:radial-gradient(circle at 50% 38%,rgba(61,212,160,.16),rgba(61,212,160,.04))}
  .x402-seal-glyph{font-size:1.4rem;line-height:1;color:var(--proof);font-weight:700}
  .x402-seal-word{font:700 .46rem/1.12 var(--sans);letter-spacing:.1em;color:var(--proof);
    text-transform:uppercase;max-width:54px}
  .x402-seal.seal-proof{border-color:var(--gold);box-shadow:0 0 0 3px rgba(11,10,16,.9),0 0 0 4px rgba(230,185,104,.28);
    background:radial-gradient(circle at 50% 38%,rgba(230,185,104,.16),rgba(230,185,104,.04))}
  .x402-seal.seal-proof .x402-seal-glyph,.x402-seal.seal-proof .x402-seal-word{color:var(--gold)}
  .x402-seal.seal-warn{border-color:var(--warn);box-shadow:0 0 0 3px rgba(11,10,16,.9),0 0 0 4px rgba(243,182,77,.28);
    background:radial-gradient(circle at 50% 38%,rgba(243,182,77,.16),rgba(243,182,77,.04))}
  .x402-seal.seal-warn .x402-seal-glyph,.x402-seal.seal-warn .x402-seal-word{color:var(--warn)}
  .x402-top{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:1.1rem}
  .x402-badge{font-size:.68rem;font-weight:700;letter-spacing:.08em;padding:.24rem .62rem;border-radius:6px;
    border:1px solid;text-transform:uppercase;font-family:var(--mono)}
  .x402-badge.ok{color:var(--proof);border-color:rgba(61,212,160,.42);background:rgba(61,212,160,.1)}
  .x402-badge.warn{color:var(--warn);border-color:rgba(243,182,77,.42);background:rgba(243,182,77,.1)}
  .x402-chip{font-size:.68rem;letter-spacing:.08em;padding:.24rem .62rem;border-radius:6px;color:var(--brand-soft);
    border:1px solid rgba(128,113,255,.42);background:rgba(128,113,255,.12);font-family:var(--mono)}
  .x402-eyebrow{margin:0 0 .3rem;font-size:.68rem;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--faint)}
  .x402-title{font-family:var(--serif);font-weight:600;font-size:1.7rem;line-height:1.15;letter-spacing:-.01em;
    margin:0 0 .7rem;max-width:26rem;color:#fbfbfe}
  .x402-verdict{margin:0 0 .8rem;font-size:1.05rem;color:var(--text);font-weight:500}
  .x402-note{margin:0 0 1.15rem;color:var(--muted);font-size:.82rem;max-width:34rem}
  .x402-meta{margin:0 0 1.1rem;display:flex;flex-direction:column;gap:0}
  .x402-meta>div{display:flex;justify-content:space-between;gap:1rem;align-items:baseline;
    border-top:1px solid var(--line);padding:.6rem 0}
  .x402-meta>div:last-child{border-bottom:1px solid var(--line)}
  .x402-meta dt{color:var(--faint);font-size:.7rem;text-transform:uppercase;letter-spacing:.1em}
  .x402-meta dd{margin:0;font-family:var(--mono);font-size:.82rem;color:var(--brand-soft);
    word-break:break-all;text-align:right}
  .x402-proof{margin:0 0 .65rem;font-size:.88rem;color:var(--muted)}
  .x402-proof a{color:var(--proof);text-decoration:none;font-weight:600}
  .x402-proof a:hover{text-decoration:underline}
  .x402-method{margin:0;color:var(--faint);font-size:.8rem}
  .x402-bodies{display:flex;flex-direction:column;gap:1rem}
  .x402-brand{display:flex;align-items:center;gap:.65rem;font-weight:650;letter-spacing:-.01em;color:var(--text)}
  .x402-brand .mark{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;font-family:var(--mono);
    background:linear-gradient(135deg,var(--brand),#5b8bff);color:#0a0c11;font-weight:800;font-size:.86rem;
    box-shadow:0 0 0 1px rgba(230,185,104,.35),0 6px 18px -6px rgba(128,113,255,.7)}
  .x402-brand small{color:var(--faint);font-weight:400;font-size:.8rem;margin-left:.15rem}
  .x402-foot{margin-top:.5rem;padding-top:1.1rem;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;
    gap:.4rem 1rem;justify-content:space-between;color:var(--faint);font-size:.78rem}
  @media(max-width:430px){.x402-card::before{display:none}.x402-seal{position:static;transform:none;margin:0 0 .9rem}}
  @media print{
    body{background:#fff;color:#111}
    .x402-card{background:#fff;border-color:#d8dce2;box-shadow:none}
    .x402-card::before{color:rgba(0,0,0,.05)}
    .x402-title{color:#111}.x402-verdict{color:#111}.x402-brand,.x402-brand small{color:#333}
  }
</style>`;
  // The dark re-theme of the embedded hiero-receipts card — MUST come last so
  // it overrides the library's own light <style> by source order.
  const rcptOverride = `<style>
  .rcpt{max-width:none;width:100%;box-sizing:border-box;background:linear-gradient(180deg,var(--panel),var(--panel-2));
    border:1px solid var(--line);border-radius:18px;color:var(--text);padding:1.4rem 1.6rem;font-family:var(--sans)}
  .rcpt .who{color:var(--faint);font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;margin:0 0 .5rem}
  .rcpt h3{font-family:var(--serif);font-weight:600;font-size:1.3rem;line-height:1.25;color:#fbfbfe;margin:0 0 .2rem}
  .rcpt ul{color:var(--muted)}
  .rcpt .status{color:var(--danger)}
  .rcpt .caution{color:var(--warn);background:rgba(243,182,77,.1);border:1px solid rgba(243,182,77,.28);border-radius:10px}
  .rcpt table{margin-top:1.1rem;border-collapse:collapse;width:100%}
  .rcpt td{padding:.6rem 0;border-bottom:1px solid var(--line);vertical-align:baseline}
  .rcpt td.k{color:var(--faint);font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;width:40%}
  .rcpt td.v{text-align:right;font-family:var(--mono);color:var(--brand-soft);font-size:.86rem}
  .rcpt .prov{color:var(--faint);font-size:.78rem;margin-top:1rem}
  .rcpt .badge{border:1px solid var(--line-2);background:rgba(255,255,255,.04);color:var(--muted)}
  .rcpt .badge.ok{background:rgba(61,212,160,.12);color:var(--proof);border-color:rgba(61,212,160,.4)}
  @media print{.rcpt{background:#fff;color:#1a1d24;border-color:#d8dce2}.rcpt h3{color:#111}
    .rcpt td.v{color:#1a1d24}.rcpt .who,.rcpt td.k,.rcpt .prov{color:#5b6472}}
</style>`;
  return `<div class="x402-wrap">
${theme}
<div class="x402-brand"><span class="mark">x4</span>hiero-x402 <small>settlement, independently verified</small></div>
${banner}
<div class="x402-bodies">${bodies}</div>
<footer class="x402-foot"><span>hiero-x402 · x402 on Hiero with verifiable settlement</span><span>independent · facilitator-free verification</span></footer>
${rcptOverride}
</div>`;
}
