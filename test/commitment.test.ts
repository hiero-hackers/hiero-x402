// SPDX-License-Identifier: Apache-2.0
/**
 * The content-commitment loop, pinned end-to-end and offline: a REAL signed
 * payment payload through the REAL app (mock facilitator verifying and
 * settling), asserting the paid response carries x-content-* headers whose
 * signature verifies over the exact bytes received — the same check the
 * agent runs live. If the middleware layering ever stops seeing the
 * settlement header, this suite goes red instead of every receipt quietly
 * reading AGENT RECORD.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrivateKey, PublicKey } from "@hiero-ledger/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { Hono } from "hono";
import {
  CONTENT_SHA256_HEADER,
  CONTENT_SIGNATURE_HEADER,
  CONTENT_SIGNER_HEADER,
  contentCommitmentMessage,
  sha256Hex,
} from "../src/index.js";
import { createApp } from "../demo/app.js";

const FEE_PAYER = "0.0.7000001";
const PAY_TO = "0.0.4507290";
const AGENT = "0.0.4507291";
const SIGNER = "0.0.7000009";
const SETTLEMENT_ID = `${FEE_PAYER}@1753099999.123456789`;

const signerKey = PrivateKey.generateED25519();
const agentKey = PrivateKey.generateED25519();

let facilitator: Server;
let app: Hono;

beforeAll(async () => {
  // A mock facilitator that VERIFIES and SETTLES — the full happy path,
  // no chain involved. Speaks the same three endpoints the real one does.
  facilitator = createServer((req, res) => {
    const ok = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/supported") {
      ok({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "hedera:testnet",
            extra: { feePayer: FEE_PAYER },
          },
        ],
        extensions: [],
        signers: { "hedera:*": [FEE_PAYER] },
      });
      return;
    }
    if (req.method === "POST" && req.url === "/verify") {
      ok({ isValid: true, payer: AGENT });
      return;
    }
    if (req.method === "POST" && req.url === "/settle") {
      ok({ success: true, transaction: SETTLEMENT_ID, network: "hedera:testnet", payer: AGENT });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => facilitator.listen(0, resolve));
  const address = facilitator.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  app = createApp({
    network: "hedera:testnet",
    payTo: PAY_TO,
    facilitatorUrl: `http://127.0.0.1:${address.port}`,
    checkoutBase: "https://hiero-hackers.github.io/hiero-checkout/",
    verifyBeforeServe: false,
    contentSigner: { accountId: SIGNER, key: signerKey },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
});

afterAll(() => {
  facilitator.close();
});

// MOCKCOIN keeps the route on the deterministic mock branch — the HBAR
// branch would reach for the live exchange rate, and this suite is offline.
const RESOURCE = "/data/spot-price";
const url = `http://localhost${RESOURCE}?symbol=MOCKCOIN`;

async function payOnce(): Promise<Response> {
  const httpClient = new x402HTTPClient(
    new x402Client().register(
      "hedera:*",
      new ExactHederaScheme(
        createClientHederaSigner(AGENT, agentKey, { network: "hedera:testnet" }),
      ),
    ),
  );
  const challenge = await app.request(url);
  expect(challenge.status).toBe(402);
  const required = httpClient.getPaymentRequiredResponse(
    (name) => challenge.headers.get(name) ?? undefined,
    await challenge
      .clone()
      .json()
      .catch(() => undefined),
  );
  const payload = await httpClient.createPaymentPayload(required);
  return app.request(url, { headers: httpClient.encodePaymentSignatureHeader(payload) });
}

describe("content commitment on the paid wire", () => {
  it("signs the exact served bytes against the settlement, verifiably", async () => {
    const paid = await payOnce();
    expect(paid.status).toBe(200);
    const bytes = Buffer.from(await paid.clone().arrayBuffer());

    // The commitment headers are present…
    const sha = paid.headers.get(CONTENT_SHA256_HEADER);
    const signer = paid.headers.get(CONTENT_SIGNER_HEADER);
    const signature = paid.headers.get(CONTENT_SIGNATURE_HEADER);
    expect(signer).toBe(SIGNER);
    // …the hash is of the exact bytes received…
    expect(sha).toBe(sha256Hex(bytes));
    // …and the signature verifies over (txId, reference, hash) with the
    // signer's PUBLIC key — precisely what the agent checks via the mirror.
    const message = contentCommitmentMessage({
      transactionId: SETTLEMENT_ID,
      reference: RESOURCE,
      sha256: sha256Hex(bytes),
    });
    const publicKey = PublicKey.fromString(signerKey.publicKey.toStringRaw());
    expect(
      publicKey.verify(Buffer.from(message, "utf8"), Buffer.from(signature ?? "", "base64")),
    ).toBe(true);
    // A different transaction id must NOT verify — the binding is per-payment.
    const wrongTx = contentCommitmentMessage({
      transactionId: `${FEE_PAYER}@1753099999.999999999`,
      reference: RESOURCE,
      sha256: sha256Hex(bytes),
    });
    expect(
      publicKey.verify(Buffer.from(wrongTx, "utf8"), Buffer.from(signature ?? "", "base64")),
    ).toBe(false);
  });

  it("stays silent when no signer is configured — absence, not broken headers", async () => {
    const address = facilitator.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const bare = createApp({
      network: "hedera:testnet",
      payTo: PAY_TO,
      facilitatorUrl: `http://127.0.0.1:${address.port}`,
      checkoutBase: "https://hiero-hackers.github.io/hiero-checkout/",
      verifyBeforeServe: false,
    });
    const challenge = await bare.request(url);
    expect(challenge.status).toBe(402);
    expect(challenge.headers.get(CONTENT_SHA256_HEADER)).toBeNull();
  });
});
