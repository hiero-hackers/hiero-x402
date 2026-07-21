// SPDX-License-Identifier: Apache-2.0
/**
 * The testnet gate. This repo is a prototype: the demo must never move real
 * money, so the networks it will operate on are pinned HERE, in code — not in
 * an env var someone can fat-finger to mainnet. (Same pattern as
 * hiero-checkout's `IN_PAGE_PAYMENT_NETWORKS`.)
 *
 * Everything network-specific lives in ONE table — another network joins by
 * adding a row, and the `SupportedNetwork` union, the host maps, and the
 * gate all follow from it automatically (the payment-requests house
 * pattern). The compile-time guard below makes table/union drift a build
 * error, not a runtime surprise.
 */

import { UnsupportedNetworkError } from "./errors.js";

/** Everything this repo must know about one supported network — the single
 *  row to add when (deliberately!) widening the gate. */
interface NetworkSpec {
  /** CAIP-2 chain id, e.g. `"hedera:testnet"`. */
  readonly network: string;
  /** Public mirror-node REST base URL. */
  readonly mirrorHost: string;
  /** Explorer base URL — every settlement gets a human-checkable link. */
  readonly hashscanBase: string;
}

const TABLE = [
  {
    network: "hedera:testnet",
    mirrorHost: "https://testnet.mirrornode.hedera.com",
    hashscanBase: "https://hashscan.io/testnet",
  },
] as const satisfies readonly NetworkSpec[];

/** Networks this prototype will build requirements for or verify against. */
export const SUPPORTED_NETWORKS = TABLE.map((row) => row.network) as [
  (typeof TABLE)[number]["network"],
];

export type SupportedNetwork = (typeof TABLE)[number]["network"];

// Compile-time drift guard: the union and the table are the same set by
// construction; this trips if the derivations above are ever decoupled.
const _guard: SupportedNetwork = SUPPORTED_NETWORKS[0];
void _guard;

/** Mirror-node REST hosts for the supported networks. */
export const MIRROR_HOSTS = Object.fromEntries(
  TABLE.map((row) => [row.network, row.mirrorHost]),
) as Record<SupportedNetwork, string>;

/** HashScan explorer base URLs — every settlement gets a human-checkable link. */
export const HASHSCAN_HOSTS = Object.fromEntries(
  TABLE.map((row) => [row.network, row.hashscanBase]),
) as Record<SupportedNetwork, string>;

export function isSupportedNetwork(network: string): network is SupportedNetwork {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(network);
}

/** Refuses anything but the pinned networks — mainnet included, on purpose. */
export function assertSupportedNetwork(network: string): SupportedNetwork {
  if (!isSupportedNetwork(network)) {
    throw new UnsupportedNetworkError(
      `network "${network}" is not supported by this prototype — ` +
        `it operates on ${SUPPORTED_NETWORKS.join(", ")} only, enforced in code`,
      network,
    );
  }
  return network;
}
