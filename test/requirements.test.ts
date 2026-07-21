// SPDX-License-Identifier: Apache-2.0
/**
 * The bridge, proven three ways:
 *   1. hand-built cases for each asset kind and each refusal;
 *   2. the official wire vectors — every valid vector that x402 can express
 *      must round-trip `PaymentRequest → PaymentRequirements → PaymentRequest`
 *      without losing what `match` needs;
 *   3. the config gate, because the demo's safety rests on it.
 */
import { describe, expect, it } from "vitest";
import { fromURI } from "@hiero-hackers/hiero-payment-requests";
import vectors from "@hiero-hackers/hiero-payment-requests/vectors/wire.v1.json" with { type: "json" };
import {
  DEFAULT_MAX_TIMEOUT_SECONDS,
  HBAR_ASSET,
  assertSupportedNetwork,
  fromPaymentRequirements,
  isSupportedNetwork,
  toPaymentRequirements,
} from "../src/index.js";

const FEE_PAYER = "0.0.7000001";

const hbarRequest = {
  recipient: "hedera:testnet:0.0.4507290",
  asset: "hedera:testnet/slip44:3030",
  amount: 5_000_000n, // 0.05 ℏ in tinybars
  reference: "demo/spot-price",
} as const;

const tokenRequest = {
  recipient: "hedera:testnet:0.0.4507290",
  asset: "hedera:testnet/token:0.0.5449",
  amount: 250n,
  reference: "demo/quote",
} as const;

describe("toPaymentRequirements", () => {
  it("maps an HBAR request onto the official scheme's conventions", () => {
    const requirements = toPaymentRequirements(hbarRequest, { feePayer: FEE_PAYER });
    expect(requirements).toEqual({
      scheme: "exact",
      network: "hedera:testnet",
      asset: HBAR_ASSET,
      amount: "5000000",
      payTo: "0.0.4507290",
      maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
      extra: { feePayer: FEE_PAYER },
    });
  });

  it("maps a token request to its bare token id", () => {
    const requirements = toPaymentRequirements(tokenRequest, { feePayer: FEE_PAYER });
    expect(requirements.asset).toBe("0.0.5449");
    expect(requirements.amount).toBe("250");
  });

  it("honours a custom timeout", () => {
    const requirements = toPaymentRequirements(hbarRequest, {
      feePayer: FEE_PAYER,
      maxTimeoutSeconds: 60,
    });
    expect(requirements.maxTimeoutSeconds).toBe(60);
  });

  it("refuses an NFT request — exact prices by fungible amount", () => {
    const nft = {
      recipient: "hedera:testnet:0.0.4507290",
      asset: "hedera:testnet/nft:0.0.5449/7",
      amount: 1n,
      reference: "demo/nft",
    };
    expect(() => toPaymentRequirements(nft, { feePayer: FEE_PAYER })).toThrow(/NFT/);
  });

  it("refuses a fee payer that is not a bare account id", () => {
    for (const bad of ["", "0.0.7000001-vfmkw", "0x1234", "alias"]) {
      expect(() => toPaymentRequirements(hbarRequest, { feePayer: bad })).toThrow(/feePayer/);
    }
  });

  it("refuses an invalid request before it reaches any facilitator", () => {
    const badChecksum = { ...hbarRequest, recipient: "hedera:testnet:0.0.4507290-wrong" };
    expect(() => toPaymentRequirements(badChecksum, { feePayer: FEE_PAYER })).toThrow();
  });
});

describe("fromPaymentRequirements", () => {
  it("rebuilds the request an agent can hand to match and renderers", () => {
    const requirements = toPaymentRequirements(hbarRequest, { feePayer: FEE_PAYER });
    const rebuilt = fromPaymentRequirements(requirements, hbarRequest.reference);
    expect(rebuilt).toEqual({ ...hbarRequest });
  });

  it("refuses an object that lost its requirements shape at runtime", () => {
    expect(() =>
      fromPaymentRequirements({} as Parameters<typeof fromPaymentRequirements>[0], "r"),
    ).toThrow(/not an x402 requirements object/);
  });

  it("refuses foreign schemes", () => {
    const requirements = toPaymentRequirements(hbarRequest, { feePayer: FEE_PAYER });
    expect(() => fromPaymentRequirements({ ...requirements, scheme: "upto" }, "r")).toThrow(
      /scheme/,
    );
  });

  it("refuses alias payTo — the auto-account-creation trap", () => {
    const requirements = toPaymentRequirements(hbarRequest, { feePayer: FEE_PAYER });
    const alias = { ...requirements, payTo: "0x000000000000000000000000000000000000dead" };
    expect(() => fromPaymentRequirements(alias, "r")).toThrow(/payTo/);
  });

  it("refuses non-integer amounts and unknown asset forms", () => {
    const requirements = toPaymentRequirements(hbarRequest, { feePayer: FEE_PAYER });
    expect(() => fromPaymentRequirements({ ...requirements, amount: "1.5" }, "r")).toThrow(
      /amount/,
    );
    expect(() => fromPaymentRequirements({ ...requirements, asset: "USDC" }, "r")).toThrow(/asset/);
  });
});

describe("official wire vectors round-trip", () => {
  const expressible = vectors.valid.filter((vector) => !vector.request.asset.includes("/nft:"));

  it("covers a meaningful share of the vectors", () => {
    expect(expressible.length).toBeGreaterThanOrEqual(5);
  });

  for (const vector of expressible) {
    it(`round-trips ${vector.name}`, () => {
      const request = fromURI(vector.uri);
      const requirements = toPaymentRequirements(request, { feePayer: FEE_PAYER });
      const rebuilt = fromPaymentRequirements(requirements, request.reference);
      // What match needs must survive: who, what asset, how much, correlator.
      // "Who" is canonical identity: a HIP-15 checksum is transport armor,
      // VERIFIED on the way in and stripped — the official x402 scheme wires
      // bare ids, so the round-trip keeps the account, not the decoration.
      expect(rebuilt.recipient).toBe(request.recipient.replace(/-[a-z]{5}$/, ""));
      expect(rebuilt.asset).toBe(request.asset);
      expect(rebuilt.amount).toBe(request.amount);
      expect(rebuilt.reference).toBe(request.reference);
    });
  }

  for (const vector of vectors.valid.filter((v) => v.request.asset.includes("/nft:"))) {
    it(`refuses NFT vector ${vector.name}`, () => {
      const request = fromURI(vector.uri);
      expect(() => toPaymentRequirements(request, { feePayer: FEE_PAYER })).toThrow(/NFT/);
    });
  }
});

describe("the testnet gate", () => {
  it("admits testnet and nothing else", () => {
    expect(isSupportedNetwork("hedera:testnet")).toBe(true);
    expect(isSupportedNetwork("hedera:mainnet")).toBe(false);
    expect(assertSupportedNetwork("hedera:testnet")).toBe("hedera:testnet");
    expect(() => assertSupportedNetwork("hedera:mainnet")).toThrow(/enforced in code/);
  });
});
