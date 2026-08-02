// Shared resolution of the campaign-cart-starter-templates checkout for the
// check scripts that read it (check-template-doctrine.mjs,
// check-slot-manifest.mjs). STARTER_TEMPLATES_PATH always wins and is never
// silently substituted; otherwise prefer the sibling of this checkout, and in
// a linked git worktree (e.g. .claude/worktrees/<name>, whose parent directory
// is inside the main repo) fall back to the sibling of the main checkout,
// which --git-common-dir locates from any worktree.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function resolveStarterTemplatesRoot(root) {
  if (process.env.STARTER_TEMPLATES_PATH) return resolve(process.env.STARTER_TEMPLATES_PATH);
  const candidates = [resolve(root, "../campaign-cart-starter-templates")];
  try {
    const commonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (commonDir) candidates.push(resolve(dirname(commonDir), "../campaign-cart-starter-templates"));
  } catch {
    // Not a git checkout or git unavailable: the plain sibling candidate stands.
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
