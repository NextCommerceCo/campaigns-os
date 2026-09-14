// Shared resolution of the campaign-cart-starter-templates checkout for the
// check scripts that read it (check-template-doctrine.mjs,
// check-slot-manifest.mjs). STARTER_TEMPLATES_PATH always wins and is never
// silently substituted; otherwise prefer the sibling of this checkout, and in
// a linked git worktree (e.g. .claude/worktrees/<name>, whose parent directory
// is inside the main repo) fall back to the sibling of the main checkout,
// which --git-common-dir locates from any worktree.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function resolveStarterTemplatesRoot(root) {
  const override = process.env.STARTER_TEMPLATES_PATH;
  if (override !== undefined) {
    // Set-but-empty is an explicit override too — resolve("") would silently
    // mean cwd, and falling through would silently mean auto-discovery.
    if (override.trim() === "") {
      throw new Error(
        "STARTER_TEMPLATES_PATH is set but empty; unset it or point it at a campaign-cart-starter-templates checkout.",
      );
    }
    return resolve(override);
  }
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

// The checkout to validate against, held to the commit the vendored catalog
// was synced from. CI checks the templates repository out at that commit and
// hands it over through STARTER_TEMPLATES_PATH; a local sibling checkout is
// usually somewhere else on its history, so a check that read its HEAD would
// be validating partials CI never sees. Without an override, a sibling that
// is not at the pin is read at the pin through `git archive` (its working
// tree is never touched); only when that commit is not available locally
// does the sibling's own tree stand in, and the caller says so loudly.
//
// Returns { path, kind, pinSha, headSha, reason, cleanup } where kind is one of
// override | sibling_at_pin | pinned_archive | sibling_unpinned | sibling
// (the last: no pin was given, or the sibling is not a git checkout).
export function resolveStarterTemplatesSource(root, { pinSha = null } = {}) {
  const path = resolveStarterTemplatesRoot(root);
  const result = { path, kind: "sibling", pinSha, headSha: null, reason: null, cleanup() {} };
  if (process.env.STARTER_TEMPLATES_PATH !== undefined) return { ...result, kind: "override" };
  if (!pinSha || !existsSync(path)) return result;
  try {
    result.headSha = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return result;
  }
  if (result.headSha === pinSha) return { ...result, kind: "sibling_at_pin" };
  const work = mkdtempSync(join(tmpdir(), "starter-templates-pin-"));
  try {
    const archive = join(work, "src.tar");
    execFileSync("git", ["-C", path, "archive", "--format=tar", "-o", archive, pinSha, "src"], { stdio: ["ignore", "ignore", "pipe"] });
    execFileSync("tar", ["-xf", archive, "-C", work]);
    rmSync(archive);
    return { ...result, path: work, kind: "pinned_archive", cleanup: () => rmSync(work, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    const stderr = typeof error.stderr === "string" ? error.stderr : error.stderr?.toString() ?? "";
    return { ...result, kind: "sibling_unpinned", reason: (stderr.trim() || error.message).split("\n")[0] };
  }
}
