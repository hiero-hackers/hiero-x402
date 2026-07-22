// SPDX-License-Identifier: Apache-2.0
/**
 * The agent — the bounty's protagonist: no API key, no subscription, no human
 * in the loop. And this repo's thesis on top: **no blind trust either.**
 *
 * The x402 steps are spelled out (request → 402 → sign → retry → 200) rather
 * than hidden in a fetch wrapper, because the demo IS the explanation. After
 * the paid response arrives, the agent does what neither reference
 * implementation does: verifies the settlement against the public mirror
 * (src/verify.ts) and writes itself a receipt.
 *
 * This is the second of exactly two key-holding files. The key signs one
 * TransferTransaction per run, for the exact advertised amount, on testnet
 * only — the gate refuses anything else before a single byte is signed.
 */
import { writeFileSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { settlementReceiptHTML, verdictLine, verifySettlement } from "../src/index.js";
import { attest } from "./attest.js";
import { hushBenignSdkWarnings } from "./quiet.js";
import { demoNetwork, requireEnv, resolvePrivateKey } from "./shared.js";

hushBenignSdkWarnings(); // drop the SDK's expected raw-HEX-key advisory (see quiet.ts)

const NETWORK = demoNetwork();
const ACCOUNT_ID = requireEnv("AGENT_ACCOUNT_ID");
const PRIVATE_KEY = requireEnv("AGENT_PRIVATE_KEY");
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4021";
const RESOURCE = process.env.RESOURCE ?? "/data/spot-price";
const SYMBOL = process.env.SYMBOL ?? "HBAR";
const RECEIPT_PATH = process.env.RECEIPT_PATH ?? "receipt.html";

const AGENT_KEY = await resolvePrivateKey(ACCOUNT_ID, PRIVATE_KEY);
const signer = createClientHederaSigner(ACCOUNT_ID, AGENT_KEY, { network: NETWORK });
const httpClient = new x402HTTPClient(
  new x402Client().register("hedera:*", new ExactHederaScheme(signer)),
);

const url = `${SERVER_URL}${RESOURCE}?symbol=${encodeURIComponent(SYMBOL)}`;

console.log(`[agent] 1 · GET ${url}`);
const challenge = await fetch(url);
if (challenge.status !== 402) {
  console.error(`[agent] expected 402, got ${challenge.status} — is the server running?`);
  process.exit(1);
}
const paymentRequired = httpClient.getPaymentRequiredResponse(
  (name) => challenge.headers.get(name),
  await challenge
    .clone()
    .json()
    .catch(() => undefined),
);
const accepted = paymentRequired.accepts[0];
if (accepted === undefined) {
  console.error("[agent] 402 carried no payment options");
  process.exit(1);
}
console.log(
  `[agent] 2 · 402: ${accepted.amount} tinybar of ${accepted.asset} → ${accepted.payTo} ` +
    `(feePayer ${String(accepted.extra?.feePayer)} sponsors the network fee)`,
);

console.log("[agent] 3 · signing the transfer (partially — the fee payer signs last)");
const payload = await httpClient.createPaymentPayload(paymentRequired);

console.log("[agent] 4 · retrying with payment attached");
const paid = await fetch(url, { headers: httpClient.encodePaymentSignatureHeader(payload) });
const result = await httpClient.processResponse(paid);
const settle =
  result.header !== undefined && "transaction" in result.header ? result.header : undefined;
if (result.paymentStatus !== "settled" || settle === undefined) {
  console.error(
    `[agent] payment did not go through (status ${result.status}, ${result.paymentStatus})\n` +
      `[agent]   body:   ${JSON.stringify(result.body)}\n` +
      `[agent]   header: ${JSON.stringify(result.header)}`,
  );
  process.exit(1);
}
console.log(`[agent] 5 · 200 — data: ${JSON.stringify(result.body)}`);
console.log(`[agent]     settlement claims transaction ${settle.transaction}`);

console.log("[agent] 6 · VERIFYING — the mirror node, not the facilitator's word");
const verdict = await verifySettlement(
  { ...accepted },
  settle.transaction,
  `${SERVER_URL}${RESOURCE}`,
  {
    attempts: 10, // mirrors lag consensus by a few seconds — wait up to ~30s
    delayMs: 3000,
  },
);
console.log(`[agent]     ${verdictLine(verdict)}`);
if (verdict.hashscanUrl !== undefined) console.log(`[agent]     proof: ${verdict.hashscanUrl}`);
if (verdict.mirrorUrl !== undefined) console.log(`[agent]     mirror record: ${verdict.mirrorUrl}`);

// The path is the operator's own env choice, not request-derived input.

writeFileSync(RECEIPT_PATH, settlementReceiptHTML(verdict));
console.log(`[agent] 7 · receipt written to ${RECEIPT_PATH}`);

// 8 · Optional HCS attestation — the verdict onto an append-only public log.
// Failure here warns and moves on: the verdict stands on the mirror check.
const ATTEST_TOPIC_ID = process.env.ATTEST_TOPIC_ID ?? "";
if (ATTEST_TOPIC_ID !== "") {
  try {
    const result = await attest(verdict, ATTEST_TOPIC_ID, {
      accountId: ACCOUNT_ID,
      key: AGENT_KEY,
    });
    console.log(`[agent] 8 · verdict attested to HCS topic ${result.topicId}`);
    console.log(`[agent]     audit log: ${result.hashscanTopicUrl}`);
    if (ATTEST_TOPIC_ID === "create") {
      console.log(`[agent]     (set ATTEST_TOPIC_ID=${result.topicId} to keep appending here)`);
    }
  } catch (error) {
    console.warn(
      `[agent] 8 · attestation failed (verdict unaffected): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (verdict.fulfilment.status !== "paid") {
  console.error("[agent] settlement did NOT verify as paid — treat the data as unpaid-for");
  process.exit(2);
}
