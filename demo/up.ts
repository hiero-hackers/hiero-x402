// SPDX-License-Identifier: Apache-2.0
/**
 * One command, both rails: spawns the facilitator and the resource server
 * as SEPARATE child processes — the trust boundary (fee-payer key in one
 * process, no keys in the other) is preserved; only the terminal count
 * drops to one. Boots strictly in order (the server asks the facilitator
 * for /supported at startup), filters known SDK log noise, and ends with
 * a compact ready-block.
 *
 * The agent (`npm run e2e`) stays its own command on purpose: it is the
 * PAYER, the third trust domain, and the demo's star beat.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { FACILITATOR_PORT, SERVER_PORT } from "./shared.js";

const TSX = "node_modules/.bin/tsx";
const HUB = `http://localhost:${SERVER_PORT}/ui`;

// Log lines that inform nobody watching a demo — dropped, never rewritten.
const NOISE = [/^WARNING: Consider using fromString/];

function pipeFiltered(input: Readable, output: Writable): void {
  createInterface({ input }).on("line", (line) => {
    if (NOISE.some((pattern) => pattern.test(line))) return;
    output.write(`${line}\n`);
  });
}

function rail(script: string): ChildProcess {
  // Children inherit our env — `npm run demo` already loaded .env via tsx.
  const child = spawn(TSX, [script], { stdio: ["inherit", "pipe", "pipe"] });
  pipeFiltered(child.stdout as Readable, process.stdout);
  pipeFiltered(child.stderr as Readable, process.stderr);
  child.on("exit", (code) => {
    // One rail down means the demo is down — take the other with us.
    shutdown(code ?? 1);
  });
  return child;
}

const children: ChildProcess[] = [];
let exiting = false;
function shutdown(code: number): void {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForHealth(name: string, url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (exiting) return;
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet — keep polling
    }
    await sleep(200);
  }
  console.error(`[demo] ${name} never became healthy at ${url}`);
  shutdown(1);
}

/** What, if anything, already answers on a port. */
async function probe(port: number): Promise<"free" | "ours" | "other"> {
  let response;
  try {
    response = await fetch(`http://localhost:${port}/`);
  } catch {
    return "free";
  }
  const body = (await response.json().catch(() => undefined)) as
    { status?: string; service?: string } | undefined;
  // Our facilitator answers {status:"ok"…}; our server answers {service:"hiero-x402 demo…"}.
  return body?.status === "ok" || body?.service?.startsWith("hiero-x402") === true
    ? "ours"
    : "other";
}

// Pre-flight: don't race whatever already holds the ports. Our own demo
// already running is SUCCESS (point at the hub); anything else is an error.
const found = { facilitator: await probe(FACILITATOR_PORT), server: await probe(SERVER_PORT) };
if (found.facilitator === "ours" && found.server === "ours") {
  console.log(`[demo] already running — hub: ${HUB}`);
  process.exit(0);
}
for (const [name, port, state] of [
  ["facilitator", FACILITATOR_PORT, found.facilitator],
  ["server", SERVER_PORT, found.server],
] as const) {
  if (state !== "free") {
    console.error(`[demo] port ${port} (${name}) is taken by something else — free it and rerun:`);
    console.error(`[demo]   lsof -ti:${port} | xargs kill`);
    process.exit(1);
  }
}

// Strictly ordered: the server asks the facilitator for /supported at boot,
// so the facilitator must be healthy FIRST — the launcher encodes the
// ordering so nobody has to remember it across terminals.
children.push(rail("demo/facilitator.ts"));
await waitForHealth("facilitator", `http://localhost:${FACILITATOR_PORT}/`);
if (!exiting) {
  children.push(rail("demo/server.ts"));
  await waitForHealth("server", `http://localhost:${SERVER_PORT}/`);
}

if (!exiting) {
  console.log(`
[demo] ready
[demo]   hub    ${HUB}
[demo]   pay    npm run e2e   (the agent — separate terminal, its own key)
[demo]   stop   Ctrl-C
`);
}
