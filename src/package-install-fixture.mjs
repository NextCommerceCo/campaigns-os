// Test fixture: a REAL package install of this checkout, staged under a
// temporary install root, so a test can run the CLI the way a consumer's
// `npx campaigns-os …` does (install mode detected from the enclosing
// node_modules, pinned commit read from the lockfile npm would have written).
// Shared by the tooling-status and page-kit sync suites; not part of the
// supported surface.
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const PIN_SHA = "236d7fc454c877e3c07337237ee9e19303c5cc15";

export function stageRealPackageInstall(installRoot) {
  const pkgRoot = join(installRoot, "node_modules", "@nextcommerce", "campaigns-os");
  mkdirSync(pkgRoot, { recursive: true });
  for (const entry of ["agents", "bin", "src", "campaign-spec", "contracts", "schemas", "skills", "skills.json", "package.json"]) {
    cpSync(join(ROOT, entry), join(pkgRoot, entry), { recursive: true, dereference: true });
  }
  symlinkSync(join(ROOT, "node_modules"), join(pkgRoot, "node_modules"), "dir");
  writeFileSync(join(installRoot, "node_modules", ".package-lock.json"), JSON.stringify({
    name: "npx",
    lockfileVersion: 3,
    packages: {
      "node_modules/@nextcommerce/campaigns-os": {
        version: "0.1.0-alpha.0",
        resolved: `git+ssh://git@github.com/NextCommerceCo/campaigns-os.git#${PIN_SHA}`,
      },
    },
  }));
  return pkgRoot;
}
