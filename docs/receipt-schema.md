# Receipt JSON Schema

**Version 1** — additive only; future versions add fields, never remove them.

## Top-level

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `1` | Schema version, always `1` for this format. |
| `settlement` | `object` | The settlement verdict and how it was verified. |
| `content` | `object?` | What the server delivered for the payment, if provided. |
| `consent` | `string?` | A plain-words caveat from the caller, if provided. |
| `proof` | `object` | How the chain was consulted and the reference to look up. |

## settlement

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | The fulfilment status: `paid`, `underpaid`, `overpaid`, `unpaid`, `expired`, etc. |
| `transactionId` | `string` | The settlement transaction id, REST-normalized. |
| `hashscanUrl` | `string?` | Human-checkable proof link, if the mirror knows the transaction. |
| `mirrorUrl` | `string?` | The raw mirror-node record link. |
| `trust` | `TrustStamp` | `UNVERIFIED` for mirror, `VERIFIED` for block proof. |
| `method` | `string` | One-line description of how the verdict was reached. |

## content (optional)

| Field | Type | Description |
|-------|------|-------------|
| `sha256` | `string?` | The agent's hash of the bytes it received. |
| `serverCommitment` | `string?` | The server's content commitment, if one was presented. |
| `signer` | `string?` | The signer of the content commitment. |
| `trust` | `TrustStamp` | Always `SERVER COMMITTED` when content is present. |

## proof

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `"mirror" | "block"` | `mirror` for mirror-node lookup, `block` for cryptographic block proof. |
| `reference` | `string` | The transaction id to look up. |

## TrustStamp

`"UNVERIFIED" | "SERVER COMMITTED" | "VERIFIED"` — the same vocabulary as the HTML receipt's seal.
