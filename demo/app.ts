// SPDX-License-Identifier: Apache-2.0
/**
 * The resource server's app, as a FACTORY — env-free and listener-free so
 * the conformance suite can boot it against a mock facilitator and pin the
 * 402 wire shape in CI (test/conformance.test.ts). `server.ts` is the thin
 * entry that reads env and serves.
 *
 * Every product is a `PaymentRequest` first (demo/shared.ts). The bridge
 * (`toPaymentRequirements`) derives the x402 payment option the middleware
 * serves, and `toLink` derives the checkout URL a HUMAN could scan for the
 * very same price — one object, two audiences. The fee payer is NOT set
 * here: the middleware learns it from the facilitator's /supported.
 *
 * This process holds no keys. It relays payloads to the facilitator and
 * serves data once settlement succeeds.
 */
import { Buffer } from "node:buffer";
import { PublicKey } from "@hiero-ledger/sdk";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { toLink } from "@hiero-hackers/hiero-payment-requests";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { paymentMiddleware } from "@x402/hono";
import {
  CONTENT_SHA256_HEADER,
  CONTENT_SIGNATURE_HEADER,
  CONTENT_SIGNER_HEADER,
  MIRROR_HOSTS,
  contentCommitmentMessage,
  sha256Hex,
  toPaymentRequirements,
  verifySettlement,
} from "../src/index.js";
import type { SupportedNetwork } from "../src/index.js";
import { CATALOG, productRequest } from "./shared.js";

export interface AppOptions {
  readonly network: SupportedNetwork;
  readonly payTo: string;
  readonly facilitatorUrl: string;
  readonly checkoutBase: string;
  /** Withhold data until the mirror confirms — SECURITY.md § posture. */
  readonly verifyBeforeServe: boolean;
  /**
   * Starts the agent as its OWN process. The server never holds the agent's
   * key — the child reads it from .env itself. Absent → the hub's Run
   * button is off and /demo/run answers 501 (the conformance app, static
   * deployments). With `humanApproval`, the child pauses at step 2½ until
   * `decide` relays the human's answer to its stdin.
   */
  readonly runAgent?: (options: { humanApproval: boolean }) => AgentRun;
  /**
   * The expected human approver for wallet-signed consent (optional).
   * Resolved by the server at boot — the account id approvals must come
   * from, and its on-chain public key from the mirror, so /demo/approve
   * verifies signatures without any network call. Absent → the hub's
   * wallet mode is hidden; button approval still works.
   */
  readonly approver?: { readonly accountId: string; readonly publicKey: string };
  /** WalletConnect project id for the hub's wallet pairing (optional). */
  readonly walletProjectId?: string;
  /**
   * Content-commitment signer (optional). When set, every settled data
   * response is hashed and SIGNED against its settlement transaction —
   * "account X served exactly these bytes for exactly that payment", the
   * receipt's COMMITTED register, non-repudiable. This is an ATTESTATION
   * identity, not a treasury: point it at a dedicated account holding
   * nothing (see .env.example), so this key can commit to bytes but never
   * move money — the server's no-payment-keys posture is preserved.
   */
  readonly contentSigner?: {
    readonly accountId: string;
    readonly key: { sign(bytes: Uint8Array): Uint8Array };
  };
}

/** A started agent run: its narration, and — in approval mode — the gate. */
export interface AgentRun {
  /** stdout+stderr merged, line-oriented. */
  readonly narration: Readable;
  /**
   * Answers a pending 2½ approval prompt; absent outside approval mode.
   * `consent` (base64 JSON: accountId, terms, signature) rides along when
   * the approval was wallet-signed and hub-verified.
   */
  readonly decide?: (approve: boolean, consent?: string) => void;
}

/**
 * Does `signature` (base64) verify as the approver's key over the terms the
 * paused agent printed? Tries the raw bytes and the legacy
 * "Hedera Signed Message" prefix some wallets apply — either is the same
 * human consenting to the same terms.
 */
function verifyConsent(publicKey: string, terms: string, signatureB64: string): boolean {
  let key: PublicKey;
  try {
    key = PublicKey.fromString(publicKey);
  } catch {
    return false;
  }
  const signature = Buffer.from(signatureB64, "base64");
  if (signature.length === 0) return false;
  const direct = Buffer.from(terms, "utf8");
  const prefixed = Buffer.concat([
    Buffer.from(`\x19Hedera Signed Message:\n${direct.length}`, "utf8"),
    direct,
  ]);
  try {
    return key.verify(direct, signature) || key.verify(prefixed, signature);
  } catch {
    return false;
  }
}

export function createApp(options: AppOptions): Hono {
  const { network, payTo, checkoutBase } = options;

  const x402Server = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: options.facilitatorUrl }),
  ).register(network, new ExactHederaScheme());

  // The bridge in its server-side role: PaymentRequest → the x402 fields the
  // middleware needs. The feePayer placeholder never leaves this process —
  // the middleware substitutes the facilitator's real one from /supported.
  const routes: RoutesConfig = Object.fromEntries(
    CATALOG.map((product) => {
      const requirements = toPaymentRequirements(productRequest(product, payTo, network), {
        feePayer: "0.0.0",
      });
      return [
        `GET ${product.path}`,
        {
          description: product.label,
          accepts: {
            scheme: requirements.scheme,
            network: requirements.network,
            payTo: requirements.payTo,
            price: { asset: requirements.asset, amount: requirements.amount },
            maxTimeoutSeconds: requirements.maxTimeoutSeconds,
          },
        },
      ];
    }),
  );

  const app = new Hono();

  // DECIDED (launch issue #2): opt-in, not default. A failed settle is
  // already a 402 from the official middleware — this wrapper only upgrades
  // the SUCCESS path from "facilitator said so" to "chain confirmed".
  // Defaulting it on would tax every honest call with seconds of mirror
  // lag, against a product promise of "settles in seconds", while the
  // merchant's residual risk is bounded at one response per request — and
  // the payer-side agent in this stack verifies every settlement
  // regardless. Flip it on when one response is worth more than seconds of
  // latency (SECURITY.md § posture).
  if (options.verifyBeforeServe) {
    app.use("*", async (c, next) => {
      await next();
      const header = c.res.headers.get("payment-response");
      if (header === null) return; // unpaid path (402, catalog…) — nothing to check
      const settle = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        success?: boolean;
        transaction?: string;
        payer?: string;
      };
      if (settle.success !== true || settle.transaction === undefined) return;
      const product = CATALOG.find((entry) => entry.path === new URL(c.req.url).pathname);
      if (product === undefined) return;
      const requirements = toPaymentRequirements(productRequest(product, payTo, network), {
        feePayer: settle.payer ?? "0.0.0",
      });
      const verdict = await verifySettlement(requirements, settle.transaction, product.path, {
        attempts: 10,
        delayMs: 3000,
      });
      if (verdict.fulfilment.status !== "paid") {
        console.warn(
          `[server] withholding ${product.path}: settlement ${settle.transaction} ` +
            `verified as "${verdict.fulfilment.status}", not paid`,
        );
        c.res = new Response(
          JSON.stringify({
            error: "settlement did not verify against the public mirror — data withheld",
            verdict: verdict.fulfilment.status,
            transaction: verdict.transactionId,
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }
    });
  }

  // The demo HUB — the one page a human (or a video) needs. Everything the
  // demo produces, linked from a single column: the priced catalog (with
  // each product's checkout twin), the latest receipts, the audit topic.
  // Agents keep the JSON catalog at "/" — this is the human door.
  const esc = (text: string): string => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  app.get("/ui", (c) => {
    const topic = process.env.ATTEST_TOPIC_ID ?? "";
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
      return existsSync(file)
        ? `<a class="rcard ${kind}" href="/receipts/${file.replace(".html", "")}">${inner}<span class="open">Open receipt ↓</span></a>`
        : `<div class="rcard ${kind} empty">${inner}<span class="open">none yet — run the demo</span></div>`;
    };
    return c.html(`<!doctype html>
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
    <span class="pill"><span class="dot"></span>network&nbsp;<code>${esc(network)}</code></span>
  </div>

  <header class="hero">
    <p class="eyebrow">HTTP 402 · verifiable and trustworthy settlement on Hedera</p>
    <h1>Trusted Layer of AI settlement.</h1>
    <p>An agent discovers a x402 price on Hedera, pays it, and the settlement arrives as a mirror receipt or block proof (beta) - all independently verifiable.
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
        <span class="rail" data-rail="hcs">HCS attest</span>
      </div>
      ${
        options.runAgent !== undefined
          ? `<div class="toggle-group" id="mode-group">
               <label class="toggle"><input type="radio" name="run-mode" value="auto" checked><span>autonomous — no human in the loop</span></label>
               <label class="toggle"><input type="radio" name="run-mode" value="button"><span>require human approval — <b>hub button</b></span></label>
               ${
                 options.approver !== undefined && options.walletProjectId !== undefined
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
          "The public mirror node's attested record of the settlement — independent of the facilitator, and re-checkable by anyone.",
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
          ? `Verdicts attested to HCS topic <a href="https://hashscan.io/testnet/topic/${esc(topic)}"><code>${esc(topic)}</code></a> — an append-only public log.`
          : `Set <code>ATTEST_TOPIC_ID</code> to attest verdicts to a public HCS topic.`
      }</p>
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
    projectId: options.walletProjectId ?? "",
    approver: options.approver?.accountId ?? "",
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
      var step = event.data.match(/^\\[agent\\] (\\d)/);
      if (step && STAGE[step[1]]) {
        var chip = document.querySelector('[data-rail="' + STAGE[step[1]] + '"]');
        if (chip) chip.classList.add("lit");
      }
      if (event.data.indexOf("AWAITING HUMAN APPROVAL") !== -1) {
        humanChip().classList.add("wait");
        var shown = event.data.replace(/^.*AWAITING HUMAN APPROVAL — /, "").replace(/\\? \\(y\\/N\\)$/, "");
        pausedTerms = shown;
        terms.textContent = shown;
        panel.classList.add("on");
        statusText.textContent = "Paused — the agent is waiting for YOUR approval.";
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
    events.addEventListener("done", function () {
      events.close();
      button.disabled = false;
      document.querySelectorAll('input[name="run-mode"]').forEach(function (radio) { radio.disabled = false; });
      panel.classList.remove("on");
      button.textContent = label;
      status.className = "status on done";
      statusText.textContent = "Complete — settlement finished. See the receipt below.";
      if (proofUrl) {
        hint.innerHTML =
          'Settled — <a href="' + esc(proofUrl) + '" target="_blank">check the transaction on HashScan ↗</a>';
      }
      hint.style.display = "block";
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
</script>`);
  });

  // The dashboard's live run: one click starts the agent (a SEPARATE
  // process holding its own key) and streams its numbered narration back
  // as server-sent events. One run at a time — settlements are real.
  let agentRunning = false;
  let pendingDecision: ((approve: boolean, consent?: string) => void) | undefined;
  let pendingTerms: string | undefined;
  app.get("/demo/run", (c) => {
    const runAgent = options.runAgent;
    if (runAgent === undefined) {
      return c.json({ error: "live runs are disabled here — no agent runner attached" }, 501);
    }
    if (agentRunning) {
      return c.json({ error: "a run is already in progress — one settlement at a time" }, 409);
    }
    agentRunning = true;
    const run = runAgent({ humanApproval: c.req.query("approval") === "1" });
    pendingDecision = run.decide;
    const lines = createInterface({ input: run.narration });
    return streamSSE(c, async (sse) => {
      try {
        for await (const line of lines) {
          // The paused terms, verbatim — exactly what a wallet must sign.
          const paused = line.match(/AWAITING HUMAN APPROVAL — (.+)\? \(y\/N\)$/);
          if (paused !== null) pendingTerms = paused[1];
          await sse.writeSSE({ event: "line", data: line });
        }
        await sse.writeSSE({ event: "done", data: "run complete" });
      } finally {
        agentRunning = false;
        pendingDecision = undefined;
        pendingTerms = undefined;
      }
    });
  });

  // The hub's Approve/Decline buttons land here; the answer is relayed to
  // the paused agent's stdin. The gate itself lives in the agent — this
  // endpoint is only transport, so a curl can approve just as well.
  app.post("/demo/approve", async (c) => {
    if (options.runAgent === undefined) {
      return c.json({ error: "live runs are disabled here — no agent runner attached" }, 501);
    }
    const decide = pendingDecision;
    if (!agentRunning || decide === undefined) {
      return c.json({ error: "no approval pending — start a run with approval on" }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      approve?: boolean;
      accountId?: string;
      signature?: string;
    };
    if (body.signature !== undefined) {
      // Wallet-signed consent: cryptographic approval, verified against the
      // approver's on-chain key over the exact terms the agent printed.
      const approver = options.approver;
      if (approver === undefined) {
        return c.json({ error: "no approver configured — wallet approvals are off" }, 501);
      }
      if (pendingTerms === undefined) {
        return c.json({ error: "no terms pending — nothing to sign yet" }, 409);
      }
      if (body.accountId !== approver.accountId) {
        return c.json(
          { error: "approvals must come from the configured APPROVER_ACCOUNT_ID" },
          403,
        );
      }
      if (!verifyConsent(approver.publicKey, pendingTerms, body.signature)) {
        return c.json(
          { error: "signature did not verify against the approver's on-chain key" },
          403,
        );
      }
      const consent = Buffer.from(
        JSON.stringify({
          accountId: body.accountId,
          terms: pendingTerms,
          signature: body.signature,
        }),
      ).toString("base64");
      pendingDecision = undefined;
      decide(true, consent);
      return c.json({ ok: true, verified: true });
    }
    pendingDecision = undefined;
    decide(body.approve === true);
    return c.json({ ok: true });
  });

  // The demo's receipt artifacts, served when present (written by the agent
  // into the working directory; a 404 is honest before the first run).
  app.get("/receipts/:name", (c) => {
    const name = c.req.param("name");
    if (name !== "receipt" && name !== "verified-receipt") return c.notFound();
    const file = `${name}.html`;
    if (!existsSync(file)) return c.notFound();
    return c.html(readFileSync(file, "utf8"));
  });

  // The unpaid front door: the catalog, each product with its price in
  // atomic units AND the human-scannable checkout link for the same terms
  // (the bonus beat — agents keep the 402 path).
  app.get("/", (c) =>
    c.json({
      service:
        "hiero-x402 demo — market data behind HTTP 402 (HBAR spot is the live network exchange rate; other feeds are mock and say so)",
      network,
      products: CATALOG.map((product) => ({
        path: product.path,
        label: product.label,
        priceAtomic: product.amount.toString(),
        asset:
          product.asset.kind === "hbar" ? "HBAR (tinybar)" : `${product.asset.symbol} base units`,
        humanCheckout: toLink(productRequest(product, payTo, network), checkoutBase),
      })),
    }),
  );

  // Content commitment — OUTSIDE the payment middleware, so control returns
  // here after settlement with the X-PAYMENT-RESPONSE header (and its
  // transaction id) already on the response. Hash the exact bytes about to
  // go out, sign (txId, path, hash), and let the signature ride response
  // headers: the client can now hold the server to WHAT it served, not just
  // that it was paid. No settlement header → nothing to bind → no headers.
  const { contentSigner } = options;
  if (contentSigner !== undefined) {
    app.use("*", async (c, next) => {
      await next();
      const res = c.res;
      if (res.status !== 200) return;
      // v2 transport names it `payment-response`; `x-payment-response` is
      // the legacy spelling — accept either, same as the middleware does
      // for the request's payment header.
      const settlement =
        res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
      if (settlement === null) return;
      let transactionId: string;
      try {
        const decoded = JSON.parse(Buffer.from(settlement, "base64").toString("utf8")) as {
          transaction?: unknown;
        };
        if (typeof decoded.transaction !== "string" || decoded.transaction === "") return;
        transactionId = decoded.transaction;
      } catch {
        return; // a settlement header this process can't read is not ours to sign
      }
      const bytes = Buffer.from(await res.clone().arrayBuffer());
      const sha256 = sha256Hex(bytes);
      const message = contentCommitmentMessage({ transactionId, reference: c.req.path, sha256 });
      const signature = Buffer.from(contentSigner.key.sign(Buffer.from(message, "utf8"))).toString(
        "base64",
      );
      res.headers.set(CONTENT_SHA256_HEADER, sha256);
      res.headers.set(CONTENT_SIGNER_HEADER, contentSigner.accountId);
      res.headers.set(CONTENT_SIGNATURE_HEADER, signature);
    });
  }

  app.use("*", paymentMiddleware(routes, x402Server));

  // The data routes. HBAR spot is REAL — the chain's own exchange rate —
  // because a fabricated price next to a real cryptographic seal is exactly
  // the confusion this repo exists to end. Everything without a real source
  // says `mock: true` in the payload itself: the content commitment binds
  // these bytes to the payment, so the bytes must be honest about what the
  // number is.
  app.get("/data/spot-price", async (c) => {
    const symbol = c.req.query("symbol") ?? "HBAR";
    if (symbol !== "HBAR") {
      return c.json({
        product: "spot-price",
        mock: true,
        symbol,
        price: mockPrice(symbol),
        currency: "USD",
      });
    }
    const rate = await hbarUsdRate(network);
    if (rate === undefined) {
      // Refusing beats fabricating: a 502 here makes the payment middleware
      // CANCEL settlement (handler_failed), so the buyer is not charged for
      // a price this server could not actually source.
      return c.json({ error: "price source unreachable — not selling a made-up number" }, 502);
    }
    return c.json({
      product: "spot-price",
      mock: false,
      symbol,
      price: rate.price,
      currency: "USD",
      source: "hedera-network-exchange-rate",
      rateExpiresAt: rate.expirationTime,
    });
  });
  app.get("/data/fx", (c) => {
    const pair = c.req.query("pair") ?? "USD/EUR";
    return c.json({
      product: "fx",
      mock: true,
      pair,
      rate: mockPrice(pair) / 10,
      currency: "USDC-priced",
    });
  });
  app.get("/data/ohlc", (c) => {
    const symbol = c.req.query("symbol") ?? "HBAR";
    const close = mockPrice(symbol);
    return c.json({
      product: "ohlc",
      mock: true,
      symbol,
      open: round2(close * 0.98),
      high: round2(close * 1.03),
      low: round2(close * 0.96),
      close,
      currency: "USD",
    });
  });

  return app;
}

/**
 * The chain's own HBAR/USD rate, from the mirror's exchange-rate endpoint —
 * the price the network itself uses to convert fees. `cent_equivalent`
 * cents buy `hbar_equivalent` HBAR, so USD per HBAR is cents/hbars/100.
 * Any unreadable answer is undefined — the route refuses rather than
 * guesses.
 */
async function hbarUsdRate(
  network: SupportedNetwork,
): Promise<{ price: number; expirationTime: number } | undefined> {
  try {
    const response = await fetch(`${MIRROR_HOSTS[network]}/api/v1/network/exchangerate`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      current_rate?: {
        cent_equivalent?: number;
        hbar_equivalent?: number;
        expiration_time?: number;
      };
    };
    const cents = body.current_rate?.cent_equivalent;
    const hbars = body.current_rate?.hbar_equivalent;
    if (typeof cents !== "number" || typeof hbars !== "number" || cents <= 0 || hbars <= 0) {
      return undefined;
    }
    return {
      price: Math.round((cents / hbars / 100) * 1e6) / 1e6,
      expirationTime: body.current_rate?.expiration_time ?? 0,
    };
  } catch {
    return undefined;
  }
}

function mockPrice(symbol: string): number {
  let hash = 0;
  for (const ch of symbol) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return round2(1 + hash / 1_000);
}
const round2 = (n: number): number => Math.round(n * 100) / 100;
