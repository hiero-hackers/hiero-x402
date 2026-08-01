// SPDX-License-Identifier: Apache-2.0
// verdict-view is the ONE owner of the trust registers; these tests pin the
// contract that matters: whatever it decides is exactly what the HTML
// renders. A second renderer (JSON) consuming the same registers therefore
// cannot disagree with the HTML — the agreement is structural, and this
// suite is the tripwire if anyone re-forks a register into a renderer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  consentRegister,
  contentRegister,
  settledFacts,
  settlementReceiptHTML,
  settlementRegister,
  verifySettlement,
  verifySettlementFromBlock,
} from "../src/index.js";
import type { DeliveredContent } from "../src/index.js";
import { HBAR_REQUEST, REQUIREMENTS, SETTLEMENT_ID, fetchStub, hbarRow } from "./helpers.js";

async function verdictFor(credited: number) {
  const { fetchImpl } = fetchStub([hbarRow(credited)]);
  return verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, { fetchImpl });
}

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

function blockVerdict() {
  return verifySettlementFromBlock(
    {
      scheme: "exact",
      network: "hedera:previewnet",
      amount: "1",
      asset: "0.0.0",
      payTo: "11.12.98",
      maxTimeoutSeconds: 180,
      extra: { feePayer: "11.12.2" },
    },
    "11.12.2@1774994518.000002058",
    "r",
    { blockBytes: fixture("467.blk.gz"), genesisBytes: fixture("0.blk.gz") },
  );
}

describe("settlementRegister", () => {
  it("stamps the mirror rung UNVERIFIED — an attested record is not proof", async () => {
    const register = settlementRegister(await verdictFor(5_000_000));
    expect(register).toMatchObject({ proven: false, stamp: "UNVERIFIED", readVia: "mirror" });
    expect(register.method).toContain("mirror node");
  });

  it("reserves VERIFIED for the block-proof rung", () => {
    const register = settlementRegister(blockVerdict());
    expect(register).toMatchObject({ proven: true, stamp: "VERIFIED", readVia: "block-proof" });
    expect(register.method).toContain("block proof");
  });

  it("is exactly what the HTML banner says — one owner, no drift", async () => {
    const mirror = await verdictFor(5_000_000);
    expect(settlementReceiptHTML(mirror)).toContain("Mirror receipt");
    expect(settlementReceiptHTML(blockVerdict())).toContain("block proof");
  });
});

describe("contentRegister", () => {
  const sha256 = "a".repeat(64);
  const cases: readonly [string, DeliveredContent][] = [
    ["AGENT RECORD", { sha256 }],
    [
      "SERVER COMMITTED",
      { sha256, commitment: { signer: "0.0.7000009", signatureB64: "c2ln", verified: true } },
    ],
    [
      "COMMITMENT BROKEN",
      { sha256, commitment: { signer: "0.0.7000009", signatureB64: "c2ln", verified: false } },
    ],
  ];

  it.each(cases)("decides %s — and the HTML panel agrees", async (badge, content) => {
    expect(contentRegister(content).badge).toBe(badge);
    const html = settlementReceiptHTML(await verdictFor(5_000_000), { content });
    expect(html).toContain(badge);
    for (const [other] of cases) if (other !== badge) expect(html).not.toContain(other);
  });
});

describe("consentRegister", () => {
  const consent = { approver: "0.0.42", terms: "t", signatureB64: "c2ln" };

  it.each([
    ["HUMAN APPROVED", true],
    ["CONSENT UNVERIFIED", false],
  ] as const)("decides %s — and the HTML panel agrees", async (badge, verified) => {
    expect(consentRegister({ verified }).badge).toBe(badge);
    const html = settlementReceiptHTML(await verdictFor(5_000_000), {
      consent: { ...consent, verified },
    });
    expect(html).toContain(badge);
  });
});

describe("settledFacts", () => {
  it("carries the numbers the HTML formats — exact, over, short, nothing", async () => {
    expect(settledFacts((await verdictFor(5_000_000)).fulfilment)).toEqual({
      received: 5_000_000n,
    });
    expect(settledFacts((await verdictFor(6_000_000)).fulfilment)).toEqual({
      received: 6_000_000n,
      excess: 1_000_000n,
    });
    expect(settledFacts((await verdictFor(4_000_000)).fulfilment)).toEqual({
      received: 4_000_000n,
      shortfall: 1_000_000n,
    });
    const { fetchImpl } = fetchStub(undefined, 404);
    const unpaid = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, {
      fetchImpl,
    });
    expect(settledFacts(unpaid.fulfilment)).toEqual({});
  });
});
