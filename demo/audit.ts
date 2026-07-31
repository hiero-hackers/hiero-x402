// SPDX-License-Identifier: Apache-2.0
/**
 * The independent auditor — proof that the attestation topic needs nobody's
 * cooperation to be believed. Give it a topic id and it will:
 *
 *   1 · read every message straight from the PUBLIC mirror (no agent,
 *       no server, no facilitator involved),
 *   2 · parse the x402-settlement-verdict attestations (foreign messages
 *       are data, not errors — topics are public),
 *   3 · for every content commitment found, rebuild the exact signed
 *       message from the attestation's own fields and RE-VERIFY the
 *       server's signature against the signer's on-chain key.
 *
 * The agent's recorded `verified` flag is printed but never trusted — the
 * point of carrying the signature on the log is that the auditor checks it
 * themselves. Exit 0 = every commitment re-verified; exit 1 = at least one
 * signature on the log does not hold (kept loud: a false commitment on an
 * append-only log is evidence).
 *
 *   npm run audit -- 0.0.<topicId>     (or set ATTEST_TOPIC_ID in .env)
 */
import { Buffer } from "node:buffer";
import type { Attestation } from "../src/index.js";
import { MIRROR_HOSTS, attestationCommitmentMessage, parseAttestation } from "../src/index.js";
import { demoNetwork, verifyAccountSignature } from "./shared.js";

const NETWORK = demoNetwork(); // the network gate applies to auditors too
const TOPIC_ID = process.argv[2] ?? process.env.ATTEST_TOPIC_ID ?? "";
if (TOPIC_ID === "" || TOPIC_ID === "create") {
  console.error("[audit] no topic to read — pass a topic id or set ATTEST_TOPIC_ID in .env");
  process.exit(1);
}

interface TopicMessage {
  readonly sequence_number: number;
  readonly consensus_timestamp: string;
  readonly message: string; // base64
}

/** Every message on the topic, oldest first, straight from the mirror. */
async function readTopic(topicId: string): Promise<TopicMessage[]> {
  const host = MIRROR_HOSTS[NETWORK];
  const messages: TopicMessage[] = [];
  let path = `/api/v1/topics/${encodeURIComponent(topicId)}/messages?limit=100&order=asc`;
  // A page cap so a runaway topic cannot spin this loop forever; say so
  // honestly if it bites rather than pretending the audit was complete.
  for (let page = 0; page < 50; page += 1) {
    const response = await fetch(`${host}${path}`);
    if (response.status === 404) {
      console.error(`[audit] topic ${topicId} is unknown to the ${NETWORK} mirror`);
      process.exit(1);
    }
    if (!response.ok) {
      console.error(`[audit] mirror answered ${String(response.status)} — try again later`);
      process.exit(1);
    }
    const body = (await response.json()) as {
      messages?: TopicMessage[];
      links?: { next?: string | null };
    };
    messages.push(...(body.messages ?? []));
    const next = body.links?.next;
    if (next === undefined || next === null) return messages;
    path = next;
  }
  console.warn("[audit] page cap reached — auditing the first 5000 messages only");
  return messages;
}

const rows = await readTopic(TOPIC_ID);
console.log(`[audit] topic ${TOPIC_ID} on ${NETWORK} — ${String(rows.length)} message(s)`);

let attestations = 0;
let foreign = 0;
let withContent = 0;
let committed = 0;
let holds = 0;
let broken = 0;

for (const row of rows) {
  const attestation: Attestation | undefined = parseAttestation(
    Buffer.from(row.message, "base64").toString("utf8"),
  );
  if (attestation === undefined) {
    foreign += 1;
    continue;
  }
  attestations += 1;
  const head =
    `[audit] #${String(row.sequence_number)} ${attestation.status.toUpperCase()} ` +
    `${attestation.transactionId} — ${attestation.amount} of ${attestation.asset} ` +
    `for ${attestation.reference}`;
  if (attestation.content === undefined) {
    console.log(`${head} (no content block)`);
    continue;
  }
  withContent += 1;
  const { commitment } = attestation.content;
  if (commitment === undefined) {
    console.log(
      `${head}\n[audit]     content sha-256 ${attestation.content.sha256} — agent record only`,
    );
    continue;
  }
  committed += 1;
  // The auditor's own verification — the recorded flag is shown, not used.
  const message = attestationCommitmentMessage(attestation)!;
  const verified = await verifyAccountSignature(commitment.signer, message, commitment.signature);
  if (verified) holds += 1;
  else broken += 1;
  console.log(head);
  console.log(
    `[audit]     content sha-256 ${attestation.content.sha256}\n` +
      `[audit]     commitment by ${commitment.signer}: signature ${verified ? "✓ holds (re-verified against the on-chain key)" : "✗ DOES NOT HOLD"}` +
      `${verified === commitment.verified ? "" : ` — agent had recorded ${String(commitment.verified)}`}`,
  );
}

console.log(
  `[audit] ${String(attestations)} attestation(s) (${String(foreign)} foreign message(s) skipped) · ` +
    `${String(withContent)} with content · ${String(committed)} committed · ` +
    `${String(holds)} hold · ${String(broken)} broken`,
);
if (broken > 0) {
  console.error("[audit] at least one commitment on the log does NOT verify — keep the evidence");
  process.exit(1);
}
