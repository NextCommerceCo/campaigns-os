#!/usr/bin/env node
// Exercise the published tarball in real npm consumers, outside this checkout's
// module tree. Check both npm hoisting and a consumer with a conflicting version.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// CI builds before this check. Standalone runs must not silently pack absent output.
for (const entry of ["index.js", "index.d.ts"]) {
  if (!existsSync(join(root, "campaign-spec/dist", entry))) {
    throw new Error(`campaign-spec/dist/${entry} is missing; run npm run build:spec before check:consumer`);
  }
}
const scratch = mkdtempSync(join(tmpdir(), "campaigns-os-consumer-"));
const locked = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages["node_modules/playwright"].version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command, args, cwd, env = process.env) => execFileSync(command, args, {
  cwd, env, stdio: "inherit", timeout: 900_000,
});
try {
  const packed = JSON.parse(execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], {
    cwd: root, encoding: "utf8", timeout: 60_000,
  }));
  const tarball = join(scratch, packed[0].filename);
  for (const [label, version] of [["shared", locked], ["separate", "1.62.1"], ["latest", "latest"]]) {
    const consumer = join(scratch, label);
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({
      name: `consumer-${label}`, version: "1.0.0", private: true, type: "module",
      dependencies: { "@nextcommerce/campaigns-os": `file:${tarball}`, playwright: version },
      ...(label === "shared" ? { overrides: { playwright: "$playwright" } } : {}),
    }));
    run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
    // Use the actual installed command, with the same browser directory for
    // installation and launch. Never rely on the developer's cached Chromium.
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(consumer, "browsers") };
    run(process.execPath, ["node_modules/@nextcommerce/campaigns-os/bin/campaigns-os.mjs", "qa", "install-browser"], consumer, env);
    writeFileSync(join(consumer, "proof.mjs"), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { validateSpec } from '@nextcommerce/campaigns-os/campaign-spec';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const host = createRequire(import.meta.url);
const packageJson = host.resolve('@nextcommerce/campaigns-os/package.json');
const owned = createRequire(packageJson);
assert.ok(existsSync(join(dirname(packageJson), 'campaign-spec/dist/index.d.ts')), 'published TypeScript declarations must be present');
assert.equal(validateSpec({})[0]?.ruleId, 'Normalize', 'compiled public entry must resolve and run');
const hostPath = host.resolve('playwright/package.json');
const ownedPath = owned.resolve('playwright/package.json');
if (${JSON.stringify(label)} === 'shared') assert.equal(ownedPath, hostPath);
if (${JSON.stringify(label)} === 'separate') assert.notEqual(ownedPath, hostPath);
const { launchPackageChromium } = await import(pathToFileURL(join(dirname(packageJson), 'src/browser-launch.mjs')));
const browser = await launchPackageChromium({ onMissing: (kind, cause) => new Error(kind, { cause }) });
try {
  assert.equal(browser.browserType().executablePath(), owned('playwright').chromium.executablePath());
  const page = await browser.newPage();
  await page.setContent('<button>Consumer proof</button>');
  assert.equal(await page.getByRole('button').textContent(), 'Consumer proof');
  console.log(JSON.stringify({ scenario: ${JSON.stringify(label)}, host: host('playwright/package.json').version, campaignsOS: owned('playwright/package.json').version, chromium: browser.version() }));
} finally { await browser.close(); }
`);
    run(process.execPath, ["proof.mjs"], consumer, env);
  }
  console.log("Playwright consumer installation checks passed (shared, separate, latest).");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
