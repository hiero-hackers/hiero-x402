// SPDX-License-Identifier: Apache-2.0
/**
 * Property-based fuzzing of every surface that reads INPUT THIS REPO DID NOT
 * WRITE: topic messages from a public HCS topic, headers off a response a
 * facilitator or resource server controls, network ids from config, and text
 * that ends up inside an HTML receipt.
 *
 * The example-based suites pin what the parsers do for known inputs; these
 * pin what they must NEVER do for any input — throw mid-response, half-parse
 * a shape, widen the testnet gate, or let a `<script>` through into a
 * receipt. fast-check generates the inputs (lone surrogates, control
 * characters, `"constructor"`, near-miss spellings) and shrinks any
 * counterexample to its smallest form.
 */
import { Buffer } from "node:buffer";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ATTESTATION_VERSION,
  CONTENT_SIGNATURE_HEADER,
  CONTENT_SHA256_HEADER,
  CONTENT_SIGNER_HEADER,
  InvalidRequirementsError,
  SUPPORTED_NETWORKS,
  UnsupportedNetworkError,
  assertSupportedNetwork,
  attestationCommitmentMessage,
  attestationMessage,
  commitmentReference,
  contentCommitmentMessage,
  escapeHTML,
  fromPaymentRequirements,
  isSha256Hex,
  isSupportedNetwork,
  parseAttestation,
  parseContentCommitment,
  parseContentCommitmentHeaders,
  readPaymentResponseHeader,
  restTransactionId,
  sha256Hex,
  toPaymentRequirements,
  transactionsById,
} from "../src/index.js";
import type { Attestation, SettlementVerdict } from "../src/index.js";
import type { PaymentRequirements } from "@x402/core/types";
import { fetchStub } from "./helpers.js";

/** Hostile text: lone surrogates, control characters, `"__proto__"`, "". */
const text = fc.string({ unit: "binary" });
/** Text a line-oriented message can carry without changing its line count. */
const line = text.filter((value) => !value.includes("\n"));
const nonEmptyLine = line.filter((value) => value !== "");
const sha256 = fc.string({
  unit: fc.constantFrom(..."0123456789abcdef"),
  minLength: 64,
  maxLength: 64,
});
const entityId = fc.nat({ max: 9_999_999 }).map((num) => `0.0.${String(num)}`);
const transactionId = fc
  .tuple(entityId, fc.nat({ max: 2_000_000_000 }), fc.nat({ max: 999_999_999 }))
  .map(([payer, seconds, nanos]) => `${payer}@${String(seconds)}.${String(nanos)}`);

/** The only fields `attestationMessage` reads — the rest is evidence. */
const verdictOf = (facts: {
  status: string;
  transactionId: string;
  reference: string;
  recipient: string;
  amount: bigint;
  asset: string;
}): SettlementVerdict =>
  ({
    fulfilment: { status: facts.status },
    request: {
      recipient: facts.recipient,
      asset: facts.asset,
      amount: facts.amount,
      reference: facts.reference,
    },
    receipts: [],
    transactionId: facts.transactionId,
  }) as unknown as SettlementVerdict;

describe("fuzz: content commitments", () => {
  it("a parsed commitment always re-serializes to the exact bytes it was parsed from", () => {
    // The signed bytes and the parsed facts must be the same fact stated
    // twice — if parsing ever normalized anything, a verifier could check a
    // signature over bytes the server never signed.
    fc.assert(
      fc.property(text, (message) => {
        const parsed = parseContentCommitment(message);
        if (parsed !== undefined) expect(contentCommitmentMessage(parsed)).toBe(message);
      }),
    );
  });

  it("round-trips every well-formed commitment", () => {
    fc.assert(
      fc.property(nonEmptyLine, nonEmptyLine, sha256, (tx, reference, digest) => {
        const facts = { transactionId: tx, reference, sha256: digest };
        expect(parseContentCommitment(contentCommitmentMessage(facts))).toEqual({
          v: 1,
          ...facts,
        });
      }),
    );
  });

  it("never accepts a digest outside the one canonical spelling", () => {
    fc.assert(
      fc.property(nonEmptyLine, nonEmptyLine, line, (tx, reference, digest) => {
        fc.pre(!isSha256Hex(digest));
        expect(
          parseContentCommitment(
            contentCommitmentMessage({ transactionId: tx, reference, sha256: digest }),
          ),
        ).toBeUndefined();
      }),
    );
  });

  it("reads the commitment headers all-or-nothing", () => {
    // A partial commitment is no commitment: two of three headers must never
    // produce an object a caller could mistake for a presented commitment.
    const headerNames = [
      CONTENT_SHA256_HEADER,
      CONTENT_SIGNER_HEADER,
      CONTENT_SIGNATURE_HEADER,
    ] as const;
    fc.assert(
      fc.property(
        fc.subarray([...headerNames]),
        fc.dictionary(fc.string(), line),
        (present, junk) => {
          const values = new Map<string, string>(present.map((name) => [name, junk[name] ?? name]));
          const parsed = parseContentCommitmentHeaders((name) => values.get(name) ?? null);
          expect(parsed === undefined).toBe(present.length !== headerNames.length);
        },
      ),
    );
  });

  it("derives the same reference from the server's path and the agent's full URL", () => {
    // THE convention that has to hold across two processes: middleware sees a
    // raw request target, the agent sees the URL it fetched, and both must
    // sign/verify the same bytes. Dot segments, spaces and query strings are
    // exactly where a hand-rolled split would let the two drift apart.
    const segment = fc.oneof(
      fc.string({
        unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-._~"),
        minLength: 1,
        maxLength: 8,
      }),
      fc.constantFrom(".", "..", "a b", "%41", ""),
    );
    const path = fc
      .array(segment, { minLength: 1, maxLength: 4 })
      .map((segments) => `/${segments.join("/")}`);
    const query = fc.constantFrom("", "?", "?symbol=HBAR", "?a=1&b=/../x");
    const origin = fc.constantFrom("http://localhost:4021", "https://api.example.test");
    fc.assert(
      fc.property(path, query, origin, (route, search, base) => {
        const fromPath = commitmentReference(`${route}${search}`);
        expect(commitmentReference(`${base}${route}${search}`)).toBe(fromPath);
        expect(fromPath.startsWith("/")).toBe(true);
        expect(fromPath).not.toContain("?");
        expect(commitmentReference(fromPath)).toBe(fromPath); // idempotent
      }),
    );
  });

  it("hashes strings and their utf8 bytes identically, always canonically spelled", () => {
    fc.assert(
      fc.property(text, (value) => {
        const digest = sha256Hex(value);
        expect(isSha256Hex(digest)).toBe(true);
        expect(sha256Hex(Buffer.from(value, "utf8"))).toBe(digest);
      }),
    );
  });
});

describe("fuzz: attestations", () => {
  it("never throws on a foreign topic message, and never half-understands one", () => {
    // Topics are public: anyone can submit anything. A reader that throws is
    // a reader that can be stopped by a stranger's message.
    fc.assert(
      fc.property(text, (message) => {
        const parsed = parseAttestation(message);
        if (parsed === undefined) return;
        expect(parsed.v).toBe(ATTESTATION_VERSION);
        expect(parsed.kind).toBe("x402-settlement-verdict");
        expect(parsed.amount).toMatch(/^\d+$/);
        if (parsed.content !== undefined) expect(isSha256Hex(parsed.content.sha256)).toBe(true);
      }),
    );
  });

  it("survives arbitrary JSON, not just arbitrary text", () => {
    fc.assert(
      fc.property(fc.json(), (message) => {
        expect(() => parseAttestation(message)).not.toThrow();
      }),
    );
  });

  it("round-trips a verdict through the wire format", () => {
    fc.assert(
      fc.property(
        fc.record({
          status: fc.constantFrom(
            "paid",
            "underpaid",
            "overpaid",
            "unpaid",
            "wrong-asset",
            "expired",
          ),
          transactionId: nonEmptyLine,
          reference: nonEmptyLine,
          recipient: nonEmptyLine,
          amount: fc.bigInt({ min: 0n, max: 10n ** 24n }),
          asset: nonEmptyLine,
        }),
        (facts) => {
          const parsed = parseAttestation(attestationMessage(verdictOf(facts)));
          expect(parsed).toEqual({
            v: ATTESTATION_VERSION,
            kind: "x402-settlement-verdict",
            status: facts.status,
            transactionId: facts.transactionId,
            reference: facts.reference,
            recipient: facts.recipient,
            amount: facts.amount.toString(),
            asset: facts.asset,
          });
        },
      ),
    );
  });

  it("rebuilds the signed bytes from an attestation's own fields", () => {
    // What makes a topic self-auditing: the auditor reconstructs the message
    // the server signed without asking agent or server for anything.
    fc.assert(
      fc.property(
        nonEmptyLine,
        nonEmptyLine,
        fc.option(nonEmptyLine, { nil: undefined }),
        nonEmptyLine,
        nonEmptyLine,
        sha256,
        (tx, settlementRef, signedRef, recipient, asset, digest) => {
          const message = attestationMessage(
            verdictOf({
              status: "paid",
              transactionId: tx,
              reference: settlementRef,
              recipient,
              asset,
              amount: 1n,
            }),
            {
              content: {
                sha256: digest,
                ...(signedRef !== undefined ? { reference: signedRef } : {}),
              },
            },
          );
          const parsed = parseAttestation(message);
          expect(parsed).toBeDefined();
          expect(attestationCommitmentMessage(parsed as Attestation)).toBe(
            contentCommitmentMessage({
              transactionId: tx,
              // The signed reference wins over the settlement reference —
              // the two differ (route path vs. full URL) and confusing them
              // verifies a signature over bytes nobody signed.
              reference: signedRef ?? settlementRef,
              sha256: digest,
            }),
          );
        },
      ),
    );
  });
});

describe("fuzz: the payment-response header", () => {
  it("never throws, and only ever reports a canonically spelled settlement id", () => {
    // This runs mid-response on the agent's happy path: a malformed header
    // from a hostile server must degrade to "no claim", never to a throw.
    const encoded = fc.oneof(
      text,
      text.map((value) => Buffer.from(value, "utf8").toString("base64")),
      fc.json().map((value) => Buffer.from(value, "utf8").toString("base64")),
    );
    fc.assert(
      fc.property(encoded, (value) => {
        const read = readPaymentResponseHeader((name) =>
          name === "payment-response" ? value : null,
        );
        if (read !== undefined) expect(read.transactionId).toMatch(/^\d+\.\d+\.\d+-\d+-\d{9}$/);
      }),
    );
  });

  it("reads the legacy spelling identically", () => {
    fc.assert(
      fc.property(
        transactionId,
        fc.option(entityId, { nil: undefined }),
        fc.boolean(),
        (tx, payer, success) => {
          const value = Buffer.from(
            JSON.stringify({ success, transaction: tx, ...(payer !== undefined ? { payer } : {}) }),
            "utf8",
          ).toString("base64");
          const canonical = readPaymentResponseHeader((name) =>
            name === "payment-response" ? value : null,
          );
          const legacy = readPaymentResponseHeader((name) =>
            name === "x-payment-response" ? value : null,
          );
          expect(legacy).toEqual(canonical);
          expect(canonical?.transactionId).toBe(restTransactionId(tx));
        },
      ),
    );
  });
});

describe("fuzz: transaction ids", () => {
  it("normalizes both accepted forms to one idempotent REST spelling", () => {
    fc.assert(
      fc.property(transactionId, (tx) => {
        const rest = restTransactionId(tx);
        expect(rest).toMatch(/^\d+\.\d+\.\d+-\d+-\d{9}$/);
        expect(restTransactionId(rest)).toBe(rest);
      }),
    );
  });

  it("refuses anything that is not a transaction id — loudly, never silently", () => {
    fc.assert(
      fc.property(text, (value) => {
        fc.pre(!/^(\d+\.\d+\.\d+@\d+\.\d+|\d+\.\d+\.\d+-\d+-\d+)$/.test(value));
        expect(() => restTransactionId(value)).toThrow();
      }),
    );
  });
});

describe("fuzz: the testnet gate", () => {
  const foreign = fc
    .oneof(
      text,
      fc.constantFrom(
        "hedera:mainnet",
        "hedera:previewnet",
        "HEDERA:TESTNET",
        "hedera:testnet ",
        " hedera:testnet",
        "hedera:testnet\n",
        "hedera:testnet:0.0.1",
        "eip155:1",
      ),
    )
    .filter((network) => !(SUPPORTED_NETWORKS as readonly string[]).includes(network));

  it("refuses every network but the pinned ones — near-miss spellings included", () => {
    fc.assert(
      fc.property(foreign, (network) => {
        expect(isSupportedNetwork(network)).toBe(false);
        expect(() => assertSupportedNetwork(network)).toThrow(UnsupportedNetworkError);
        try {
          assertSupportedNetwork(network);
        } catch (error) {
          expect((error as UnsupportedNetworkError).network).toBe(network);
        }
      }),
    );
  });

  it("refuses a mirror lookup before any request leaves the process", async () => {
    // The gate is also the outbound-request gate: an unpinned network must
    // never reach fetch at all, whatever the transaction id looks like.
    await fc.assert(
      fc.asyncProperty(foreign, text, async (network, tx) => {
        const { fetchImpl, calls } = fetchStub([]);
        await expect(transactionsById(network, tx, fetchImpl)).rejects.toBeInstanceOf(
          UnsupportedNetworkError,
        );
        expect(calls).toEqual([]);
      }),
      { numRuns: 50 },
    );
  });
});

describe("fuzz: requirements", () => {
  it("fails only in this repo's own error vocabulary", () => {
    // Terms arrive from a resource server. Whatever it sends, a consumer
    // must be able to discriminate the failure by `instanceof` rather than
    // by string-matching some dependency's message.
    fc.assert(
      fc.property(fc.anything(), text, (junk, reference) => {
        try {
          fromPaymentRequirements(junk as PaymentRequirements, reference);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidRequirementsError);
        }
      }),
    );
    fc.assert(
      fc.property(fc.anything(), text, (junk, feePayer) => {
        try {
          toPaymentRequirements(junk as never, { feePayer });
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidRequirementsError);
        }
      }),
    );
  });

  it("round-trips a valid request through the x402 spelling", () => {
    fc.assert(
      fc.property(
        entityId,
        entityId,
        fc.bigInt({ min: 1n, max: 10n ** 18n }),
        fc.webUrl(),
        fc.integer({ min: 1, max: 3600 }),
        (payTo, feePayer, amount, reference, maxTimeoutSeconds) => {
          const request = {
            recipient: `hedera:testnet:${payTo}`,
            asset: "hedera:testnet/slip44:3030",
            amount,
            reference,
          } as const;
          const requirements = toPaymentRequirements(request, { feePayer, maxTimeoutSeconds });
          expect(requirements.network).toBe("hedera:testnet");
          expect(fromPaymentRequirements(requirements, reference)).toEqual(request);
        },
      ),
    );
  });
});

describe("fuzz: receipt rendering", () => {
  it("leaves no character that can open a tag or close an attribute", () => {
    // The XSS boundary: verdict text (references, signer ids, statuses) is
    // attacker-influenced and lands in a self-contained HTML document.
    fc.assert(
      fc.property(text, (value) => {
        const escaped = escapeHTML(value);
        expect(escaped).not.toMatch(/[<>"']/);
        // Lossless: the receipt shows what was served, not a mangled version.
        expect(
          escaped.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))),
        ).toBe(value);
      }),
    );
  });

  it("is idempotent-safe: escaping twice never loses the original", () => {
    fc.assert(
      fc.property(text, (value) => {
        const once = escapeHTML(value);
        const twice = escapeHTML(once);
        const decode = (html: string): string =>
          html.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
        expect(decode(decode(twice))).toBe(value);
      }),
    );
  });
});
