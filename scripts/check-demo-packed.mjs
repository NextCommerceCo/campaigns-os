// Installed-package proof: no optional browser or maintainer toolchain present.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDemoArtifact } from "../src/demo-artifact.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "campaigns-os-demo-packed-"));
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
  const consumer = join(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--save-dev", "--save-exact", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", join(scratch, packed.filename)], { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] });
  for (const name of ["next-campaign-page-kit", "tailwindcss", "playwright"]) assert.equal(existsSync(join(consumer, "node_modules", name)), false, name);
  const installed = join(consumer, "node_modules/@nextcommerce/campaigns-os");
  assert.equal(existsSync(join(installed, "scripts/demo-toolchain")), false);
  const output = execFileSync(process.execPath, [join(installed, "bin/campaigns-os.mjs"), "demo", "--target", "./sample"], { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(output, /Offline sample only; no campaign evidence/);
  assert.match(output, /landing[/\\]index\.html/);
  const source = validateDemoArtifact(join(root, "demo/apollo-v0"));
  const sample = validateDemoArtifact(join(consumer, "sample"));
  assert.equal(sample.files.size, source.files.size);
  for (const [name, bytes] of source.files) assert.equal(sample.files.get(name).equals(bytes), true, name);
  console.log(JSON.stringify({ result: "pass", files: sample.files.size, optional_browser: "absent", page_kit: "absent", css_compiler: "absent" }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
