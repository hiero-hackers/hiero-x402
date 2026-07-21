// SPDX-License-Identifier: Apache-2.0
/**
 * Fixtures: canned mirror REST bodies for every verdict the verifier must
 * reach, and a fetch stub so the whole suite runs offline. Shapes mimic real
 * testnet responses (snake_case, tinybar numbers, base64 memos).
 */
import { toPaymentRequirements } from "../src/index.js";

export const PAY_TO = "0.0.4507290";
export const PAYER = "0.0.4507291";
export const FEE_PAYER = "0.0.7000001";
export const NODE = "0.0.3";

/** The settlement id as an x402 SettleResponse would carry it (SDK form). */
export const SETTLEMENT_ID = `${FEE_PAYER}@1753099999.123456789`;
export const SETTLEMENT_ID_REST = `${FEE_PAYER}-1753099999-123456789`;
export const CONSENSUS_AT = "1753100000.000000001";

export const HBAR_REQUEST = {
  recipient: `hedera:testnet:${PAY_TO}`,
  asset: "hedera:testnet/slip44:3030",
  amount: 5_000_000n,
  reference: "https://api.example.test/data/spot-price",
} as const;

export const REQUIREMENTS = toPaymentRequirements(HBAR_REQUEST, { feePayer: FEE_PAYER });

interface RestRow {
  transaction_id: string;
  name: string;
  result: string;
  consensus_timestamp: string;
  charged_tx_fee: number;
  memo_base64?: string | null;
  transfers?: { account: string; amount: number }[];
  token_transfers?: { token_id: string; account: string; amount: number }[];
}

/** A SUCCESS CRYPTOTRANSFER row crediting `credited` tinybar to PAY_TO. */
export function hbarRow(credited: number, overrides: Partial<RestRow> = {}): RestRow {
  return {
    transaction_id: SETTLEMENT_ID_REST,
    name: "CRYPTOTRANSFER",
    result: "SUCCESS",
    consensus_timestamp: CONSENSUS_AT,
    charged_tx_fee: 76916,
    memo_base64: null,
    transfers: [
      { account: PAYER, amount: -credited },
      { account: PAY_TO, amount: credited },
      { account: FEE_PAYER, amount: -76916 },
      { account: NODE, amount: 76916 },
    ],
    ...overrides,
  };
}

/** A row that credits a token instead of the asked-for HBAR. */
export function tokenRow(credited: number): RestRow {
  return hbarRow(0, {
    transfers: [
      { account: FEE_PAYER, amount: -76916 },
      { account: NODE, amount: 76916 },
    ],
    token_transfers: [
      { token_id: "0.0.5449", account: PAYER, amount: -credited },
      { token_id: "0.0.5449", account: PAY_TO, amount: credited },
    ],
  });
}

/** A fetch stub serving one canned body (or a 404/500) for any URL. */
export function fetchStub(
  rows: RestRow[] | undefined,
  status = 200,
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((url: string | URL) => {
    calls.push(String(url));
    if (rows === undefined) {
      return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ transactions: rows }),
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
