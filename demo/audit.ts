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
 * The agent's recorded `verified` flag is reported but never trusted — the
 * point of carrying the signature on the log is that the auditor checks it
 * themselves. The same check runs two ways: `npm run audit` in a terminal
 * (exit 0 = every commitment re-verified; exit 1 = at least one signature
 * on the log does not hold — kept loud: a false commitment on an
 * append-only log is evidence), and `auditTopic()` behind the hub's
 * `/demo/audit`, so the dashboard can show the log re-verified live.
 *
 *   npm run audit -- 0.0.<topicId>     (or set ATTEST_TOPIC_ID in .env)
 */
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import type { Attestation, SupportedNetwork } from "../src/index.js";
import { MIRROR_HOSTS, attestationCommitmentMessage, parseAttestation } from "../src/index.js";
import { demoNetwork, fetchAccountPublicKey, verifySignatureWithKey } from "./shared.js";

/** One audited attestation — the facts, plus the auditor's own verdict. */
export interface AuditedEntry {
  readonly sequence: number;
  readonly consensusAt: string;
  readonly status: string;
  readonly transactionId: string;
  readonly amount: string;
  readonly asset: string;
  readonly reference: string;
  readonly content?: {
    readonly sha256: string;
    readonly commitment?: {
      readonly signer: string;
      /** The AUDITOR's re-verification against the on-chain key — never
       *  the agent's recorded flag (that one is `recordedVerified`). */
      readonly holds: boolean;
      readonly recordedVerified: boolean;
    };
  };
}

export interface AuditReport {
  readonly topicId: string;
  readonly network: string;
  readonly messages: number;
  readonly foreign: number;
  readonly entries: readonly AuditedEntry[];
  readonly broken: number;
  /** Honest coverage: true when the page cap cut the read short. */
  readonly truncated: boolean;
}

interface TopicMessage {
  readonly sequence_number: number;
  readonly consensus_timestamp: string;
  readonly message: string; // base64
}

/** Every message on the topic, oldest first, straight from the mirror. */
async function readTopic(
  topicId: string,
  network: SupportedNetwork,
): Promise<{ rows: TopicMessage[]; truncated: boolean }> {
  // `network` is the gate's narrowed literal union, not attacker-chosen.
  // eslint-disable-next-line security/detect-object-injection
  const host = MIRROR_HOSTS[network];
  const rows: TopicMessage[] = [];
  let path = `/api/v1/topics/${encodeURIComponent(topicId)}/messages?limit=100&order=asc`;
  // A page cap so a runaway topic cannot spin this loop forever; the report
  // says so honestly rather than pretending the audit was complete.
  for (let page = 0; page < 50; page += 1) {
    const response = await fetch(`${host}${path}`);
    if (response.status === 404) throw new Error(`topic ${topicId} is unknown to the mirror`);
    if (!response.ok) throw new Error(`mirror answered ${String(response.status)}`);
    const body = (await response.json()) as {
      messages?: TopicMessage[];
      links?: { next?: string | null };
    };
    rows.push(...(body.messages ?? []));
    const next = body.links?.next;
    if (next === undefined || next === null) return { rows, truncated: false };
    path = next;
  }
  return { rows, truncated: true };
}

/** Audit a topic: read, parse, and RE-VERIFY every commitment found.
 *  `network` is a parameter (defaulting to the env gate) so the env-free
 *  app factory can pass its own — env reads stay in the entry points. */
export async function auditTopic(
  topicId: string,
  network: SupportedNetwork = demoNetwork(),
): Promise<AuditReport> {
  const { rows, truncated } = await readTopic(topicId, network);
  const entries: AuditedEntry[] = [];
  // One mirror KEY lookup per signer, not per message — the memo holds the
  // resolved key (as a promise, so concurrent messages share one fetch);
  // verification itself is then local per message.
  const signerKeys = new Map<string, Promise<string | undefined>>();
  const signerKey = (signer: string): Promise<string | undefined> => {
    const cached = signerKeys.get(signer) ?? fetchAccountPublicKey(signer);
    signerKeys.set(signer, cached);
    return cached;
  };
  let foreign = 0;
  let broken = 0;
  for (const row of rows) {
    const attestation: Attestation | undefined = parseAttestation(
      Buffer.from(row.message, "base64").toString("utf8"),
    );
    if (attestation === undefined) {
      foreign += 1;
      continue;
    }
    let content: AuditedEntry["content"];
    if (attestation.content !== undefined) {
      const { commitment } = attestation.content;
      if (commitment === undefined) {
        content = { sha256: attestation.content.sha256 };
      } else {
        const message = attestationCommitmentMessage(attestation)!;
        const keyText = await signerKey(commitment.signer);
        const holds =
          keyText !== undefined &&
          verifySignatureWithKey(keyText, Buffer.from(message, "utf8"), commitment.signature);
        if (!holds) broken += 1;
        content = {
          sha256: attestation.content.sha256,
          commitment: { signer: commitment.signer, holds, recordedVerified: commitment.verified },
        };
      }
    }
    entries.push({
      sequence: row.sequence_number,
      consensusAt: row.consensus_timestamp,
      status: attestation.status,
      transactionId: attestation.transactionId,
      amount: attestation.amount,
      asset: attestation.asset,
      reference: attestation.reference,
      ...(content !== undefined ? { content } : {}),
    });
  }
  return {
    topicId,
    network,
    messages: rows.length,
    foreign,
    entries,
    broken,
    truncated,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
// `npm run audit [-- 0.0.topic]` — same auditTopic(), spoken aloud.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const TOPIC_ID = process.argv[2] ?? process.env.ATTEST_TOPIC_ID ?? "";
  if (TOPIC_ID === "" || TOPIC_ID === "create") {
    console.error("[audit] no topic to read — pass a topic id or set ATTEST_TOPIC_ID in .env");
    process.exit(1);
  }
  let report: AuditReport;
  try {
    report = await auditTopic(TOPIC_ID);
  } catch (error) {
    console.error(`[audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(
    `[audit] topic ${report.topicId} on ${report.network} — ${String(report.messages)} message(s)`,
  );
  if (report.truncated) console.warn("[audit] page cap reached — first 5000 messages only");
  for (const entry of report.entries) {
    console.log(
      `[audit] #${String(entry.sequence)} ${entry.status.toUpperCase()} ${entry.transactionId} — ` +
        `${entry.amount} of ${entry.asset} for ${entry.reference}`,
    );
    if (entry.content === undefined) continue;
    const { commitment } = entry.content;
    if (commitment === undefined) {
      console.log(`[audit]     content sha-256 ${entry.content.sha256} — agent record only`);
      continue;
    }
    console.log(
      `[audit]     content sha-256 ${entry.content.sha256}\n` +
        `[audit]     commitment by ${commitment.signer}: signature ${
          commitment.holds ? "✓ holds (re-verified against the on-chain key)" : "✗ DOES NOT HOLD"
        }${
          commitment.holds === commitment.recordedVerified
            ? ""
            : ` — agent had recorded ${String(commitment.recordedVerified)}`
        }`,
    );
  }
  const committed = report.entries.filter((e) => e.content?.commitment !== undefined).length;
  console.log(
    `[audit] ${String(report.entries.length)} attestation(s) (${String(report.foreign)} foreign ` +
      `message(s) skipped) · ${String(committed)} committed · ` +
      `${String(committed - report.broken)} hold · ${String(report.broken)} broken`,
  );
  if (report.broken > 0) {
    console.error("[audit] at least one commitment on the log does NOT verify — keep the evidence");
    process.exit(1);
  }
}
