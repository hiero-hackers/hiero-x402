// SPDX-License-Identifier: Apache-2.0
/**
 * The demo HUB page — the one screen a human (or a video) needs — as a
 * PURE template: scalars in, HTML out. Extracted from app.ts so the
 * server file stays server logic; everything this page knows arrives via
 * `HubView`, resolved by the caller (createApp), never read from env here.
 */
import { escapeHTML as esc } from "../src/index.js";

export interface HubView {
  readonly network: string;
  /** Is a runAgent attached — does the Run button exist at all? */
  readonly liveRuns: boolean;
  /** Wallet-signed approval mode, when both are configured. */
  readonly approverId?: string;
  readonly walletProjectId?: string;
  /** The attestation topic id ("" or "create" = attestations off). */
  readonly topic: string;
  /** Is this artifact from THIS session? (see createApp's freshReceipt) */
  readonly receiptFresh: (file: string) => boolean;
}

export function hubHTML(view: HubView): string {
  const topic = view.topic;
  // Receipts are the project's USP, so each is a card, not a list item — a
  // clear split between the two rungs of the trust ladder (block-proof =
  // "verified"; mirror = an independent "mirror receipt", never "verified").
  const receiptCard = (
    file: string,
    kind: "verified" | "mirror",
    tag: string,
    title: string,
    desc: string,
  ): string => {
    const inner = `<span class="tag">${tag}</span><h3>${title}</h3><p>${desc}</p>`;
    return view.receiptFresh(file)
      ? `<a class="rcard ${kind}" href="/receipts/${file.replace(".html", "")}">${inner}<span class="open">Open receipt ↓</span></a>`
      : `<div class="rcard ${kind} empty">${inner}<span class="open">none from this session yet — run the demo</span></div>`;
  };
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>hiero-x402 — settlement, independently verified</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --ink:#0b0a10;--panel:#151220;--panel-2:#100e19;--line:#272235;--line-2:#332c46;
    --text:#eceaf4;--muted:#9d97ae;--faint:#6c657d;
    --brand:#8071ff;--brand-soft:#b7adff;--proof:#3dd4a0;--gold:#e6b968;--steel:#9aa3b7;
    --warn:#f3b64d;--danger:#f4746b;
    --radius:18px;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  html{color-scheme:dark}
  body{margin:0;font-family:var(--sans);line-height:1.55;color:var(--text);
    background:
      radial-gradient(1100px 560px at 80% -14%,rgba(128,113,255,.15),transparent 58%),
      radial-gradient(820px 480px at -6% 2%,rgba(61,212,160,.07),transparent 55%),
      repeating-linear-gradient(115deg,rgba(255,255,255,.014) 0 1px,transparent 1px 8px),
      var(--ink);
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  a{color:var(--proof);text-decoration:none}
  a:hover{text-decoration:underline}
  code{font-family:var(--mono);font-size:.86em}
  .wrap{max-width:60rem;margin:0 auto;padding:1.75rem 1.25rem 4rem}
  .topbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:2.5rem}
  .brand{display:flex;align-items:center;gap:.65rem;font-weight:650;letter-spacing:-.01em}
  .brand .mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-family:var(--mono);
    background:linear-gradient(135deg,var(--brand),#5b8bff);color:#0a0c11;font-weight:800;font-size:.9rem;
    box-shadow:0 0 0 1px rgba(230,185,104,.35),0 6px 18px -6px rgba(128,113,255,.7)}
  .brand small{color:var(--faint);font-weight:400;font-size:.8rem;margin-left:.1rem}
  .pill{display:inline-flex;align-items:center;gap:.45rem;padding:.34rem .72rem;border:1px solid var(--line-2);
    border-radius:999px;font-size:.72rem;color:var(--muted);background:rgba(255,255,255,.02);font-family:var(--mono)}
  .pill .dot{width:7px;height:7px;border-radius:50%;background:var(--proof);box-shadow:0 0 0 3px rgba(61,212,160,.18)}
  .hero{margin:0 0 2.5rem;position:relative}
  .hero .eyebrow{margin:0 0 .55rem;font-size:.7rem;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--faint)}
  .hero h1{font-family:var(--serif);font-weight:600;margin:0 0 .7rem;font-size:clamp(2rem,5vw,3rem);
    line-height:1.08;letter-spacing:-.01em;color:#fbfbfe;max-width:20ch}
  .hero p{margin:0;max-width:44rem;color:var(--muted);font-size:1.04rem}
  .grid{display:flex;flex-direction:column;gap:1.15rem}
  .card{position:relative;overflow:hidden;background:linear-gradient(180deg,var(--panel),var(--panel-2));
    border:1px solid var(--line);border-radius:var(--radius);padding:1.4rem 1.5rem;
    box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 24px 48px -34px rgba(0,0,0,.9)}
  .card h2{margin:0 0 .2rem;font-size:.7rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
  .card .sub{margin:.15rem 0 1.2rem;color:var(--muted);font-size:.92rem}
  /* live-run stepper — pills the run lights cumulatively via .lit */
  .rails{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center}
  .rail{position:relative;padding:.36rem .72rem;border:1px solid var(--line-2);border-radius:8px;
    background:rgba(255,255,255,.02);font-size:.74rem;color:var(--muted);font-family:var(--mono);transition:.3s}
  .rail.lit{border-color:rgba(61,212,160,.55);color:#eafff6;
    background:linear-gradient(180deg,rgba(61,212,160,.2),rgba(61,212,160,.07));
    box-shadow:0 0 0 1px rgba(61,212,160,.3),0 8px 20px -10px rgba(61,212,160,.55)}
  .arrow{color:var(--faint);font-size:.8rem}
  .human-stage{display:none}
  .rails.with-human .human-stage{display:inline-block}
  .rail.wait{border-color:rgba(243,182,77,.55);color:#fff7e8;
    background:linear-gradient(180deg,rgba(243,182,77,.22),rgba(243,182,77,.06));
    box-shadow:0 0 0 1px rgba(243,182,77,.32),0 8px 20px -10px rgba(243,182,77,.5);animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{50%{filter:brightness(1.25)}}
  .toggle-group{display:flex;flex-direction:column;gap:.35rem;margin-top:1.05rem}
  .toggle{display:flex;align-items:center;gap:.5rem;font-size:.82rem;color:var(--muted);
    cursor:pointer;user-select:none;font-family:var(--mono)}
  .toggle input{accent-color:var(--warn);width:15px;height:15px;margin:0;cursor:pointer}
  .toggle b{color:var(--warn);font-weight:600}
  .approve{display:none;margin-top:1.05rem;padding:.95rem 1.1rem;border:1px solid rgba(243,182,77,.45);
    border-radius:12px;background:rgba(243,182,77,.07);gap:.6rem;align-items:center;flex-wrap:wrap;font-size:.86rem}
  .approve.on{display:flex}
  .approve .terms{flex:1 1 100%;color:#fff7e8;font-family:var(--mono);font-size:.8rem}
  .approve .btn{margin-top:0;padding:.5rem .95rem;font-size:.84rem}
  .btn.ghost{background:transparent;border:1px solid var(--line-2);color:var(--muted);box-shadow:none}
  .btn.ghost:hover{color:var(--text);border-color:var(--line-2)}
  .btn{margin-top:1.15rem;display:inline-flex;align-items:center;gap:.5rem;padding:.66rem 1.15rem;border:none;cursor:pointer;
    border-radius:10px;font-size:.9rem;font-weight:600;font-family:inherit;color:#0a0c11;
    background:linear-gradient(135deg,var(--brand),#5b8bff);box-shadow:0 10px 24px -10px rgba(128,113,255,.8);transition:.2s}
  .btn:hover{transform:translateY(-1px);filter:brightness(1.07)}
  .btn:disabled{opacity:.55;cursor:progress;transform:none;filter:none}
  .note{color:var(--faint);font-size:.82rem;margin-top:1rem}
  .status{display:none;align-items:center;gap:.55rem;margin-top:1.1rem;font-size:.82rem;color:var(--muted)}
  .status.on{display:inline-flex}
  .status .spin{width:13px;height:13px;border:2px solid rgba(128,113,255,.25);border-top-color:var(--brand);border-radius:50%;animation:spin .7s linear infinite}
  .status.done{color:var(--proof)}
  .status.err{color:var(--danger)}
  .status.done .spin,.status.err .spin{display:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  #run-log{margin:1rem 0 0;background:var(--panel-2);border:1px solid var(--line);color:var(--muted);
    padding:.9rem 1rem;border-radius:12px;font-family:var(--mono);font-size:.74rem;line-height:1.6;
    max-height:19rem;overflow:auto;white-space:pre-wrap;word-break:break-word}
  #run-log a{color:var(--brand-soft)}
  /* the audit view — the topic's rows, each with the auditor's own verdict */
  .audit-row{display:flex;flex-wrap:wrap;gap:.35rem .85rem;align-items:baseline;padding:.55rem 0;
    border-top:1px solid var(--line);font-size:.78rem;color:var(--muted);font-family:var(--mono)}
  .audit-row:first-child{border-top:none}
  .audit-row code{color:var(--brand-soft);word-break:break-all}
  .audit-row.current{border-left:3px solid var(--proof);padding-left:.7rem;background:rgba(61,212,160,.05)}
  .audit-chip{font-size:.64rem;font-weight:700;letter-spacing:.08em;padding:.14rem .5rem;border-radius:6px;
    color:var(--proof);border:1px solid rgba(61,212,160,.42);background:rgba(61,212,160,.1);text-transform:uppercase}
  .a-ok{color:var(--proof);font-weight:600}
  .a-bad{color:var(--danger);font-weight:700}
  .a-none{color:var(--faint)}
  #run-hint{font-size:.88rem;margin:.9rem 0 0;color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:.9rem}
  thead th{text-align:left;font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);
    font-weight:600;padding:0 .65rem .65rem;border-bottom:1px solid var(--line)}
  tbody td{padding:.75rem .65rem;border-bottom:1px solid var(--line);vertical-align:middle}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover td{background:rgba(255,255,255,.02)}
  td code{color:var(--brand-soft)}
  td .price{font-family:var(--mono);color:var(--proof);font-size:.84rem}
  .pay{display:inline-flex;align-items:center;gap:.35rem;padding:.28rem .62rem;border:1px solid var(--line-2);
    border-radius:7px;font-size:.78rem;font-weight:600;color:var(--brand-soft);background:rgba(128,113,255,.08);transition:.2s}
  .pay:hover{border-color:rgba(128,113,255,.5);text-decoration:none;color:#fff}
  /* receipts — the USP, given the most prominent treatment on the page */
  .receipts{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
  .rcard{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:14px;
    padding:1.15rem 1.25rem;background:var(--panel-2);transition:.2s}
  a.rcard:hover{border-color:var(--line-2);text-decoration:none;transform:translateY(-2px);
    box-shadow:0 16px 34px -24px rgba(0,0,0,.9)}
  .rcard .tag{align-self:flex-start;font-family:var(--mono);font-size:.64rem;font-weight:700;
    letter-spacing:.1em;text-transform:uppercase;padding:.24rem .55rem;border-radius:6px;border:1px solid}
  .rcard.verified .tag{color:var(--gold);border-color:rgba(230,185,104,.42);background:rgba(230,185,104,.1)}
  .rcard.mirror .tag{color:var(--steel);border-color:rgba(154,163,183,.42);background:rgba(154,163,183,.1)}
  .rcard h3{margin:.8rem 0 .3rem;font-family:var(--serif);font-weight:600;font-size:1.12rem;color:#fbfbfe}
  .rcard p{margin:0;color:var(--muted);font-size:.86rem;flex:1}
  .rcard .open{margin-top:.85rem;font-weight:600;font-size:.85rem;color:var(--brand-soft)}
  .rcard.empty{opacity:.55}
  .viewer{display:none;margin-top:1rem;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--panel-2)}
  .viewer.on{display:block}
  .viewer-bar{display:flex;align-items:center;gap:.75rem;padding:.6rem .95rem;border-bottom:1px solid var(--line);font-size:.82rem;color:var(--muted)}
  .viewer-bar .vtitle{flex:1;font-weight:600;color:var(--text)}
  .viewer-bar a{color:var(--brand-soft)}
  .viewer-bar button{background:none;border:none;color:var(--muted);font-size:1rem;cursor:pointer;padding:.1rem .4rem;line-height:1}
  .viewer-bar button:hover{color:var(--text)}
  /* The frame grows to the receipt's full height (script below measures the
     same-origin document) — the page scrolls, the receipt never does. */
  .viewer iframe{display:block;width:100%;height:34rem;border:0;background:#fff}
  .rcard.empty .open{color:var(--faint)}
  @media(max-width:600px){.receipts{grid-template-columns:1fr}}
  footer{margin-top:2.75rem;padding-top:1.35rem;border-top:1px solid var(--line);
    display:flex;flex-wrap:wrap;gap:.5rem 1rem;justify-content:space-between;color:var(--faint);font-size:.8rem}
  @media(max-width:560px){.arrow{display:none}}
</style>
<div class="wrap">
  <div class="topbar">
    <div class="brand"><span class="mark"></span>hiero-x402 <small>settlement, verified and optionally human gated</small></div>
    <span class="pill"><span class="dot"></span>network&nbsp;<code>${esc(view.network)}</code></span>
  </div>

  <header class="hero">
    <p class="eyebrow">HTTP 402 · verifiable and trustworthy settlement on Hedera</p>
    <h1>Trusted Layer of AI settlement.</h1>
    <p>An agent discovers a x402 price on Hedera, pays it, and the settlement arrives as a mirror receipt or block proof (beta) - all independently verifiable including an HCS audit trail.
    The transaction can be fully autonomous or with a human in the loop (hub button or wallet-signed consent).</p>
  </header>

  <div class="grid">
    <section class="card">
      <h2>Live end-to-end — the agent rails</h2>
      <div class="rails">
        <span class="rail" data-rail="agent">agent · client key</span><span class="arrow">→</span>
        <span class="rail" data-rail="server">server · no keys</span><span class="arrow">→</span>
        <span class="rail human-stage" data-rail="human">human · approves the spend</span><span class="arrow human-stage">→</span>
        <span class="rail" data-rail="facilitator">facilitator · fee-payer key</span><span class="arrow">→</span>
        <span class="rail" data-rail="chain">Hedera testnet</span><span class="arrow">→</span>
        <span class="rail" data-rail="mirror">mirror verify</span><span class="arrow">→</span>
        <span class="rail" data-rail="content">content commit</span><span class="arrow">→</span>
        <span class="rail" data-rail="hcs">HCS attest</span>
      </div>
      ${
        view.liveRuns
          ? `<div class="toggle-group" id="mode-group">
               <label class="toggle"><input type="radio" name="run-mode" value="auto" checked><span>autonomous — no human in the loop</span></label>
               <label class="toggle"><input type="radio" name="run-mode" value="button"><span>require human approval — <b>hub button</b></span></label>
               ${
                 view.approverId !== undefined && view.walletProjectId !== undefined
                   ? `<label class="toggle"><input type="radio" name="run-mode" value="wallet"><span>require human approval — <b>wallet-signed</b> </span></label>`
                   : `<span class="note">wallet-signed approval is off — set APPROVER_ACCOUNT_ID and WALLETCONNECT_PROJECT_ID in .env</span>`
               }
             </div>
             <button id="run-agent" class="btn">▶ Run the agent — testnet</button>
             <div id="approve-panel" class="approve">
               <span class="terms" id="approve-terms"></span>
               <button id="approve-wallet" class="btn" style="display:none">🔏 Sign approval in wallet</button>
               <button id="approve-yes" class="btn">✓ Approve payment</button>
               <button id="approve-no" class="btn ghost">✗ Decline</button>
             </div>`
          : `<p class="note">Live runs are off here — start via <code>npm run demo</code> and use the hub it prints.</p>`
      }
      <div id="run-status" class="status"><span class="spin"></span><span id="run-status-text">Running in the background…</span></div>
      <pre id="run-log" style="display:none"></pre>
      <p id="run-hint" style="display:none">Done — <a href="/receipts/receipt">open the fresh receipt</a>.</p>
    </section>

    <section class="card">
      <h2>Receipts — the proof you keep</h2>
      <p class="sub">View the mirror receipt or block proof for each AI agent settlement.</p>
      <div class="receipts">
        ${receiptCard(
          "receipt.html",
          "mirror",
          "Mirror receipt",
          "Mirror receipt",
          "The public mirror node's attested record of the settlement — independent of the facilitator, and re-checkable by anyone. Includes the delivered-content panel: what the server committed to serving for this payment.",
        )}
        ${receiptCard(
          "verified-receipt.html",
          "verified",
          "Block proof",
          "Verified settlement",
          "The ledger's own (beta) block proof — recomputed and checked independently. Cryptography, not attestation: the only receipt we call verified.",
        )}
      </div>
      <div id="receipt-viewer" class="viewer">
        <div class="viewer-bar">
          <span class="vtitle" id="viewer-title"></span>
          <a id="viewer-pop" href="#" target="_blank">open full ↗</a>
          <button id="viewer-close" title="close">✕</button>
        </div>
        <iframe id="receipt-frame" title="receipt"></iframe>
      </div>
    </section>

    <section class="card">
      <h2>Audit trail</h2>
      <p style="margin:0;font-size:.92rem;color:var(--muted)">${
        topic !== "" && topic !== "create"
          ? `Verdicts attested to HCS topic <a href="https://hashscan.io/testnet/topic/${esc(topic)}"><code>${esc(topic)}</code></a> — an append-only public log. Each attestation carries the content hash and the server&#39;s commitment signature, so every payment&#39;s delivered bytes re-verify straight from the mirror — no cooperation needed from agent, server, or facilitator. Same check from a terminal: <code>npm run audit</code>.`
          : `Set <code>ATTEST_TOPIC_ID</code> to attest verdicts — settlement, content hash, and the server&#39;s commitment signature — to a public HCS topic anyone can re-verify with <code>npm run audit</code>.`
      }</p>${
        topic !== "" && topic !== "create"
          ? `
      <button id="audit-load" class="btn ghost" style="margin-top:1rem">↻ Read the topic — re-verify every commitment</button>
      <div id="audit-view" style="display:none;margin-top:.9rem"></div>`
          : ""
      }
    </section>
  </div>

  <footer>
    <span>hiero-x402 · x402 on Hiero with verifiable settlement and human approval</span>
    <span>independent · facilitator-free verification</span>
  </footer>
</div>
<script>
(function () {
  // Inline receipt viewer — the demo stays on this screen.
  var viewer = document.getElementById("receipt-viewer");
  var frame = document.getElementById("receipt-frame");
  // Size the frame to the WHOLE receipt: same-origin, so its height is
  // measurable. Re-measure a few times while fonts/styles settle.
  function fitFrame() {
    try {
      var doc = frame.contentDocument;
      if (!doc || !doc.documentElement) return;
      var height = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);
      if (height > 0) frame.style.height = height + "px";
    } catch (e) { /* cross-origin or not ready — keep the fallback height */ }
  }
  frame.addEventListener("load", function () {
    fitFrame();
    setTimeout(fitFrame, 150);
    setTimeout(fitFrame, 600);
  });
  window.addEventListener("resize", fitFrame);
  document.querySelectorAll("a.rcard").forEach(function (card) {
    card.addEventListener("click", function (e) {
      e.preventDefault();
      var href = card.getAttribute("href");
      if (viewer.classList.contains("on") && frame.getAttribute("src") === href) {
        viewer.classList.remove("on");
        return;
      }
      frame.setAttribute("src", href);
      document.getElementById("viewer-pop").setAttribute("href", href);
      document.getElementById("viewer-title").textContent = card.querySelector("h3").textContent;
      viewer.classList.add("on");
      viewer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
  document.getElementById("viewer-close").addEventListener("click", function () {
    viewer.classList.remove("on");
  });

  // The audit view: /demo/audit runs the SAME re-verification as the CLI —
  // the "holds" flag below is the server-side auditor's own signature
  // check against the on-chain key, never the agent's recorded word.
  var auditBtn = document.getElementById("audit-load");
  var auditView = document.getElementById("audit-view");
  function loadAudit() {
    if (!auditBtn) return;
    auditBtn.disabled = true;
    fetch("/demo/audit")
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        auditBtn.disabled = false;
        auditView.style.display = "block";
        if (!res.ok) {
          auditView.innerHTML = '<div class="audit-row">' + esc(String(res.body.error || "audit failed")) + "</div>";
          return;
        }
        var committed = 0;
        function row(e, isCurrent) {
          var sig = '<span class="a-none">no commitment — agent record only</span>';
          if (e.content && e.content.commitment) {
            sig = e.content.commitment.holds
              ? '<span class="a-ok">✓ signature holds — re-verified against ' + esc(e.content.commitment.signer) + "'s on-chain key</span>"
              : '<span class="a-bad">✗ DOES NOT HOLD — keep the evidence</span>';
          }
          var sha = e.content ? "<span>sha-256 " + esc(e.content.sha256.slice(0, 16)) + "…</span>" : "";
          return '<div class="audit-row' + (isCurrent ? " current" : "") + '">' +
            (isCurrent ? '<span class="audit-chip">this run</span>' : "") +
            '<code>#' + e.sequence + "</code><span>" + esc(e.status.toUpperCase()) +
            "</span><code>" + esc(e.transactionId) + "</code>" + sha + sig + "</div>";
        }
        // Newest first, THIS run's entry pinned on top. Broken HISTORICAL
        // entries are the terminal auditor's business (npm run audit keeps
        // the complete record) — the hub shows this session's story, so a
        // past failure only surfaces here if it IS this run's.
        var entries = res.body.entries.slice().reverse().filter(function (e) {
          var brokenEntry = e.content && e.content.commitment && !e.content.commitment.holds;
          return !brokenEntry || e.transactionId === currentTx;
        });
        if (!entries.length) {
          auditView.innerHTML = '<div class="audit-row"><span>no attestations from this session yet — run the agent and the log fills in here</span></div>';
          return;
        }
        entries.forEach(function (e) { if (e.content && e.content.commitment) committed++; });
        var shownBroken = entries.filter(function (e) {
          return e.content && e.content.commitment && !e.content.commitment.holds;
        }).length;
        var pinned = currentTx ? entries.filter(function (e) { return e.transactionId === currentTx; }) : [];
        var others = entries.filter(function (e) { return !currentTx || e.transactionId !== currentTx; });
        var RECENT = 3;
        var shown = pinned.map(function (e) { return row(e, true); }).join("") +
          others.slice(0, RECENT).map(function (e) { return row(e, false); }).join("");
        var hidden = others.slice(RECENT);
        var summary = '<div class="audit-row"><span>' + entries.length + " attestation(s) · " + committed +
          " committed" + (shownBroken ? " · " + shownBroken + " broken" : "") +
          " · read from the public mirror</span></div>";
        if (hidden.length) {
          shown += '<div class="audit-row"><a href="#" id="audit-more">show ' + hidden.length +
            " older attestation(s) — the append-only history</a></div>";
        }
        auditView.innerHTML = shown + summary;
        var more = document.getElementById("audit-more");
        if (more) {
          more.addEventListener("click", function (ev) {
            ev.preventDefault();
            auditView.innerHTML =
              pinned.map(function (e) { return row(e, true); }).join("") +
              others.map(function (e) { return row(e, false); }).join("") + summary;
          });
        }
      })
      .catch(function () { auditBtn.disabled = false; });
  }
  if (auditBtn) auditBtn.addEventListener("click", loadAudit);

  var button = document.getElementById("run-agent");
  if (!button) return;
  var log = document.getElementById("run-log");
  var hint = document.getElementById("run-hint");
  var status = document.getElementById("run-status");
  var statusText = document.getElementById("run-status-text");
  var label = button.textContent;
  // Agent step number → which rail lights up (demo/agent.ts numbers them).
  var STAGE = { 1: "server", 2: "server", 3: "agent", 4: "facilitator", 5: "chain", 6: "mirror", 7: "agent", 8: "hcs" };
  function esc(text) { return text.replace(/[&<>"']/g, function (ch) { return "&#" + ch.charCodeAt(0) + ";"; }); }
  function linkify(html) { return html.replace(/https?:\\/\\/[^\\s<]+/g, function (url) { return '<a href="' + url + '" target="_blank">' + url + "</a>"; }); }
  var WALLET = ${JSON.stringify({
    projectId: view.walletProjectId ?? "",
    approver: view.approverId ?? "",
  })};
  var panel = document.getElementById("approve-panel");
  var terms = document.getElementById("approve-terms");
  var pausedTerms = null;
  function runMode() {
    var checked = document.querySelector('input[name="run-mode"]:checked');
    return checked ? checked.value : "auto";
  }
  function humanChip() { return document.querySelector('[data-rail="human"]'); }
  function decide(approve) {
    panel.classList.remove("on");
    fetch("/demo/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: approve }),
    });
  }
  function extractSignature(result) {
    var raw =
      result &&
      (result.userSignature ||
        result.signature ||
        (result[0] && (result[0].userSignature || result[0].signature)));
    if (!raw) return null;
    if (typeof raw === "string") return raw;
    var bytes = raw instanceof Uint8Array ? raw : raw.data ? new Uint8Array(raw.data) : null;
    if (!bytes) return null;
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  async function walletApprove() {
    try {
      if (!pausedTerms) throw new Error("no paused terms captured");
      statusText.textContent = "Waiting for the wallet signature…";
      var sdk = await import("https://esm.sh/@hashgraph/sdk@2?bundle");
      var hcmod = await import("https://esm.sh/hashconnect@3?bundle");
      if (!window.__hc) {
        var hc = new hcmod.HashConnect(
          sdk.LedgerId.TESTNET,
          WALLET.projectId,
          { name: "hiero-x402 demo", description: "human approval", icons: [], url: location.origin },
          false,
        );
        var paired = new Promise(function (res) { hc.pairingEvent.on(res); });
        await hc.init();
        if (!(hc.connectedAccountIds && hc.connectedAccountIds.length)) {
          hc.openPairingModal();
          await paired;
        }
        window.__hc = hc;
      }
      var hc2 = window.__hc;
      var acct =
        hc2.connectedAccountIds && hc2.connectedAccountIds.length
          ? hc2.connectedAccountIds[0].toString()
          : WALLET.approver;
      var result = await hc2.signMessages(sdk.AccountId.fromString(acct), pausedTerms);
      var sig = extractSignature(result);
      if (!sig) throw new Error("could not read a signature from the wallet response");
      var resp = await fetch("/demo/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approve: true, accountId: acct, signature: sig }),
      });
      if (!resp.ok) {
        var e = await resp.json().catch(function () { return {}; });
        throw new Error(e.error || "hub answered " + resp.status);
      }
      panel.classList.remove("on");
    } catch (err) {
      statusText.textContent = "Wallet approval failed (" + (err && err.message) + ") — the button below still works.";
      document.getElementById("approve-yes").style.display = "";
    }
  }
  document.getElementById("approve-yes").addEventListener("click", function () { decide(true); });
  document.getElementById("approve-no").addEventListener("click", function () { decide(false); });
  document.getElementById("approve-wallet").addEventListener("click", function () { walletApprove(); });
  var proofUrl = null;
  // Outcome facts read from the narration itself — the hub never assumes a
  // run succeeded just because it ended (a declined or failed run must not
  // dress last run's receipt up as fresh).
  var sawReceipt = false;
  var exitCode = null; // agent convention: 0 paid · 2 unverified · 3 declined
  var currentTx = null;
  function syncHumanStage() {
    var rails = document.querySelector(".rails");
    if (rails) rails.classList.toggle("with-human", runMode() !== "auto");
  }
  document.querySelectorAll('input[name="run-mode"]').forEach(function (radio) {
    radio.addEventListener("change", syncHumanStage);
  });
  syncHumanStage();
  button.addEventListener("click", function () {
    button.disabled = true;
    button.textContent = "Running the agent…";
    hint.style.display = "none";
    status.className = "status on";
    statusText.textContent = "Running in the background…";
    log.style.display = "block";
    log.innerHTML = "";
    document.querySelectorAll("[data-rail]").forEach(function (chip) { chip.classList.remove("lit", "wait"); });
    proofUrl = null;
    sawReceipt = false;
    exitCode = null;
    currentTx = null;
    pausedTerms = null;
    panel.classList.remove("on");
    var mode = runMode();
    document.querySelectorAll('input[name="run-mode"]').forEach(function (radio) { radio.disabled = true; });
    document.getElementById("approve-wallet").style.display = mode === "wallet" ? "" : "none";
    document.getElementById("approve-yes").style.display = mode === "wallet" ? "none" : "";
    var events = new EventSource("/demo/run" + (mode !== "auto" ? "?approval=1" : ""));
    events.addEventListener("line", function (event) {
      log.innerHTML += linkify(esc(event.data)) + "\\n";
      log.scrollTop = log.scrollHeight;
      // Step 6½ — the content commitment. Light the rail only when the
      // server actually committed; an uncommitted run leaves it dark, the
      // same honesty as the receipt's registers.
      if (event.data.indexOf("[agent] 6\\u00bd \\u00b7 content COMMITTED") === 0) {
        var contentChip = document.querySelector('[data-rail="content"]');
        if (contentChip) contentChip.classList.add("lit");
      }
      var step = event.data.match(/^\\[agent\\] (\\d)/);
      if (step && STAGE[step[1]]) {
        var chip = document.querySelector('[data-rail="' + STAGE[step[1]] + '"]');
        if (chip) chip.classList.add("lit");
      }
      if (event.data.indexOf("approved by human") !== -1) {
        humanChip().classList.remove("wait");
        humanChip().classList.add("lit");
        panel.classList.remove("on");
        statusText.textContent = "Approved — the agent takes it from here…";
      }
      if (event.data.indexOf("declined by human") !== -1) {
        humanChip().classList.remove("wait");
        panel.classList.remove("on");
      }
      var proof = event.data.match(/hashscan: (https?:\\/\\/\\S+)/);
      if (proof) proofUrl = proof[1];
    });
    // MACHINE facts arrive as typed events, parsed once server-side — the
    // narration lines above stay display-only, so rewording a log line can
    // never flip an outcome here.
    events.addEventListener("paused", function (event) {
      humanChip().classList.add("wait");
      terms.textContent = event.data; // the human-readable terms, for display
      panel.classList.add("on");
      statusText.textContent = "Paused — the agent is waiting for YOUR approval.";
    });
    // The hub's one-time challenge for this pause — the wallet signs THIS
    // verbatim, never the bare terms line (which repeats run to run and
    // would replay); the server verifies the same string, by construction.
    events.addEventListener("challenge", function (event) {
      pausedTerms = event.data;
    });
    events.addEventListener("receipt", function () { sawReceipt = true; });
    events.addEventListener("settled", function (event) { currentTx = event.data; });
    events.addEventListener("exit", function (event) { exitCode = parseInt(event.data, 10); });
    events.addEventListener("done", function () {
      events.close();
      button.disabled = false;
      document.querySelectorAll('input[name="run-mode"]').forEach(function (radio) { radio.disabled = false; });
      panel.classList.remove("on");
      button.textContent = label;
      // The outcome comes from the narration, never from "the run ended":
      // a declined or failed run wrote NO receipt — the cards below still
      // show the LAST successful run's artifacts, and saying so beats
      // letting a stale PAID receipt read as this run's result.
      if (exitCode === 3) {
        status.className = "status on";
        statusText.textContent = "Declined — nothing signed, nothing spent. No new receipt.";
        hint.style.display = "none";
        return;
      }
      if (!sawReceipt) {
        status.className = "status on err";
        statusText.textContent =
          "Run failed before writing a receipt (see the log) — any receipt below is from an earlier run.";
        hint.style.display = "none";
        return;
      }
      if (exitCode !== 0) {
        // The agent wrote its receipt and THEN refused to call it paid —
        // the fresh artifact below is stamped for review, not success.
        status.className = "status on err";
        statusText.textContent =
          "Run ended but the settlement did NOT verify as paid — the fresh receipt below is stamped for review.";
        hint.style.display = "none";
        // The failed verdict was still attested — keep the audit view honest.
        if (auditBtn) { loadAudit(); setTimeout(loadAudit, 8000); }
        return;
      }
      status.className = "status on done";
      statusText.textContent = "Complete — settlement verified. See the fresh receipt below.";
      if (proofUrl) {
        hint.innerHTML =
          'Settled — <a href="' + esc(proofUrl) + '" target="_blank">check the transaction on HashScan ↗</a>';
      }
      hint.style.display = "block";
      // The run just attested — refresh the audit view (twice: mirrors lag
      // consensus by a few seconds, so the second pass catches the message).
      if (auditBtn) { loadAudit(); setTimeout(loadAudit, 8000); }
    });
    events.onerror = function () {
      events.close();
      button.disabled = false;
      document.querySelectorAll('input[name="run-mode"]').forEach(function (radio) { radio.disabled = false; });
      panel.classList.remove("on");
      button.textContent = label;
      status.className = "status on err";
      statusText.textContent = "Run ended — the stream closed (see the log above).";
    };
  });
})();
</script>`;
}
