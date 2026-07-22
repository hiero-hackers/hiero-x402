// SPDX-License-Identifier: Apache-2.0
// Regenerates the README's receipt screenshots from real demo output, via
// headless Chrome — reproducible output, not relics.
//   receipt.html           from `npm run e2e`          → docs/receipt.png
//   verified-receipt.html  from `npm run provenance`   → docs/verified-receipt.png
//   node scripts/screenshots.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = [
  ["receipt.html", "docs/receipt.png", 920, "npm run e2e"],
  ["verified-receipt.html", "docs/verified-receipt.png", 820, "npm run provenance"],
];

mkdirSync("docs", { recursive: true });
for (const [source, out, height, producer] of SHOTS) {
  if (!existsSync(source)) {
    console.error(`no ${source} — run \`${producer}\` first`);
    process.exitCode = 1;
    continue;
  }
  execFileSync(CHROME, [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    `--window-size=640,${height}`,
    "--virtual-time-budget=2000",
    `--screenshot=${out}`,
    `file://${resolve(source)}`,
  ]);
  console.log(`✓ ${out}`);
}
