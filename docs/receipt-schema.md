# Receipt JSON — schema v1

`settlementReceiptJSON(verdict, options)` returns the machine-readable
companion to the HTML receipt: same verdict, same options, same trust
registers — every stamp and wording line comes from `src/verdict-view.ts`
(the one owner), so the two formats cannot disagree.

**Money policy:** every amount is a decimal **string of atomic units**
(tinybar; a token's smallest unit). Never a JSON number, never a float.

Evolution is additive only: fields may be added, never removed or
retyped; consumers pin on `schemaVersion`.

## Top level

| Field           | Type     | Description                                                                                            |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `schemaVersion` | `1`      | Pin on this.                                                                                            |
| `verdict`       | object   | The judgment: what was asked vs what landed.                                                            |
| `settlement`    | object   | How the chain was consulted, stamped for HOW it was read.                                               |
| `payments`      | object[] | Contributing payments — hiero-receipts' canonical `toJSON`, verbatim. Empty when nothing was credited. |
| `content`       | object?  | Delivered-content panel — present iff the caller passed one.                                            |
| `consent`       | object?  | Human-approval panel — present iff a human approved this run.                                           |
| `proof`         | object?  | The block proof's working — block-proof receipts only.                                                  |
| `caveat`        | string?  | The caller's honesty caveat, verbatim.                                                                  |

## `verdict`

| Field       | Type    | Description                                                                                                         |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `status`    | string  | `paid` · `overpaid` · `underpaid` · `unpaid` · `wrong-asset` · `expired` — the library's classification, verbatim. |
| `line`      | string  | The same plain-language sentence the HTML banner prints.                                                              |
| `quoted`    | string  | The quoted amount, atomic units.                                                                                      |
| `received`  | string? | What landed under these terms. Absent when nothing did.                                                               |
| `excess`    | string? | Present only when `status` is `overpaid`.                                                                             |
| `shortfall` | string? | Present only when `status` is `underpaid`.                                                                            |

## `settlement`

| Field           | Type    | Description                                                                                                                                  |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `transactionId` | string  | REST-normalized (`0.0.x-seconds-nanos`).                                                                                                        |
| `reference`     | string  | The caller's correlator (typically the resource URL).                                                                                           |
| `stamp`         | string  | `VERIFIED` (block proof — cryptography) or `UNVERIFIED` (mirror — the operator's attested record). `VERIFIED` is never used for mirror data. |
| `readVia`       | string  | `block-proof` or `mirror`.                                                                                                                      |
| `method`        | string  | The one-line method statement, identical wording to the HTML.                                                                                   |
| `hashscanUrl`   | string? | Human-checkable proof link (mirror path, once ingested).                                                                                        |
| `mirrorUrl`     | string? | The raw mirror record this verdict was read from. Absent on the block-proof path — no mirror is consulted.                                     |

## `content` (optional)

| Field        | Type    | Description                                                                                                                                                                                                   |
| ------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `badge`      | string  | `AGENT RECORD` (no commitment offered) · `SERVER COMMITTED` (signature verifies over the received bytes) · `COMMITMENT BROKEN` (claimed and does NOT verify — kept loud: a false commitment is evidence). |
| `line`       | string  | The register's explanatory sentence, plain text.                                                                                                                                                                 |
| `sha256`     | string  | The agent's hash of the exact bytes it received.                                                                                                                                                                 |
| `reference`  | string? | The reference exactly as the commitment message named it.                                                                                                                                                        |
| `commitment` | object? | `{ signer, signatureB64, verified }` — as presented, judged.                                                                                                                                                     |

## `consent` (optional)

| Field          | Type    | Description                                       |
| -------------- | ------- | -------------------------------------------------- |
| `badge`        | string  | `HUMAN APPROVED` or `CONSENT UNVERIFIED`.           |
| `line`         | string  | The register's explanatory sentence.                |
| `approver`     | string  | The approver's account id.                          |
| `terms`        | string  | The one-time challenge the wallet signed.           |
| `signatureB64` | string  | The signature, as presented.                        |
| `verified`     | boolean | Re-verified against the approver's on-chain key.    |

## `proof` (optional)

| Field    | Type     | Description                                  |
| -------- | -------- | --------------------------------------------- |
| `source` | string   | e.g. `block 467 · hedera:previewnet`.         |
| `anchor` | string?  | Where the hash chain ends.                    |
| `checks` | string[] | The checks that held, in the order they ran.  |
