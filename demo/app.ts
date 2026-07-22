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
import { toPaymentRequirements, verifySettlement } from "../src/index.js";
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
   * Starts the agent as its OWN process and returns its narration stream
   * (stdout+stderr merged). The server never holds the agent's key — the
   * child reads it from .env itself. Absent → the hub's Run button is off
   * and /demo/run answers 501 (the conformance app, static deployments).
   */
  readonly runAgent?: () => Readable;
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
    const rows = CATALOG.map((product) => {
      const price =
        product.asset.kind === "hbar"
          ? `${product.amount.toString()} tinybar`
          : `${product.amount.toString()} ${product.asset.symbol} base units`;
      const link = toLink(productRequest(product, payTo, network), checkoutBase);
      return `<tr>
        <td><code>${esc(product.path)}</code></td>
        <td>${esc(product.label)}</td>
        <td style="text-align:right"><span class="price">${esc(price)}</span></td>
        <td style="text-align:right"><a class="pay" href="${esc(link)}">pay as a human ↗</a></td>
      </tr>`;
    }).join("");
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
        ? `<a class="rcard ${kind}" href="/receipts/${file.replace(".html", "")}">${inner}<span class="open">Open receipt →</span></a>`
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
  .rcard.empty .open{color:var(--faint)}
  @media(max-width:600px){.receipts{grid-template-columns:1fr}}
  footer{margin-top:2.75rem;padding-top:1.35rem;border-top:1px solid var(--line);
    display:flex;flex-wrap:wrap;gap:.5rem 1rem;justify-content:space-between;color:var(--faint);font-size:.8rem}
  @media(max-width:560px){.arrow{display:none}}
</style>
<div class="wrap">
  <div class="topbar">
    <div class="brand"><span class="mark">x4</span>hiero-x402 <small>settlement, verified</small></div>
    <span class="pill"><span class="dot"></span>network&nbsp;<code>${esc(network)}</code></span>
  </div>

  <header class="hero">
    <p class="eyebrow">HTTP 402 · verifiable settlement on Hiero</p>
    <h1>Settlement you don't have to trust.</h1>
    <p>Mock market data behind HTTP&nbsp;402. Agents pay the 402 challenge; humans pay the
    same price via checkout — and every settlement is independently verified against the
    ledger, not the facilitator's word.</p>
  </header>

  <div class="grid">
    <section class="card">
      <h2>Live end-to-end — the agent rails</h2>
      <p class="sub">One click runs the agent as its own process; each stage lights up as the settlement advances.</p>
      <div class="rails">
        <span class="rail" data-rail="agent">agent · client key</span><span class="arrow">→</span>
        <span class="rail" data-rail="server">server · no keys</span><span class="arrow">→</span>
        <span class="rail" data-rail="facilitator">facilitator · fee-payer key</span><span class="arrow">→</span>
        <span class="rail" data-rail="chain">Hedera testnet</span><span class="arrow">→</span>
        <span class="rail" data-rail="mirror">mirror verify</span><span class="arrow">→</span>
        <span class="rail" data-rail="hcs">HCS attest</span>
      </div>
      ${
        options.runAgent !== undefined
          ? `<button id="run-agent" class="btn">▶ Run the agent — pays real testnet HBAR</button>`
          : `<p class="note">Live runs are off here — start via <code>npm run demo</code> and use the hub it prints.</p>`
      }
      <div id="run-status" class="status"><span class="spin"></span><span id="run-status-text">Running in the background…</span></div>
      <pre id="run-log" style="display:none"></pre>
      <p id="run-hint" style="display:none">Done — <a href="/receipts/receipt">open the fresh receipt</a> (the rails above show how far the run got).</p>
    </section>

    <section class="card">
      <h2>Receipts — the proof you keep</h2>
      <p class="sub">This is the point of the project: every run ends in a receipt anyone can re-check — settlement you don't have to take on trust. Two rungs of the same ladder.</p>
      <div class="receipts">
        ${receiptCard(
          "receipt.html",
          "mirror",
          "Mirror receipt",
          "Mirror receipt",
          "The public mirror node's attested record of the settlement — independent of the facilitator, and re-checkable by anyone. Links straight to the raw mirror-node JSON.",
        )}
        ${receiptCard(
          "verified-receipt.html",
          "verified",
          "Block proof",
          "Verified settlement",
          "The ledger's own block proof — recomputed and checked before a single field is believed. Cryptography, not attestation: the only receipt we call verified.",
        )}
      </div>
    </section>

    <section class="card">
      <h2>Catalog — one price, two rails</h2>
      <p class="sub">Agents <code>GET</code> any path → 402 challenge → pay → data. Humans scan the same terms via checkout.</p>
      <table>
        <thead><tr><th>Path</th><th>Product</th><th style="text-align:right">Price</th><th style="text-align:right">Checkout</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
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
    <span>hiero-x402 · x402 on Hiero with verifiable settlement</span>
    <span>independent · facilitator-free verification</span>
  </footer>
</div>
<script>
(function () {
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
  button.addEventListener("click", function () {
    button.disabled = true;
    button.textContent = "Running the agent…";
    hint.style.display = "none";
    status.className = "status on";
    statusText.textContent = "Running in the background…";
    log.style.display = "block";
    log.innerHTML = "";
    document.querySelectorAll("[data-rail]").forEach(function (chip) { chip.classList.remove("lit"); });
    var events = new EventSource("/demo/run");
    events.addEventListener("line", function (event) {
      log.innerHTML += linkify(esc(event.data)) + "\\n";
      log.scrollTop = log.scrollHeight;
      var step = event.data.match(/^\\[agent\\] (\\d)/);
      if (step && STAGE[step[1]]) {
        var chip = document.querySelector('[data-rail="' + STAGE[step[1]] + '"]');
        if (chip) chip.classList.add("lit");
      }
    });
    events.addEventListener("done", function () {
      events.close();
      button.disabled = false;
      button.textContent = label;
      status.className = "status on done";
      statusText.textContent = "Complete — settlement finished. See the receipt below.";
      hint.style.display = "block";
    });
    events.onerror = function () {
      events.close();
      button.disabled = false;
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
  app.get("/demo/run", (c) => {
    const runAgent = options.runAgent;
    if (runAgent === undefined) {
      return c.json({ error: "live runs are disabled here — no agent runner attached" }, 501);
    }
    if (agentRunning) {
      return c.json({ error: "a run is already in progress — one settlement at a time" }, 409);
    }
    agentRunning = true;
    const lines = createInterface({ input: runAgent() });
    return streamSSE(c, async (sse) => {
      try {
        for await (const line of lines) {
          await sse.writeSSE({ event: "line", data: line });
        }
        await sse.writeSSE({ event: "done", data: "run complete" });
      } finally {
        agentRunning = false;
      }
    });
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
      service: "hiero-x402 demo — mock market data behind HTTP 402",
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

  app.use("*", paymentMiddleware(routes, x402Server));

  // Deterministic mock data — a demo should be reproducible, not random.
  app.get("/data/spot-price", (c) => {
    const symbol = c.req.query("symbol") ?? "HBAR";
    return c.json({ product: "spot-price", symbol, price: mockPrice(symbol), currency: "USD" });
  });
  app.get("/data/fx", (c) => {
    const pair = c.req.query("pair") ?? "USD/EUR";
    return c.json({ product: "fx", pair, rate: mockPrice(pair) / 10, currency: "USDC-priced" });
  });
  app.get("/data/ohlc", (c) => {
    const symbol = c.req.query("symbol") ?? "HBAR";
    const close = mockPrice(symbol);
    return c.json({
      product: "ohlc",
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

function mockPrice(symbol: string): number {
  let hash = 0;
  for (const ch of symbol) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return round2(1 + hash / 1_000);
}
const round2 = (n: number): number => Math.round(n * 100) / 100;
