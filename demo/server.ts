// SPDX-License-Identifier: Apache-2.0
/**
 * The resource server's entry: env in, listener up. Everything else —
 * routes, the 402 middleware, the verify-then-serve wrapper — lives in the
 * env-free factory (app.ts) so the conformance suite can pin the wire.
 *
 * This process holds no payment keys. The one optional key it may hold —
 * CONTENT_SIGNER_KEY — is an attestation identity for content commitments:
 * it signs the bytes served against their settlement so the server cannot
 * later deny what it delivered. Point it at a dedicated account holding
 * nothing; it can commit to bytes, never move money.
 */
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { serve } from "@hono/node-server";
import {
  CATALOG,
  SERVER_PORT,
  confirmPayToAccount,
  demoNetwork,
  fetchAccountPublicKey,
  requireEnv,
  resolvePrivateKey,
} from "./shared.js";
import { createApp, type AgentRun } from "./app.js";

// The hub's Run button. The agent stays its OWN process reading its OWN
// key from .env — this server process still never holds a key; it only
// relays the child's narration to the dashboard. In human-approval mode the
// child pauses on its stdin at step 2½; `decide` writes the hub's answer
// there — the approval is transport, the GATE lives in the agent.
function runAgent({
  humanApproval,
  maxPayment,
}: {
  humanApproval: boolean;
  maxPayment?: string;
}): AgentRun {
  const output = new PassThrough();
  const child = spawn("node_modules/.bin/tsx", ["--env-file=.env", "demo/agent.ts"], {
    stdio: [humanApproval ? "pipe" : "ignore", "pipe", "pipe"],
    // The agent must pay THIS server, whatever port it's on. Real env wins
    // over --env-file, so this override holds even if .env sets SERVER_URL.
    env: {
      ...process.env,
      SERVER_URL: `http://localhost:${SERVER_PORT}`,
      ...(humanApproval ? { HUMAN_APPROVAL: "1" } : {}),
      ...(maxPayment !== undefined ? { MAX_AGENT_PAYMENT: maxPayment } : {}),
    },
  });
  child.stdout?.pipe(output, { end: false });
  child.stderr?.pipe(output, { end: false });
  child.on("close", (code) => {
    output.end(`[agent] process exited with code ${String(code)}\n`);
  });
  if (!humanApproval) return { narration: output };
  return {
    narration: output,
    decide: (approve, consent): void => {
      // end() after the answer: the child needs nothing more from stdin, and
      // a dangling pipe would keep it alive after its last step.
      child.stdin?.end(approve ? (consent !== undefined ? `y ${consent}\n` : "y\n") : "n\n");
    },
  };
}

const NETWORK = demoNetwork();
const PAY_TO = requireEnv("PAY_TO_ACCOUNT");
const APPROVER_ID = process.env.APPROVER_ACCOUNT_ID ?? "";
const WALLET_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID ?? "";
const VERIFY_BEFORE_SERVE = process.env.VERIFY_BEFORE_SERVE === "1";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4020";
const CONTENT_SIGNER_ID = process.env.CONTENT_SIGNER_ACCOUNT_ID ?? "";
const CONTENT_SIGNER_KEY = process.env.CONTENT_SIGNER_KEY ?? "";
if ((CONTENT_SIGNER_ID === "") !== (CONTENT_SIGNER_KEY === "")) {
  // Name the env vars, never their values (CodeQL: clear-text logging).
  console.warn(
    "[server] CONTENT_SIGNER_ACCOUNT_ID and CONTENT_SIGNER_KEY must be set together — " +
      "content commitments are off this run",
  );
}

// Three independent mirror lookups, one round-trip of boot latency:
// the payTo gate (refuses a payTo that can never settle — receiver-sig
// trap), the approver's on-chain key (so the hub verifies consent without
// further lookups), and the content-signing identity (resolved against
// the mirror like every other demo key; absent → paid responses are
// served uncommitted and the receipt says so honestly).
const [, approverKey, contentSignerKey] = await Promise.all([
  confirmPayToAccount(PAY_TO),
  APPROVER_ID === "" ? undefined : fetchAccountPublicKey(APPROVER_ID),
  CONTENT_SIGNER_ID !== "" && CONTENT_SIGNER_KEY !== ""
    ? resolvePrivateKey(CONTENT_SIGNER_ID, CONTENT_SIGNER_KEY)
    : undefined,
]);
if (APPROVER_ID !== "" && approverKey === undefined) {
  console.warn(
    "[server] could not resolve APPROVER_ACCOUNT_ID's key from the mirror — wallet approvals are off this run",
  );
}
const contentSigner =
  contentSignerKey !== undefined
    ? { accountId: CONTENT_SIGNER_ID, key: contentSignerKey }
    : undefined;

const app = createApp({
  network: NETWORK,
  payTo: PAY_TO,
  facilitatorUrl: FACILITATOR_URL,
  checkoutBase: process.env.CHECKOUT_BASE ?? "https://hiero-hackers.github.io/hiero-checkout/",
  verifyBeforeServe: VERIFY_BEFORE_SERVE,
  runAgent,
  ...(approverKey !== undefined
    ? { approver: { accountId: APPROVER_ID, publicKey: approverKey } }
    : {}),
  ...(WALLET_PROJECT_ID !== "" ? { walletProjectId: WALLET_PROJECT_ID } : {}),
  ...(contentSigner !== undefined ? { contentSigner } : {}),
  ...(process.env.ATTEST_TOPIC_ID !== undefined
    ? { attestTopicId: process.env.ATTEST_TOPIC_ID }
    : {}),
});

serve({ fetch: app.fetch, port: SERVER_PORT }, () => {
  console.log(`[server] listening on :${SERVER_PORT} — no payment keys in this process`);
  console.log(
    contentSigner !== undefined
      ? `[server] content commitments ON — ${contentSigner.accountId} signs every served byte against its settlement`
      : "[server] content commitments OFF — responses are served uncommitted (set CONTENT_SIGNER_ACCOUNT_ID/CONTENT_SIGNER_KEY)",
  );
  console.log(`[server] network=${NETWORK} payTo=${PAY_TO} facilitator=${FACILITATOR_URL}`);
  for (const product of CATALOG) {
    const unit = product.asset.kind === "hbar" ? "tinybar" : `${product.asset.symbol} base units`;
    console.log(`[server]   ${product.path} — ${product.amount.toString()} ${unit}`);
  }
  console.log(
    VERIFY_BEFORE_SERVE
      ? "[server] VERIFY_BEFORE_SERVE=1 — data is withheld until the mirror confirms"
      : "[server] VERIFY_BEFORE_SERVE=0 — serving on settlement; merchant risk bounded at one response (see SECURITY.md)",
  );
});
