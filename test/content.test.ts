// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PrivateKey, PublicKey } from "@hiero-ledger/sdk";
import { Buffer } from "node:buffer";
import {
  CONTENT_COMMITMENT_VERSION,
  CONTENT_SHA256_HEADER,
  commitmentReference,
  contentCommitmentHeaders,
  contentCommitmentMessage,
  isSha256Hex,
  parseContentCommitment,
  parseContentCommitmentHeaders,
  sha256Hex,
} from "../src/index.js";

const FACTS = {
  transactionId: "0.0.7000001@1753099999.123456789",
  reference: "/data/spot-price",
  sha256: sha256Hex('{"product":"spot-price","mock":true}'),
} as const;

describe("sha256Hex", () => {
  it("hashes strings and bytes to the same lowercase hex", () => {
    const asString = sha256Hex("abc");
    const asBytes = sha256Hex(new TextEncoder().encode("abc"));
    expect(asString).toBe(asBytes);
    // The best-known sha-256 test vector — pinned so the helper can never
    // silently become a different hash.
    expect(asString).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("commitmentReference", () => {
  it("is the route PATH — never a full URL, never the query — from either form", () => {
    // The convention's one owner: server middleware passes the request URL,
    // the agent passes the URL it fetched — both must land on the same bytes.
    expect(commitmentReference("http://localhost:4021/data/spot-price?symbol=HBAR")).toBe(
      "/data/spot-price",
    );
    expect(commitmentReference(new URL("https://api.example.test/data/fx"))).toBe("/data/fx");
    expect(commitmentReference("/data/spot-price?symbol=HBAR")).toBe("/data/spot-price");
    expect(commitmentReference("/data/ohlc")).toBe("/data/ohlc");
  });

  it("normalizes a raw request target the way the fetched URL already is", () => {
    // Found by the property suite: a server signing `req.url` verbatim and an
    // agent hashing the URL it fetched would sign different bytes for the
    // same route. Both forms now walk the same URL parser.
    expect(commitmentReference("/data/./spot-price")).toBe("/data/spot-price");
    expect(commitmentReference("/data/x/../spot-price")).toBe("/data/spot-price");
    expect(commitmentReference("/data/spot price")).toBe(
      commitmentReference("http://localhost:4021/data/spot price"),
    );
  });
});

describe("isSha256Hex", () => {
  it("accepts exactly the canonical spelling", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false); // one canonical case
    expect(isSha256Hex("a".repeat(63))).toBe(false);
  });
});

describe("contentCommitmentHeaders ⇄ parseContentCommitmentHeaders", () => {
  it("round-trips producer to consumer, and the signature verifies over the message", () => {
    const key = PrivateKey.generateED25519();
    const headers = contentCommitmentHeaders({
      ...FACTS,
      signer: "0.0.7000009",
      sign: (message) => key.sign(message),
    });
    const parsed = parseContentCommitmentHeaders((name) => headers[name] ?? null);
    expect(parsed).toEqual({
      sha256: FACTS.sha256,
      signer: "0.0.7000009",
      signatureB64: headers["x-content-signature"],
    });
    // The signature is over the canonical message — any consumer can check.
    expect(
      PublicKey.fromString(key.publicKey.toStringRaw()).verify(
        Buffer.from(contentCommitmentMessage(FACTS), "utf8"),
        Buffer.from(parsed!.signatureB64, "base64"),
      ),
    ).toBe(true);
  });

  it("a partial commitment is no commitment", () => {
    const key = PrivateKey.generateED25519();
    const headers = contentCommitmentHeaders({
      ...FACTS,
      signer: "0.0.7000009",
      sign: (message) => key.sign(message),
    });
    expect(parseContentCommitmentHeaders(() => null)).toBeUndefined();
    expect(
      parseContentCommitmentHeaders((name) =>
        name === CONTENT_SHA256_HEADER ? null : (headers[name] ?? null),
      ),
    ).toBeUndefined();
  });
});

describe("contentCommitmentMessage", () => {
  it("is ONE unambiguous byte sequence — line-oriented, human-auditable", () => {
    const message = contentCommitmentMessage(FACTS);
    expect(message.split("\n")).toEqual([
      `x402-content-commitment v${String(CONTENT_COMMITMENT_VERSION)}`,
      `tx:${FACTS.transactionId}`,
      `ref:${FACTS.reference}`,
      `sha256:${FACTS.sha256}`,
    ]);
  });

  it("round-trips through parse", () => {
    expect(parseContentCommitment(contentCommitmentMessage(FACTS))).toEqual({
      v: CONTENT_COMMITMENT_VERSION,
      ...FACTS,
    });
  });
});

describe("parseContentCommitment", () => {
  it("returns undefined for foreign strings — data, not errors", () => {
    expect(parseContentCommitment("")).toBeUndefined();
    expect(parseContentCommitment("hello\nworld")).toBeUndefined();
    expect(parseContentCommitment(JSON.stringify(FACTS))).toBeUndefined();
  });

  it("rejects versions it does not know — no claimed understanding of future shapes", () => {
    const future = contentCommitmentMessage(FACTS).replace("v1", "v2");
    expect(parseContentCommitment(future)).toBeUndefined();
  });

  it("rejects tampered or missing facts", () => {
    const message = contentCommitmentMessage(FACTS);
    // A line dropped.
    expect(parseContentCommitment(message.split("\n").slice(0, 3).join("\n"))).toBeUndefined();
    // Labels swapped — right line count, wrong facts.
    expect(parseContentCommitment(message.replace("tx:", "id:"))).toBeUndefined();
    expect(parseContentCommitment(message.replace("ref:", "path:"))).toBeUndefined();
    expect(parseContentCommitment(message.replace("sha256:", "md5:"))).toBeUndefined();
    // Empty facts.
    expect(
      parseContentCommitment(contentCommitmentMessage({ ...FACTS, transactionId: "" })),
    ).toBeUndefined();
    expect(
      parseContentCommitment(contentCommitmentMessage({ ...FACTS, reference: "" })),
    ).toBeUndefined();
    // A hash that isn't 64 hex chars is not a sha-256.
    expect(
      parseContentCommitment(contentCommitmentMessage({ ...FACTS, sha256: "deadbeef" })),
    ).toBeUndefined();
    expect(
      parseContentCommitment(
        contentCommitmentMessage({ ...FACTS, sha256: FACTS.sha256.toUpperCase() }),
      ),
    ).toBeUndefined();
  });
});
