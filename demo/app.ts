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
        <td style="text-align:right"><code>${esc(price)}</code></td>
        <td><a href="${esc(link)}">pay as a human</a></td>
      </tr>`;
    }).join("");
    const receiptLink = (file: string, label: string): string =>
      existsSync(file)
        ? `<li><a href="/receipts/${esc(file.replace(".html", ""))}">${esc(label)}</a></li>`
        : `<li style="color:#888">${esc(label)} — none yet (run the demo)</li>`;
    return c.html(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>hiero-x402 demo</title>
<div style="font-family:system-ui,sans-serif;max-width:36rem;margin:1.5rem auto;padding:0 1rem;display:flex;flex-direction:column;gap:1.25rem">
  <header>
    <h1 style="margin:0;font-size:1.3rem">hiero-x402 demo</h1>
    <p style="margin:.3rem 0 0;color:#555">Mock market data behind HTTP&nbsp;402 on <code>${esc(network)}</code>.
    Agents pay the 402; humans pay the same price via checkout; every settlement is
    independently verified.</p>
  </header>
  <section>
    <h2 style="font-size:1rem;margin:0 0 .5rem">Live end-to-end — the agent rails</h2>
    <div style="display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;font-size:.72rem">
      <span data-rail="agent" style="padding:.15rem .5rem;border:1px solid #ccc;border-radius:999px;background:#fff">agent · client key</span><span style="color:#888">→</span>
      <span data-rail="server" style="padding:.15rem .5rem;border:1px solid #ccc;border-radius:999px;background:#fff">server · no keys</span><span style="color:#888">→</span>
      <span data-rail="facilitator" style="padding:.15rem .5rem;border:1px solid #ccc;border-radius:999px;background:#fff">facilitator · fee-payer key</span><span style="color:#888">→</span>
      <span data-rail="chain" style="padding:.15rem .5rem;border:1px solid #ccc;border-radius:999px;background:#fff">Hedera testnet</span><span style="color:#888">→</span>
      <span data-rail="mirror" style="padding:.15rem .5rem;border:1px solid #ccc;border-radius:999px;background:#fff">mirror verify</span><span style="color:#888">→</span>
      <span data-rail="hcs" style="padding:.15rem .5rem;border:1px solid #ccc;border-radius:999px;background:#fff">HCS attest</span>
    </div>
    ${
      options.runAgent !== undefined
        ? `<button id="run-agent" style="margin:.6rem 0 0;padding:.45rem .9rem;border:1px solid #99f;border-radius:8px;background:#eef;font-size:.85rem;cursor:pointer">▶ Run the agent — pays real testnet HBAR</button>`
        : `<p style="color:#888;font-size:.8rem;margin:.6rem 0 0">Live runs are off here — start via <code>npm run demo</code> and use the hub it prints.</p>`
    }
    <pre id="run-log" style="display:none;margin:.6rem 0 0;background:#14161a;color:#d8dce2;padding:.75rem;border-radius:8px;font-size:.72rem;line-height:1.5;max-height:16rem;overflow:auto;white-space:pre-wrap"></pre>
    <p id="run-hint" style="display:none;font-size:.85rem;margin:.5rem 0 0">Done — <a href="/receipts/receipt">open the fresh receipt</a> (the rails above show how far the run got).</p>
  </section>
  <section>
    <h2 style="font-size:1rem;margin:0 0 .5rem">Catalog — one price, two rails</h2>
    <table style="width:100%;border-collapse:collapse;font-size:.9rem">${rows}</table>
    <p style="color:#555;font-size:.8rem;margin:.5rem 0 0">Agents: <code>GET</code> any path above → 402 challenge → pay → data.</p>
  </section>
  <section>
    <h2 style="font-size:1rem;margin:0 0 .5rem">Receipts (from real runs)</h2>
    <ul style="margin:0;padding-left:1.2rem">
      ${receiptLink("receipt.html", "latest settlement — verified against the mirror")}
      ${receiptLink("verified-receipt.html", "block-proof settlement — cryptographically verified")}
    </ul>
  </section>
  <section>
    <h2 style="font-size:1rem;margin:0 0 .5rem">Audit trail</h2>
    <p style="margin:0;font-size:.9rem">${
      topic !== "" && topic !== "create"
        ? `Verdicts attested to HCS topic <a href="https://hashscan.io/testnet/topic/${esc(topic)}"><code>${esc(topic)}</code></a> — an append-only public log.`
        : `Set <code>ATTEST_TOPIC_ID</code> to attest verdicts to a public HCS topic.`
    }</p>
  </section>
</div>
<script>
(function () {
  var button = document.getElementById("run-agent");
  if (!button) return;
  var log = document.getElementById("run-log");
  var hint = document.getElementById("run-hint");
  // Agent step number → which rail lights up (demo/agent.ts numbers them).
  var STAGE = { 1: "server", 2: "server", 3: "agent", 4: "facilitator", 5: "chain", 6: "mirror", 7: "agent", 8: "hcs" };
  function esc(text) { return text.replace(/[&<>"']/g, function (ch) { return "&#" + ch.charCodeAt(0) + ";"; }); }
  function linkify(html) { return html.replace(/https?:\\/\\/[^\\s<]+/g, function (url) { return '<a href="' + url + '" target="_blank" style="color:#9db8ff">' + url + "</a>"; }); }
  button.addEventListener("click", function () {
    button.disabled = true;
    hint.style.display = "none";
    log.style.display = "block";
    log.innerHTML = "";
    document.querySelectorAll("[data-rail]").forEach(function (chip) { chip.style.background = "#fff"; });
    var events = new EventSource("/demo/run");
    events.addEventListener("line", function (event) {
      log.innerHTML += linkify(esc(event.data)) + "\\n";
      log.scrollTop = log.scrollHeight;
      var step = event.data.match(/^\\[agent\\] (\\d)/);
      if (step && STAGE[step[1]]) {
        var chip = document.querySelector('[data-rail="' + STAGE[step[1]] + '"]');
        if (chip) chip.style.background = "#e3f0ec";
      }
    });
    events.addEventListener("done", function () {
      events.close();
      button.disabled = false;
      hint.style.display = "block";
    });
    events.onerror = function () { events.close(); button.disabled = false; };
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
