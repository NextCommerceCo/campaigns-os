#!/usr/bin/env node
/**
 * The repository's pre-push gate, installed by `npm run hooks:install`. Before
 * a push it runs the fast local gates (scripts/check-fast.mjs) on each branch
 * commit being pushed and refuses the push when one fails, so a changelog,
 * ledger or version slip shows up in a minute rather than after a CI run.
 *
 * It checks the commit being pushed, not the working tree: in place when the
 * checkout is clean and at that commit, otherwise in a temporary worktree.
 * Tag pushes and branch deletions are not checked. CAMPAIGNS_OS_PREPUSH=skip
 * skips it for one push; `git push --no-verify` skips every hook. CI runs the
 * same gates either way.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The distinct branch commits in git's pre-push input, which is one `<local ref> <local sha> <remote ref> <remote sha>` per line. */
export function commitsToCheck(input) {
  const commits = [];
  for (const line of input.split("\n")) {
    const [localRef, localSha] = line.trim().split(/\s+/);
    if (!localRef?.startsWith("refs/heads/") || !/^[0-9a-f]{40,64}$/.test(localSha ?? "") || /^0+$/.test(localSha)) continue;
    if (!commits.includes(localSha)) commits.push(localSha);
  }
  return commits;
}

// Git exports GIT_DIR and its relatives to hooks. A git command run against
// another worktree must not inherit them, or it reads the pushing checkout.
const GIT_LOCATION_VARS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
]);
export function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !GIT_LOCATION_VARS.has(key)));
}

function main() {
  if (process.env.CAMPAIGNS_OS_PREPUSH === "skip") {
    console.error("pre-push: CAMPAIGNS_OS_PREPUSH=skip, so the fast gates did not run");
    return 0;
  }
  const commits = commitsToCheck(readFileSync(0, "utf8"));
  if (commits.length === 0) return 0;

  const env = childEnv(process.env);
  const run = (command, args, cwd, stdio = "inherit") => spawnSync(command, args, { cwd, env, stdio, encoding: "utf8" });
  const read = (args) => run("git", args, root, "pipe").stdout?.trim() ?? "";
  run("git", ["fetch", "--quiet", "origin", "main"], root);

  let failed = false;
  for (const commit of commits) {
    const short = commit.slice(0, 7);
    const inPlace = read(["rev-parse", "HEAD"]) === commit && read(["status", "--porcelain"]) === "" && existsSync(join(root, "node_modules"));
    if (inPlace) {
      console.error(`pre-push: fast gates on ${short}`);
      failed = run(process.execPath, ["scripts/check-fast.mjs", "--no-fetch"], root).status !== 0 || failed;
      continue;
    }
    const parent = mkdtempSync(join(tmpdir(), "campaigns-os-prepush-"));
    const tree = join(parent, "tree");
    try {
      if (run("git", ["worktree", "add", "--detach", "--quiet", tree, commit], root).status !== 0) {
        console.error(`pre-push: could not check out ${short} to test it`);
        failed = true;
        continue;
      }
      if (!existsSync(join(tree, "scripts/check-fast.mjs"))) {
        console.error(`pre-push: ${short} predates scripts/check-fast.mjs, so it is not checked`);
        continue;
      }
      console.error(`pre-push: fast gates on ${short}, in a temporary worktree (this checkout has other changes)`);
      const installed = run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--loglevel=error"], tree);
      failed = installed.status !== 0 || run(process.execPath, ["scripts/check-fast.mjs", "--no-fetch"], tree).status !== 0 || failed;
    } finally {
      run("git", ["worktree", "remove", "--force", tree], root, "ignore");
      rmSync(parent, { recursive: true, force: true });
    }
  }
  if (failed) {
    console.error("pre-push: push refused. Fix the failures above, or skip this gate with `git push --no-verify` (CI still runs it).");
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
