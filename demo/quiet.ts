// SPDX-License-Identifier: Apache-2.0
/**
 * Demo-output hygiene: the Hedera SDK prints a benign advisory when it parses
 * a raw HEX key (it can't tell ECDSA from ED25519 by shape, so it suggests the
 * explicit `fromStringECDSA()`/`fromStringED25519()` constructors). We already
 * resolve the curve deliberately against the account's on-chain key
 * (`resolvePrivateKey`), so that advisory is expected noise, not a finding —
 * and a first-time demo watcher shouldn't have to wonder about it.
 *
 * This filters ONLY those known-benign lines out of `console.warn`; every
 * other warning (ours included — mismatched keys, attestation failures) still
 * comes through untouched. Call it once, before any key is parsed.
 */
const BENIGN = [/Consider using fromStringECDSA\(\) or fromStringED25519\(\)/];

let installed = false;

export function hushBenignSdkWarnings(): void {
  if (installed) return;
  installed = true;
  const original = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === "string" && BENIGN.some((pattern) => pattern.test(first))) return;
    original(...args);
  };
}
