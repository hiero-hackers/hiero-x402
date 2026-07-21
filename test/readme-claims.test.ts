// SPDX-License-Identifier: Apache-2.0
/**
 * Documentation is a set of CLAIMS, and claims get tested (the
 * payment-requests house pattern). What this pins:
 *
 *   1. every `npm run <x>` the README tells a judge to type actually exists;
 *   2. every env var the demo reads is documented in .env.example — and
 *      .env.example names no var the demo no longer reads;
 *   3. the badges point at THIS repo, not the sibling they were ported from;
 *   4. the proof section's transaction id and HashScan link agree.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readme = read("README.md");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

describe("README claims", () => {
  it("only tells people to run scripts that exist", () => {
    const mentioned = [...readme.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]!);
    expect(mentioned.length).toBeGreaterThanOrEqual(4);
    for (const script of mentioned) {
      expect(pkg.scripts, `README mentions "npm run ${script}"`).toHaveProperty(script);
    }
  });

  it("badges point at this repo", () => {
    const badgeRepos = [...readme.matchAll(/github\.com\/hiero-hackers\/([a-z0-9-]+)\//g)].map(
      (m) => m[1],
    );
    for (const repo of badgeRepos.slice(0, 6)) {
      expect(repo).toBe("hiero-x402");
    }
  });

  it("the proof section's transaction id and HashScan link agree", () => {
    // The settlement id (payer@validStart) and the HashScan link (consensus
    // timestamp) are different numbers by design — both must be present and
    // the link must be the consensus form.
    expect(readme).toContain("0.0.6502504@1784634414.257402675");
    const links = [...readme.matchAll(/hashscan\.io\/testnet\/transaction\/([\d.]+)/g)].map(
      (m) => m[1],
    );
    expect(links).toContain("1784634418.453138104"); // the paid ✓ run
    expect(links).toContain("1784633796.552851104"); // the caught underpayment
  });
});

describe(".env.example claims", () => {
  const example = read(".env.example");
  const documented = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));
  const demoSource = readdirSync(new URL("../demo", import.meta.url))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => read(`demo/${name}`))
    .join("\n");
  // Three spellings reach the environment: requireEnv("X"), process.env.X,
  // and the destructured env.X inside policyFromEnv-style helpers.
  const readInCode = new Set(
    [...demoSource.matchAll(/(?:requireEnv\("|(?:process\.)?env\.)([A-Z][A-Z0-9_]+)/g)].map(
      (m) => m[1]!,
    ),
  );

  it("documents every env var the demo reads", () => {
    for (const name of readInCode) {
      expect(documented, `demo reads ${name}`).toContain(name);
    }
  });

  it("names no env var the demo no longer reads", () => {
    for (const name of documented) {
      expect(readInCode, `.env.example documents ${name}`).toContain(name);
    }
  });
});
