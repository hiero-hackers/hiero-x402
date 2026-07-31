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
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
  commitmentReference,
  contentCommitmentMessage,
  restTransactionId,
  sha256Hex,
  toPaymentRequirements,
  verifySettlement,
} from "../src/index.js";
import type { SupportedNetwork } from "../src/index.js";
import { auditTopic } from "./audit.js";
import { hubHTML } from "./hub.js";
import { CATALOG, productRequest, verifySignatureWithKey } from "./shared.js";

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
  /**
   * The HCS attestation topic the hub links and audits (optional). Passed
   * in — never read from env here — so the factory stays honest to its
   * "env-free" contract and a hermetic test boot can never accidentally
   * reach a live mirror because of a stray shell variable.
   */
  readonly attestTopicId?: string;
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

/** One pause's approval challenge: what the wallet signs, and why it can be
 *  signed exactly once. */
interface PendingChallenge {
  /** The agent's own terms line, verbatim — the human-readable part. */
  readonly terms: string;
  readonly nonce: string;
  readonly issued: string;
  /** The full string presented to the wallet and verified on return. */
  readonly challenge: string;
}

/**
 * Mint the string a wallet must sign for THIS pause. The agent's terms line
 * is identical on every run of the same product, so signing it alone would
 * make a captured signature approve every future run — and the attestation
 * would then record a human consenting to a payment they never saw. The
 * nonce is fresh per pause, single-use, and dies with the run.
 */
function mintChallenge(terms: string): PendingChallenge {
  const nonce = randomBytes(16).toString("hex");
  const issued = new Date().toISOString();
  return {
    terms,
    nonce,
    issued,
    challenge: `hiero-x402 approval · ${terms} · nonce ${nonce} · issued ${issued}`,
  };
}

/**
 * Does `signature` (base64) verify as the approver's key over the challenge
 * the hub minted for this pause? Tries the raw bytes and the legacy
 * "Hedera Signed Message" prefix some wallets apply — either is the same
 * human consenting to the same terms.
 */
function verifyConsent(publicKey: string, terms: string, signatureB64: string): boolean {
  const direct = Buffer.from(terms, "utf8");
  const prefixed = Buffer.concat([
    Buffer.from(`\x19Hedera Signed Message:\n${direct.length}`, "utf8"),
    direct,
  ]);
  return (
    verifySignatureWithKey(publicKey, direct, signatureB64) ||
    verifySignatureWithKey(publicKey, prefixed, signatureB64)
  );
}

/**
 * The settlement, read off a response — the ONE owner of where it lives
 * (`payment-response`, with the legacy `x-payment-response` spelling
 * accepted) and how it decodes (base64 JSON; malformed → undefined, never
 * a crash mid-response). The transaction id comes back REST-normalized —
 * the repo's one canonical spelling.
 */
function readSettlement(
  headers: Headers,
): { transactionId: string; payer?: string; success?: boolean } | undefined {
  const header = headers.get("payment-response") ?? headers.get("x-payment-response");
  if (header === null) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      success?: boolean;
      transaction?: unknown;
      payer?: string;
    };
    if (typeof decoded.transaction !== "string" || decoded.transaction === "") return undefined;
    return {
      transactionId: restTransactionId(decoded.transaction),
      ...(decoded.payer !== undefined ? { payer: decoded.payer } : {}),
      ...(decoded.success !== undefined ? { success: decoded.success } : {}),
    };
  } catch {
    return undefined;
  }
}

export function createApp(options: AppOptions): Hono {
  const { network, payTo, checkoutBase } = options;

  // Receipts are SESSION artifacts: a receipt.html left on disk by an
  // earlier session must not surface as if this server produced it — no
  // receipt shows until a run under THIS boot writes one. mtime vs boot
  // time is the whole check; `npm run e2e` in a terminal counts too.
  const bootAt = Date.now();
  const freshReceipt = (file: string): boolean =>
    existsSync(file) && statSync(file).mtimeMs >= bootAt;

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
  // One owner for path → product (verify wrapper below and any future
  // consumer look it up here rather than re-scanning the catalog).
  const productByPath = new Map(CATALOG.map((product) => [product.path, product]));
  if (options.verifyBeforeServe) {
    app.use("*", async (c, next) => {
      await next();
      const settle = readSettlement(c.res.headers);
      if (settle === undefined || settle.success !== true) return; // unpaid path — nothing to check
      const product = productByPath.get(c.req.path);
      if (product === undefined) return;
      const requirements = toPaymentRequirements(productRequest(product, payTo, network), {
        feePayer: settle.payer ?? "0.0.0",
      });
      const verdict = await verifySettlement(requirements, settle.transactionId, product.path, {
        attempts: 10,
        delayMs: 3000,
      });
      if (verdict.fulfilment.status !== "paid") {
        console.warn(
          `[server] withholding ${product.path}: settlement ${settle.transactionId} ` +
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
  app.get("/ui", (c) =>
    c.html(
      hubHTML({
        network,
        liveRuns: options.runAgent !== undefined,
        ...(options.approver !== undefined ? { approverId: options.approver.accountId } : {}),
        ...(options.walletProjectId !== undefined
          ? { walletProjectId: options.walletProjectId }
          : {}),
        topic: options.attestTopicId ?? "",
        receiptFresh: freshReceipt,
      }),
    ),
  );

  // The dashboard's live run: one click starts the agent (a SEPARATE
  // process holding its own key) and streams its numbered narration back
  // as server-sent events. One run at a time — settlements are real.
  let agentRunning = false;
  let pendingDecision: ((approve: boolean, consent?: string) => void) | undefined;
  let pendingChallenge: PendingChallenge | undefined;
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
          await sse.writeSSE({ event: "line", data: line });
          // MACHINE facts ride typed events, parsed ONCE here — the
          // browser must never reconstruct outcomes by regexing prose
          // (rewording a narration line must not flip a verdict).
          const paused = line.match(/AWAITING HUMAN APPROVAL — (?<terms>.+)\? \(y\/N\)$/);
          if (paused?.groups?.terms !== undefined) {
            // "paused" carries the human-readable terms for display; the
            // wallet signs the minted CHALLENGE, never the bare terms —
            // one pause, one nonce, or a captured signature would approve
            // every future run of the same product.
            const challenge = mintChallenge(paused.groups.terms);
            pendingChallenge = challenge;
            await sse.writeSSE({ event: "paused", data: challenge.terms });
            await sse.writeSSE({ event: "challenge", data: challenge.challenge });
          }
          if (line.includes("receipt written to")) {
            await sse.writeSSE({ event: "receipt", data: "written" });
          }
          const settled = line.match(/\/api\/v1\/transactions\/(\S+)/);
          if (settled !== null) await sse.writeSSE({ event: "settled", data: settled[1]! });
          const exited = line.match(/process exited with code (-?\d+)$/);
          if (exited !== null) await sse.writeSSE({ event: "exit", data: exited[1]! });
        }
        await sse.writeSSE({ event: "done", data: "run complete" });
      } finally {
        agentRunning = false;
        pendingDecision = undefined;
        pendingChallenge = undefined;
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
      // approver's on-chain key over the exact challenge the hub minted.
      const approver = options.approver;
      if (approver === undefined) {
        return c.json({ error: "no approver configured — wallet approvals are off" }, 501);
      }
      const challenge = pendingChallenge;
      if (challenge === undefined) {
        return c.json({ error: "no challenge pending — nothing to sign yet" }, 409);
      }
      if (body.accountId !== approver.accountId) {
        return c.json(
          { error: "approvals must come from the configured APPROVER_ACCOUNT_ID" },
          403,
        );
      }
      if (!verifyConsent(approver.publicKey, challenge.challenge, body.signature)) {
        return c.json(
          { error: "signature did not verify against the approver's on-chain key" },
          403,
        );
      }
      // `terms` carries the nonce and issue time, so an auditor holding only
      // the attestation can re-verify the signature from the record itself.
      const consent = Buffer.from(
        JSON.stringify({
          accountId: body.accountId,
          terms: challenge.challenge,
          signature: body.signature,
        }),
      ).toString("base64");
      pendingChallenge = undefined; // single use
      pendingDecision = undefined;
      decide(true, consent);
      return c.json({ ok: true, verified: true });
    }
    pendingDecision = undefined;
    decide(body.approve === true);
    return c.json({ ok: true });
  });

  // The hub's audit view — the SAME auditTopic() the CLI runs, served as
  // JSON so the dashboard shows the log RE-VERIFIED live, not just linked.
  // 501 is honest when no topic is configured (same posture as /demo/run).
  app.get("/demo/audit", async (c) => {
    const topic = options.attestTopicId ?? "";
    if (topic === "" || topic === "create") {
      return c.json({ error: "no ATTEST_TOPIC_ID configured — attestations are off" }, 501);
    }
    try {
      const report = await auditTopic(topic, network);
      // Session scope, same rule as the receipts: the hub presents what
      // happened under THIS boot; the topic's full history stays one
      // `npm run audit` away. Consensus timestamps are seconds.nanos.
      const entries = report.entries.filter(
        (entry) => Number(entry.consensusAt.split(".")[0]) * 1000 >= bootAt,
      );
      return c.json({
        ...report,
        entries,
        broken: entries.filter((entry) => entry.content?.commitment?.holds === false).length,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // The demo's receipt artifacts — served ONLY when written under this
  // boot (see freshReceipt): a 404 before the first run of THIS session is
  // honest, and a stale artifact from last week must never pass as today's.
  app.get("/receipts/:name", (c) => {
    const name = c.req.param("name");
    if (name !== "receipt" && name !== "verified-receipt") return c.notFound();
    const file = `${name}.html`;
    if (!freshReceipt(file)) {
      return c.html(
        `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;min-height:60vh;background:#0b0a10;color:#9d97ae;font:0.95rem system-ui"><p style="max-width:28rem;text-align:center;line-height:1.6">No receipt from this session yet — run the agent first.<br><small>Artifacts left by earlier sessions are deliberately withheld: a receipt only shows for a payment that actually happened under this server.</small></p></body>`,
        404,
      );
    }
    return c.html(readFileSync(file, "utf8"));
  });

  // The unpaid front door: the catalog, each product with its price in
  // atomic units AND the human-scannable checkout link for the same terms
  // (the bonus beat — agents keep the 402 path).
  // Every input is fixed at construction, so the catalog is built ONCE —
  // this route is also the boot health probe (up.ts polls it), so a static
  // body beats re-deriving checkout links per poll.
  const catalog = {
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
  };
  app.get("/", (c) => c.json(catalog));

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
      // readSettlement hands back the REST-normalized id — the ONE
      // canonical form, shared with verdicts, mirror links, and topic
      // attestations, so an auditor can rebuild this exact message from
      // the log alone. No settlement → nothing to bind → no headers.
      const settle = readSettlement(res.headers);
      if (settle === undefined) return;
      // Buffer ONCE: this body serves both the hash and the client (a
      // clone() would tee the stream and buffer it twice per paid 200).
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha256 = sha256Hex(bytes);
      const message = contentCommitmentMessage({
        transactionId: settle.transactionId,
        reference: commitmentReference(c.req.url),
        sha256,
      });
      const signature = Buffer.from(contentSigner.key.sign(Buffer.from(message, "utf8"))).toString(
        "base64",
      );
      const headers = new Headers(res.headers);
      headers.set(CONTENT_SHA256_HEADER, sha256);
      headers.set(CONTENT_SIGNER_HEADER, contentSigner.accountId);
      headers.set(CONTENT_SIGNATURE_HEADER, signature);
      c.res = new Response(bytes, { status: res.status, headers });
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
