// SPDX-License-Identifier: Apache-2.0
/**
 * The agent — the bounty's protagonist: no API key, no subscription, no human
 * in the loop. And this repo's thesis on top: **no blind trust either.**
 *
 * One opt-in twist for demos: `HUMAN_APPROVAL=1` pauses at step 2½ — terms
 * known, nothing signed — until a human answers on stdin (y/N in a terminal,
 * or the hub's Approve button, which the server relays to this child's
 * stdin). The agent still drives every step; the human only approves the
 * money leaving. Declining exits before a single byte is signed.
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
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { formatBaseUnits } from "@hiero-hackers/hiero-payment-requests";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import {
  CONTENT_SHA256_HEADER,
  CONTENT_SIGNATURE_HEADER,
  CONTENT_SIGNER_HEADER,
  HBAR_ASSET,
  commitmentReference,
  contentCommitmentMessage,
  settlementReceiptHTML,
  sha256Hex,
  verdictLine,
  verifySettlement,
} from "../src/index.js";
import type { DeliveredContent } from "../src/index.js";
import { attest } from "./attest.js";
import { hushBenignSdkWarnings } from "./quiet.js";
import { demoNetwork, requireEnv, resolvePrivateKey, verifyAccountSignature } from "./shared.js";

hushBenignSdkWarnings(); // drop the SDK's expected raw-HEX-key advisory (see quiet.ts)

const NETWORK = demoNetwork();
const ACCOUNT_ID = requireEnv("AGENT_ACCOUNT_ID");
const PRIVATE_KEY = requireEnv("AGENT_PRIVATE_KEY");
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4021";
const RESOURCE = process.env.RESOURCE ?? "/data/spot-price";
const SYMBOL = process.env.SYMBOL ?? "HBAR";
const RECEIPT_PATH = process.env.RECEIPT_PATH ?? "receipt.html";

const AGENT_KEY = await resolvePrivateKey(ACCOUNT_ID, PRIVATE_KEY);
let humanConsent: { accountId: string; terms: string; signature: string } | undefined;
const signer = createClientHederaSigner(ACCOUNT_ID, AGENT_KEY, { network: NETWORK });
const httpClient = new x402HTTPClient(
  new x402Client().register("hedera:*", new ExactHederaScheme(signer)),
);

/** "0.05000000 ℏ (5,000,000 tinybar)" — amounts a human can read at a
 *  glance. The wire stays atomic; only the narration converts, and the
 *  decimal split comes from the library, not hand-rolled bigint math. */
function fmtAmount(amount: bigint, asset: string): string {
  if (asset !== HBAR_ASSET) {
    return `${amount.toLocaleString("en-US")} base units of token ${asset}`;
  }
  return `${formatBaseUnits(amount, 8)} ℏ (${amount.toLocaleString("en-US")} tinybar)`;
}

const url = `${SERVER_URL}${RESOURCE}?symbol=${encodeURIComponent(SYMBOL)}`;

console.log(`[agent] 1 · GET ${url}`);
const challenge = await fetch(url);
if (challenge.status !== 402) {
  console.error(`[agent] expected 402, got ${challenge.status} — is the server running?`);
  process.exit(1);
}
const paymentRequired = httpClient.getPaymentRequiredResponse(
  (name) => challenge.headers.get(name),
  await challenge.json().catch(() => undefined),
);
const accepted = paymentRequired.accepts[0];
if (accepted === undefined) {
  console.error("[agent] 402 carried no payment options");
  process.exit(1);
}
console.log(
  `[agent] 2 · 402: price ${fmtAmount(BigInt(accepted.amount), accepted.asset)} → ${accepted.payTo} ` +
    `(feePayer ${String(accepted.extra?.feePayer)} sponsors the network fee — ` +
    `the agent pays the price, never the fee)`,
);

if (process.env.HUMAN_APPROVAL === "1") {
  console.log(
    `[agent] 2½ · AWAITING HUMAN APPROVAL — pay ${fmtAmount(BigInt(accepted.amount), accepted.asset)} ` +
      `to ${accepted.payTo} for ${RESOURCE}? (y/N)`,
  );
  const gate = await new Promise<{ approved: boolean; consent?: string }>((resolve) => {
    const prompt = createInterface({ input: process.stdin });
    prompt.once("line", (line) => {
      // Resolve BEFORE close(): close() emits "close" synchronously, and the
      // EOF fallback below would otherwise win the race and read as decline.
      // Wire shape: "y" / "yes" approves; "y <base64>" carries the
      // hub-verified consent along.
      const answer = line.trim();
      const space = answer.indexOf(" ");
      const word = space === -1 ? answer : answer.slice(0, space);
      const extra = space === -1 ? "" : answer.slice(space + 1).trim();
      resolve(
        /^y(es)?$/i.test(word)
          ? extra !== ""
            ? { approved: true, consent: extra }
            : { approved: true }
          : { approved: false },
      );
      prompt.close();
    });
    prompt.once("close", () => resolve({ approved: false })); // stdin EOF with no answer
  });
  // The gate is answered — release stdin, or its open pipe keeps the event
  // loop (and therefore this process, the SSE stream, and the hub's run
  // lock) alive after step 7.
  process.stdin.destroy();
  if (!gate.approved) {
    console.log("[agent] 2½ · declined by human — nothing signed, nothing spent");
    process.exit(3);
  }
  // Wallet-signed consent (base64 JSON) rides in after the "y" — the hub
  // verified the signature against the approver's on-chain key; keep it for
  // the audit trail.
  if (gate.consent !== undefined) {
    try {
      humanConsent = JSON.parse(Buffer.from(gate.consent, "base64").toString("utf8")) as {
        accountId: string;
        terms: string;
        signature: string;
      };
      console.log(
        `[agent] 2½ · approved by human — consent signed by ${humanConsent.accountId}, hub-verified`,
      );
    } catch {
      console.log(
        "[agent] 2½ · approved by human (consent blob unreadable — proceeding without it)",
      );
    }
  } else {
    console.log("[agent] 2½ · approved by human — the agent takes it from here");
  }
}

console.log("[agent] 3 · signing the transfer (partially — the fee payer signs last)");
const payload = await httpClient.createPaymentPayload(paymentRequired);

console.log("[agent] 4 · retrying with payment attached");
const paid = await fetch(url, { headers: httpClient.encodePaymentSignatureHeader(payload) });
// Hash the EXACT bytes received, before any parsing — the content
// commitment (if the server sent one) is over these bytes, nothing else.
const receivedBytes = Buffer.from(await paid.clone().arrayBuffer());
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
// Say the money out loud: what the terms quoted, what the chain settled,
// and who paid the network fee — the numbers, not just the word "paid".
if ("received" in verdict.fulfilment) {
  const quoted = verdict.request.amount;
  const settled = verdict.fulfilment.received;
  const delta =
    settled === quoted
      ? "exact"
      : settled > quoted
        ? `${(settled - quoted).toLocaleString("en-US")} over`
        : `${(quoted - settled).toLocaleString("en-US")} short`;
  console.log(
    `[agent]     charged: quoted ${fmtAmount(quoted, accepted.asset)} → settled ` +
      `${fmtAmount(settled, accepted.asset)} — ${delta}; network fee paid by the sponsor, not the agent`,
  );
}
if (verdict.hashscanUrl !== undefined) console.log(`[agent]     hashscan: ${verdict.hashscanUrl}`);
if (verdict.mirrorUrl !== undefined) console.log(`[agent]     mirror record: ${verdict.mirrorUrl}`);

// 6½ · The CONTENT side of the trade. The settlement verdict above proves
// the money moved; this checks whether the server COMMITTED to what it
// served in return (x-content-* headers, signed against this settlement).
// The signature is verified over the bytes WE received, against the
// signer's on-chain key from the mirror — never against the header's own
// claims. No commitment is honest and allowed; a broken one is loud.
const contentSha = sha256Hex(receivedBytes);
const commitSha = paid.headers.get(CONTENT_SHA256_HEADER);
const commitSigner = paid.headers.get(CONTENT_SIGNER_HEADER);
const commitSignature = paid.headers.get(CONTENT_SIGNATURE_HEADER);
// The signed reference — derived by the SAME convention function the
// server middleware uses (src/content.ts commitmentReference), so the two
// parties can never disagree about which form was signed.
const signedReference = commitmentReference(url);
let content: DeliveredContent = { sha256: contentSha, reference: signedReference };
if (commitSha !== null && commitSigner !== null && commitSignature !== null) {
  const committed =
    commitSha === contentSha &&
    (await verifyAccountSignature(
      commitSigner,
      contentCommitmentMessage({
        // The canonical REST-normalized id — the same form the server
        // signed, the verdict carries, and the topic attestation records.
        transactionId: verdict.transactionId,
        reference: signedReference,
        sha256: contentSha,
      }),
      commitSignature,
    ));
  content = {
    sha256: contentSha,
    reference: signedReference,
    commitment: { signer: commitSigner, signatureB64: commitSignature, verified: committed },
  };
  console.log(
    committed
      ? `[agent] 6½ · content COMMITTED — ${commitSigner} signed sha-256 ${contentSha.slice(0, 16)}… against this settlement (key mirror-checked)`
      : `[agent] 6½ · content commitment BROKEN — presented by ${commitSigner} but it does not verify; treating the data as unattested`,
  );
} else {
  console.log(
    `[agent] 6½ · no content commitment offered — recording sha-256 ${contentSha.slice(0, 16)}… as the agent's own note`,
  );
}

// The path is the operator's own env choice, not request-derived input.

writeFileSync(RECEIPT_PATH, settlementReceiptHTML(verdict, { content }));
console.log(`[agent] 7 · receipt written to ${RECEIPT_PATH}`);

// 8 · Optional HCS attestation — the verdict onto an append-only public log.
// Failure here warns and moves on: the verdict stands on the mirror check.
const ATTEST_TOPIC_ID = process.env.ATTEST_TOPIC_ID ?? "";
if (ATTEST_TOPIC_ID !== "") {
  try {
    const result = await attest(
      verdict,
      ATTEST_TOPIC_ID,
      { accountId: ACCOUNT_ID, key: AGENT_KEY },
      humanConsent,
      content, // the (transaction → content hash) binding, public and timestamped
    );
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
