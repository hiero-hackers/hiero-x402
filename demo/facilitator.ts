// SPDX-License-Identifier: Apache-2.0
/**
 * Self-hosted x402 facilitator for Hedera testnet — a thin HTTP wrapper
 * around the OFFICIAL engine (`@x402/core/facilitator` +
 * `@x402/hedera/exact/facilitator`), the same construction as the
 * scaffold-hbar reference (research/_raw-scaffold/facilitator-server.ts).
 * The security-critical transaction inspection is deliberately the official
 * package's, not ours: this process co-signs as fee payer, so the MUST-rules
 * of research/02 are enforced by the code that specified them.
 *
 *   GET  /supported  advertised kinds + the fee payer this process sponsors
 *   POST /verify     validate a signed payment payload against requirements
 *   POST /settle     co-sign as fee payer, submit, await SUCCESS
 *
 * This is one of exactly two key-holding files in the repo (the other is
 * agent.ts) — and the testnet gate refuses to start it anywhere else.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  createHederaClient,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  toFacilitatorHederaSigner,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/facilitator";
import { policyFromEnv, policyViolation, settleRefusal, verifyRefusal } from "./policy.js";
import { FACILITATOR_PORT, demoNetwork, requireEnv, resolvePrivateKey } from "./shared.js";

const NETWORK = demoNetwork(); // refuses anything but the pinned testnet
const FEE_PAYER_ID = requireEnv("FACILITATOR_ACCOUNT_ID");
const FEE_PAYER_KEY = await resolvePrivateKey(FEE_PAYER_ID, requireEnv("FACILITATOR_PRIVATE_KEY"));

// ── Policy, on top of the engine's checks — pure + typed in policy.ts
// (the spec's "stricter limits" clause; refusal shapes are the real
// contract types, so field drift is a compile error).
const POLICY = policyFromEnv(process.env);

function buildClient(network: string) {
  const client = createHederaClient(network);
  client.setOperator(FEE_PAYER_ID, FEE_PAYER_KEY);
  return client;
}

const signer = toFacilitatorHederaSigner({
  getAddresses: () => [FEE_PAYER_ID],
  signAndSubmitTransaction: createHederaSignAndSubmitTransaction(buildClient, FEE_PAYER_KEY),
  // Both default to the network's public Mirror Node: balance/association
  // preflight, and the mandatory did-the-payer-actually-sign check.
  preflightTransfer: createHederaPreflightTransfer(),
  verifyPayerSignature: createHederaVerifyPayerSignature(),
});

// aliasPolicy "reject": payTo must be a concrete 0.0.x — an EVM/key alias
// would have this fee payer fund auto-account-creation (research/02).
const facilitator = new x402Facilitator().register(
  NETWORK,
  new ExactHederaScheme(signer, { aliasPolicy: "reject" }),
);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<{
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        return sendJson(res, 200, { status: "ok", network: NETWORK, feePayer: FEE_PAYER_ID });
      }
      if (req.method === "GET" && path === "/supported") {
        return sendJson(res, 200, facilitator.getSupported());
      }
      if (req.method === "POST" && path === "/verify") {
        const { paymentPayload, paymentRequirements } = await readJson(req);
        const violation = policyViolation(paymentRequirements, POLICY);
        if (violation !== undefined) {
          console.warn(`[facilitator] policy refusal on /verify: ${violation}`);
          return sendJson(res, 200, verifyRefusal(violation));
        }
        return sendJson(res, 200, await facilitator.verify(paymentPayload, paymentRequirements));
      }
      if (req.method === "POST" && path === "/settle") {
        const { paymentPayload, paymentRequirements } = await readJson(req);
        const violation = policyViolation(paymentRequirements, POLICY);
        if (violation !== undefined) {
          console.warn(`[facilitator] policy refusal on /settle: ${violation}`);
          return sendJson(res, 200, settleRefusal(violation, NETWORK, FEE_PAYER_ID));
        }
        return sendJson(res, 200, await facilitator.settle(paymentPayload, paymentRequirements));
      }
      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[facilitator] ${req.method} ${path} failed: ${message}`);
      return sendJson(res, 500, { error: "facilitator_error", message });
    }
  })();
});

server.listen(FACILITATOR_PORT, () => {
  console.log(`[facilitator] listening on :${FACILITATOR_PORT}`);
  console.log(`[facilitator] network=${NETWORK} feePayer=${FEE_PAYER_ID} aliasPolicy=reject`);
  if (POLICY.allowedPayTo.length > 0)
    console.log(`[facilitator] policy: payTo ∈ {${POLICY.allowedPayTo.join(", ")}}`);
  if (POLICY.maxAmount !== "")
    console.log(`[facilitator] policy: amount ≤ ${POLICY.maxAmount} atomic units`);
});
