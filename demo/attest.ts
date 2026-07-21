// SPDX-License-Identifier: Apache-2.0
/**
 * HCS attestation — the agent's audit trail, on the ledger itself.
 *
 * Opt-in (`ATTEST_TOPIC_ID` in .env): after the agent verifies a settlement,
 * it writes a compact attestation of the VERDICT to a Hedera Consensus
 * Service topic — who was paid, how much, which transaction, what the
 * mirror said. The topic becomes an append-only, independently readable log
 * of every payment this agent made and checked: an auditor needs the topic
 * id, not the agent's cooperation.
 *
 * The reference x402 implementation lists "HCS attestation" as deferred —
 * this is that feature. Deliberately small: one message per verdict, paid
 * for by the agent (it is the agent's own audit trail), and a failed
 * attestation WARNS but never fails the run — the payment verdict stands on
 * the mirror check, not on this log entry.
 *
 * `ATTEST_TOPIC_ID=create` creates a fresh topic once and prints its id —
 * put the id in .env to keep appending to the same log.
 */
import { Client, TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { PrivateKey } from "@x402/hedera";
import type { SettlementVerdict } from "../src/index.js";
import { HASHSCAN_HOSTS, attestationMessage } from "../src/index.js";
import { demoNetwork } from "./shared.js";

export interface AttestationResult {
  readonly topicId: string;
  readonly hashscanTopicUrl: string;
}

/**
 * Write the verdict to the topic (creating one first when `topicIdOrCreate`
 * is the literal `"create"`). Throws on failure — the CALLER decides that an
 * attestation failure is non-fatal, and says so out loud.
 */
export async function attest(
  verdict: SettlementVerdict,
  topicIdOrCreate: string,
  operator: { accountId: string; key: InstanceType<typeof PrivateKey> },
): Promise<AttestationResult> {
  const network = demoNetwork(); // the gate applies here too
  const bare = network.slice(network.indexOf(":") + 1);
  const client = Client.forName(bare);
  client.setOperator(operator.accountId, operator.key);
  try {
    let topicId = topicIdOrCreate;
    if (topicId === "create") {
      const created = await (
        await new TopicCreateTransaction()
          .setTopicMemo("hiero-x402 settlement attestations")
          .execute(client)
      ).getReceipt(client);
      topicId = created.topicId!.toString();
    }
    await (
      await new TopicMessageSubmitTransaction()
        .setTopicId(topicId)
        .setMessage(attestationMessage(verdict))
        .execute(client)
    ).getReceipt(client);
    return {
      topicId,
      // `network` is the gate's narrowed literal union, not attacker-chosen.
      // eslint-disable-next-line security/detect-object-injection
      hashscanTopicUrl: `${HASHSCAN_HOSTS[network]}/topic/${topicId}`,
    };
  } finally {
    client.close();
  }
}
