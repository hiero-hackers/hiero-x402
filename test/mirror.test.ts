// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { restTransactionId, toTransactionInfo, transactionsById } from "../src/index.js";
import { SETTLEMENT_ID, SETTLEMENT_ID_REST, fetchStub, hbarRow } from "./helpers.js";

describe("restTransactionId", () => {
  it("converts the SDK form a SettleResponse carries", () => {
    expect(restTransactionId(SETTLEMENT_ID)).toBe(SETTLEMENT_ID_REST);
  });

  it("passes the REST form through", () => {
    expect(restTransactionId(SETTLEMENT_ID_REST)).toBe(SETTLEMENT_ID_REST);
  });

  it("refuses anything else, loudly", () => {
    for (const bad of ["", "0.0.1", "0xabc", "0.0.1@1.2.3", "hedera:testnet:0.0.1"]) {
      expect(() => restTransactionId(bad)).toThrow(/transaction id/);
    }
  });
});

describe("toTransactionInfo", () => {
  it("maps snake_case rows and decodes the memo", () => {
    const mapped = toTransactionInfo({ ...hbarRow(5_000_000), memo_base64: "aGVsbG8=" });
    expect(mapped.transactionId).toBe(SETTLEMENT_ID_REST);
    expect(mapped.memo).toBe("hello");
    expect(mapped.transfers.find((t) => t.amount === 5_000_000)).toBeDefined();
  });

  it("treats an undecodable memo as absent", () => {
    expect(toTransactionInfo({ ...hbarRow(1), memo_base64: "%%%" }).memo).toBeUndefined();
  });

  it("maps the transfer lists a settlement can carry beyond plain HBAR", () => {
    const mapped = toTransactionInfo({
      ...hbarRow(1),
      token_transfers: [{ token_id: "0.0.5449", account: "0.0.1", amount: 5 }],
      nft_transfers: [
        {
          token_id: "0.0.9",
          serial_number: 7,
          sender_account_id: null,
          receiver_account_id: "0.0.2",
        },
        {
          token_id: "0.0.9",
          serial_number: 8,
          sender_account_id: "0.0.3",
          receiver_account_id: "0.0.2",
        },
      ],
      staking_reward_transfers: [{ account: "0.0.1", amount: 3 }],
    });
    expect(mapped.tokenTransfers[0]).toEqual({
      tokenId: "0.0.5449",
      accountId: "0.0.1",
      amount: 5,
    });
    expect(mapped.nftTransfers?.[0]).toEqual({
      tokenId: "0.0.9",
      serialNumber: 7,
      senderAccountId: "",
      receiverAccountId: "0.0.2",
    });
    expect(mapped.nftTransfers?.[1]?.senderAccountId).toBe("0.0.3");
    expect(mapped.stakingRewardTransfers?.[0]).toEqual({ accountId: "0.0.1", amount: 3 });
  });
});

describe("transactionsById", () => {
  it("hits the by-id endpoint on the network's own mirror", async () => {
    const { fetchImpl, calls } = fetchStub([hbarRow(5_000_000)]);
    const rows = await transactionsById("hedera:testnet", SETTLEMENT_ID, fetchImpl);
    expect(rows).toHaveLength(1);
    expect(calls[0]).toBe(
      `https://testnet.mirrornode.hedera.com/api/v1/transactions/${SETTLEMENT_ID_REST}`,
    );
  });

  it("returns [] on 404 — not-found is a verdict input, not an error", async () => {
    const { fetchImpl } = fetchStub(undefined, 404);
    expect(await transactionsById("hedera:testnet", SETTLEMENT_ID, fetchImpl)).toEqual([]);
  });

  it("throws on other mirror errors", async () => {
    const { fetchImpl } = fetchStub(undefined, 500);
    await expect(transactionsById("hedera:testnet", SETTLEMENT_ID, fetchImpl)).rejects.toThrow(
      /500/,
    );
  });

  it("refuses non-gated networks before any request is made", async () => {
    const { fetchImpl, calls } = fetchStub([]);
    await expect(transactionsById("hedera:mainnet", SETTLEMENT_ID, fetchImpl)).rejects.toThrow(
      /enforced in code/,
    );
    expect(calls).toHaveLength(0);
  });

  it("tolerates rows with no transfer lists and bodies with no rows at all", async () => {
    const bare = toTransactionInfo({
      transaction_id: SETTLEMENT_ID_REST,
      name: "CRYPTOTRANSFER",
      result: "SUCCESS",
      consensus_timestamp: "1.2",
      charged_tx_fee: 1,
    });
    expect(bare.transfers).toEqual([]);
    expect(bare.tokenTransfers).toEqual([]);

    const emptyBody = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })) as unknown as typeof fetch;
    expect(await transactionsById("hedera:testnet", SETTLEMENT_ID, emptyBody)).toEqual([]);
  });

  it("defaults to global fetch when none is injected", async () => {
    const { fetchImpl, calls } = fetchStub([hbarRow(1)]);
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const rows = await transactionsById("hedera:testnet", SETTLEMENT_ID);
      expect(rows).toHaveLength(1);
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
