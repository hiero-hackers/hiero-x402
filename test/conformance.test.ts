// SPDX-License-Identifier: Apache-2.0
/**
 * Wire conformance, machine-pinned (research/06 made the claims; this suite
 * enforces them in CI): the app is booted against a MOCK facilitator and
 * the actual bytes on the wire are asserted against the v2 transport spec
 * and the official Hedera scheme — no human curl required.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromAny } from "@hiero-hackers/hiero-payment-requests";
import { PrivateKey } from "@x402/hedera";
import type { Hono } from "hono";
import { createApp } from "../demo/app.js";
import { policyFromEnv, policyViolation, settleRefusal, verifyRefusal } from "../demo/policy.js";

const FEE_PAYER = "0.0.7000001";
const PAY_TO = "0.0.4507290";

let facilitator: Server;
let facilitatorUrl: string;
let app: Hono;

beforeAll(async () => {
  // A mock facilitator serving only /supported — all the middleware needs
  // to initialize and enrich challenges with the fee payer.
  facilitator = createServer((req, res) => {
    if (req.url === "/supported") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
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
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => facilitator.listen(0, resolve));
  const address = facilitator.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  facilitatorUrl = `http://127.0.0.1:${address.port}`;
  app = createApp({
    network: "hedera:testnet",
    payTo: PAY_TO,
    facilitatorUrl,
    checkoutBase: "https://hiero-hackers.github.io/hiero-checkout/",
    verifyBeforeServe: false,
  });
  // Let the middleware's facilitator sync settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 150));
});

afterAll(() => {
  facilitator.close();
});

describe("402 challenge wire (v2 transport + Hedera scheme)", () => {
  it("unpaid request → 402 with a PAYMENT-REQUIRED header whose payload IS the spec shape", async () => {
    const response = await app.request("/data/spot-price");
    expect(response.status).toBe(402);

    const header = response.headers.get("payment-required");
    expect(header).not.toBeNull();
    const required = JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as {
      x402Version: number;
      error: string;
      resource: { url: string };
      accepts: Record<string, unknown>[];
    };

    // v2 PaymentRequired envelope.
    expect(required.x402Version).toBe(2);
    expect(typeof required.error).toBe("string");
    expect(required.resource.url).toContain("/data/spot-price");
    expect(Array.isArray(required.accepts)).toBe(true);

    // The Hedera scheme's exact conventions, field for field.
    expect(required.accepts[0]).toEqual({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "5000000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 180,
      extra: { feePayer: FEE_PAYER },
    });
  });

  it("prices the USDC route in the official token, atomic units", async () => {
    const response = await app.request("/data/fx");
    expect(response.status).toBe(402);
    const required = JSON.parse(
      Buffer.from(response.headers.get("payment-required")!, "base64").toString("utf8"),
    ) as { accepts: { asset: string; amount: string }[] };
    expect(required.accepts[0]).toMatchObject({ asset: "0.0.429274", amount: "10000" });
  });

  it("serves the catalog unpaid, with checkout links that actually parse", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      products: { path: string; humanCheckout: string }[];
    };
    expect(body.products).toHaveLength(3);
    for (const product of body.products) {
      // The human twin must be a REAL request — fromAny validates in full.
      // The fragment is parsed RAW (percent-encoded), checkout's own rule.
      expect(fromAny(product.humanCheckout.split("#")[1]!)).toBeTruthy();
    }
  });
});

describe("the demo hub (/ui)", () => {
  it("serves the demo hub: run modes and receipt slots", async () => {
    const response = await app.request("/ui");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Live runs are off here"); // run modes render only with a runner
    expect(html).toContain("Receipts — the proof you keep");
    expect(html).toContain("Mirror receipt"); // the two rungs, clearly split
    expect(html).toContain("Block proof");
  });

  it("withholds receipts from earlier sessions — none until THIS boot writes one", async () => {
    // A freshly-booted app can have no receipt of its own yet, so this must
    // 404 even on a dev machine where a stale receipt.html sits on disk.
    const response = await app.request("http://localhost/receipts/receipt");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("No receipt from this session yet");
    // And the hub's card must offer no link to it, only the honest empty slot.
    const hub = await app.request("http://localhost/ui");
    expect(await hub.text()).toContain("none from this session yet");
  });

  it("receipt routes 404 honestly for unknown names", async () => {
    expect((await app.request("/receipts/evil")).status).toBe(404);
  });

  it("shows the live-run dashboard, with the button off when no runner is attached", async () => {
    const html = await (await app.request("/ui")).text();
    expect(html).toContain("Live end-to-end");
    expect(html).toContain("agent · client key");
    expect(html).toContain("Live runs are off here");
    expect(html).not.toContain('<button id="run-agent"'); // no button without a runner
  });

  it("/demo/audit answers 501 honestly when no attestation topic is configured", async () => {
    const response = await app.request("http://localhost/demo/audit");
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("ATTEST_TOPIC_ID");
  });

  it("/demo/run answers 501 honestly when no agent runner is attached", async () => {
    expect((await app.request("/demo/run")).status).toBe(501);
    expect((await app.request("/demo/approve", { method: "POST" })).status).toBe(501);
  });

  it("verifies a wallet-signed approval against the approver's key before releasing the gate", async () => {
    const approverKey = PrivateKey.generateED25519();
    const TERMS = "pay 5000000 tinybar of 0.0.0 to 0.0.7777 for /data/spot-price";
    const decisions: Array<[boolean, string | undefined]> = [];
    const withWallet = createApp({
      network: "hedera:testnet",
      payTo: PAY_TO,
      facilitatorUrl,
      checkoutBase: "https://hiero-hackers.github.io/hiero-checkout/",
      verifyBeforeServe: false,
      approver: { accountId: "0.0.4242", publicKey: approverKey.publicKey.toStringRaw() },
      walletProjectId: "test-project",
      runAgent: () => ({
        narration: Readable.from(`[agent] 2½ · AWAITING HUMAN APPROVAL — ${TERMS}? (y/N)\n`),
        decide: (approve, consent) => decisions.push([approve, consent]),
      }),
    });
    const post = (body: object) =>
      withWallet.request("/demo/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const streaming = withWallet.request("/demo/run?approval=1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Wrong signer account: refused.
    const stranger = PrivateKey.generateED25519();
    const strangerSig = Buffer.from(stranger.sign(Buffer.from(TERMS, "utf8"))).toString("base64");
    expect((await post({ accountId: "0.0.9999", signature: strangerSig })).status).toBe(403);
    // Right account, signature over the WRONG terms: refused.
    const wrongTerms = Buffer.from(
      approverKey.sign(Buffer.from("something else", "utf8")),
    ).toString("base64");
    expect((await post({ accountId: "0.0.4242", signature: wrongTerms })).status).toBe(403);
    // Right account, right terms: verified, gate released with the consent attached.
    const goodSig = Buffer.from(approverKey.sign(Buffer.from(TERMS, "utf8"))).toString("base64");
    const ok = await post({ approve: true, accountId: "0.0.4242", signature: goodSig });
    expect(ok.status).toBe(200);
    expect(decisions).toHaveLength(1);
    const [approved, consent] = decisions[0]!;
    expect(approved).toBe(true);
    const parsed = JSON.parse(Buffer.from(consent!, "base64").toString("utf8")) as {
      accountId: string;
      terms: string;
      signature: string;
    };
    expect(parsed.accountId).toBe("0.0.4242");
    expect(parsed.terms).toBe(TERMS);
    await (await streaming).text();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("/demo/approve relays the human's decision to the paused run's gate", async () => {
    const decisions: boolean[] = [];
    let sawApproval = false;
    const withRunner = createApp({
      network: "hedera:testnet",
      payTo: PAY_TO,
      facilitatorUrl,
      checkoutBase: "https://hiero-hackers.github.io/hiero-checkout/",
      verifyBeforeServe: false,
      runAgent: ({ humanApproval }) => {
        sawApproval = humanApproval;
        return {
          narration: Readable.from("[agent] 2½ · AWAITING HUMAN APPROVAL\n"),
          decide: (approve) => decisions.push(approve),
        };
      },
    });
    // No run yet → nothing to approve.
    expect((await withRunner.request("/demo/approve", { method: "POST" })).status).toBe(409);
    const streaming = withRunner.request("/demo/run?approval=1");
    // Approve while the stream is up, before it drains.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const approve = await withRunner.request("/demo/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    expect(approve.status).toBe(200);
    expect(decisions).toEqual([true]);
    expect(sawApproval).toBe(true);
    await (await streaming).text(); // drain; the finally releases the lock
    // After the run, the gate is gone again.
    expect((await withRunner.request("/demo/approve", { method: "POST" })).status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("/demo/run streams an injected agent narration as SSE and releases the lock", async () => {
    const withRunner = createApp({
      network: "hedera:testnet",
      payTo: PAY_TO,
      facilitatorUrl,
      checkoutBase: "https://hiero-hackers.github.io/hiero-checkout/",
      verifyBeforeServe: false,
      runAgent: () => ({
        narration: Readable.from("[agent] 1 · GET /data/spot-price\n[agent] 6 · VERIFYING\n"),
      }),
    });
    const response = await withRunner.request("/demo/run");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("data: [agent] 1 · GET /data/spot-price");
    expect(body).toContain("data: [agent] 6 · VERIFYING");
    expect(body).toContain("event: done");
    // The one-at-a-time lock must release after the stream ends.
    expect((await withRunner.request("/demo/run")).status).toBe(200);
    // And the hub shows the button + run modes when a runner IS attached.
    const runnerHtml = await (await withRunner.request("/ui")).text();
    expect(runnerHtml).toContain('<button id="run-agent"');
    expect(runnerHtml).toContain("autonomous — no human in the loop");
    expect(runnerHtml).toContain("hub button");
    expect(runnerHtml).toContain("wallet-signed approval is off"); // no approver configured here
    // Let this app's middleware finish its /supported sync before teardown
    // closes the mock facilitator (same settle the main app gets).
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
});

describe("facilitator policy refusals (typed against the real contracts)", () => {
  const requirements = {
    scheme: "exact",
    network: "hedera:testnet" as const,
    asset: "0.0.0",
    amount: "5000000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 180,
    extra: { feePayer: FEE_PAYER },
  };

  it("passes when policy is empty; refuses payTo and amount violations in plain words", () => {
    expect(policyViolation(requirements, policyFromEnv({}))).toBeUndefined();
    expect(
      policyViolation(requirements, policyFromEnv({ ALLOWED_PAY_TO: "0.0.1, 0.0.2" })),
    ).toMatch(/ALLOWED_PAY_TO/);
    expect(policyViolation(requirements, policyFromEnv({ MAX_AMOUNT: "1000" }))).toMatch(
      /MAX_AMOUNT/,
    );
    expect(
      policyViolation(requirements, policyFromEnv({ ALLOWED_PAY_TO: ` ${PAY_TO} ` })),
    ).toBeUndefined(); // trims
  });

  it("verify refusal speaks VerifyResponse (invalidMessage — the field that once bit us)", () => {
    expect(verifyRefusal("no")).toEqual({
      isValid: false,
      invalidReason: "policy_violation",
      invalidMessage: "no",
    });
  });

  it("settle refusal speaks SettleResponse (errorMessage, empty transaction)", () => {
    expect(settleRefusal("no", "hedera:testnet", FEE_PAYER)).toEqual({
      success: false,
      errorReason: "policy_violation",
      errorMessage: "no",
      transaction: "",
      network: "hedera:testnet",
      payer: FEE_PAYER,
    });
  });
});
