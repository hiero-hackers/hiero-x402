// SPDX-License-Identifier: Apache-2.0
/**
 * The resource server's entry: env in, listener up. Everything else —
 * routes, the 402 middleware, the verify-then-serve wrapper — lives in the
 * env-free factory (app.ts) so the conformance suite can pin the wire.
 *
 * This process holds no keys.
 */
import { spawn } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { CATALOG, SERVER_PORT, demoNetwork, requireEnv } from "./shared.js";
import { createApp } from "./app.js";

// The hub's Run button. The agent stays its OWN process reading its OWN
// key from .env — this server process still never holds a key; it only
// relays the child's narration to the dashboard.
function runAgent(): Readable {
  const output = new PassThrough();
  const child = spawn("node_modules/.bin/tsx", ["--env-file=.env", "demo/agent.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    // The agent must pay THIS server, whatever port it's on. Real env wins
    // over --env-file, so this override holds even if .env sets SERVER_URL.
    env: { ...process.env, SERVER_URL: `http://localhost:${SERVER_PORT}` },
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  child.on("close", (code) => {
    output.end(`[agent] process exited with code ${String(code)}\n`);
  });
  return output;
}

const NETWORK = demoNetwork();
const PAY_TO = requireEnv("PAY_TO_ACCOUNT");
const VERIFY_BEFORE_SERVE = process.env.VERIFY_BEFORE_SERVE === "1";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4020";

const app = createApp({
  network: NETWORK,
  payTo: PAY_TO,
  facilitatorUrl: FACILITATOR_URL,
  checkoutBase: process.env.CHECKOUT_BASE ?? "https://hiero-hackers.github.io/hiero-checkout/",
  verifyBeforeServe: VERIFY_BEFORE_SERVE,
  runAgent,
});

serve({ fetch: app.fetch, port: SERVER_PORT }, () => {
  console.log(`[server] listening on :${SERVER_PORT} — no keys in this process`);
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
