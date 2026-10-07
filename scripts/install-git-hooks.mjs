#!/usr/bin/env node
/**
 * Installs the pre-push gate (scripts/pre-push.mjs) for this clone and every
 * worktree of it, since git keeps hooks in the clone's shared hooks directory.
 *
 *   npm run hooks:install
 *
 * When a pre-push hook that runs `pre-push.local` is already installed (some
 * hook managers generate one), the gate is installed as `pre-push.local` and
 * that hook stays. Without a pre-push hook the gate becomes the hook. Any other
 * pre-push hook is left alone, and the command prints what to add to it.
 * Remove the gate by deleting the file it names.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const MARKER = "# campaigns-os pre-push gate";

// The gate resolves scripts/pre-push.mjs in whichever checkout is pushing, so a
// worktree on a branch from before the gate existed pushes unchecked.
export const SHIM = `#!/bin/sh
${MARKER}, installed by \`npm run hooks:install\`.
script="$(git rev-parse --show-toplevel)/scripts/pre-push.mjs"
[ -f "$script" ] || exit 0
exec node "$script" "$@"
`;

/** Where the gate goes, given the current hook files' contents (null when absent). */
export function planInstall({ prePush, prePushLocal }) {
  if (prePush === null || prePush.includes(MARKER)) return { file: "pre-push" };
  // An existing hook that already hands its input to pre-push.local.
  if (prePush.includes("pre-push.local")) {
    if (prePushLocal === null || prePushLocal.includes(MARKER)) return { file: "pre-push.local" };
    return { refusal: "pre-push.local already holds another hook" };
  }
  return { refusal: "pre-push is a hook this command does not manage" };
}

function main() {
  const located = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: root, encoding: "utf8" });
  if (located.status !== 0) {
    console.error("hooks:install: not inside a git checkout");
    return 1;
  }
  const hooks = located.stdout.trim();
  const read = (name) => (existsSync(join(hooks, name)) ? readFileSync(join(hooks, name), "utf8") : null);
  const plan = planInstall({ prePush: read("pre-push"), prePushLocal: read("pre-push.local") });
  if (plan.refusal) {
    console.error(`hooks:install: ${plan.refusal} (${hooks}), so nothing was installed.`);
    console.error('Add this line to that hook to run the gate, passing the hook\'s input through:\n  node "$(git rev-parse --show-toplevel)/scripts/pre-push.mjs" "$@"');
    return 1;
  }
  const target = join(hooks, plan.file);
  writeFileSync(target, SHIM);
  chmodSync(target, 0o755);
  console.log(`hooks:install: the pre-push gate is installed at ${target}`);
  console.log("Every push from this clone and its worktrees now runs `npm run check:fast` on the pushed commit first.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
