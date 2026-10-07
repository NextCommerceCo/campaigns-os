import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MARKER, SHIM, planInstall } from "./install-git-hooks.mjs";

// A hook manager's generated hook that hands its input on to pre-push.local.
const CHAINING = '#!/bin/sh\nlocal="$(git rev-parse --git-path hooks/pre-push.local)"\n[ -x "$local" ] && exec "$local" "$@"\n';

test("the gate goes beside a hook that runs pre-push.local, or becomes the hook, and never replaces another", () => {
  assert.deepEqual(planInstall({ prePush: null, prePushLocal: null }), { file: "pre-push" });
  assert.deepEqual(planInstall({ prePush: SHIM, prePushLocal: null }), { file: "pre-push" });
  assert.deepEqual(planInstall({ prePush: CHAINING, prePushLocal: null }), { file: "pre-push.local" });
  assert.deepEqual(planInstall({ prePush: CHAINING, prePushLocal: SHIM }), { file: "pre-push.local" });
  assert.match(planInstall({ prePush: CHAINING, prePushLocal: "#!/bin/sh\nexit 0\n" }).refusal, /pre-push.local already holds another hook/);
  assert.match(planInstall({ prePush: "#!/bin/sh\nmake lint\n", prePushLocal: null }).refusal, /does not manage/);
  assert.ok(SHIM.includes(MARKER));
});

test("the installed hook runs the pushing checkout's gate with git's input, and lets older checkouts push", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "campaigns-hook-shim-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "--quiet", repo]).status, 0);
  const hook = join(repo, "hook.sh");
  writeFileSync(hook, SHIM);
  const push = (input) => spawnSync("sh", [hook, "origin", "git@example.test:x.git"], { cwd: repo, input, encoding: "utf8" });

  assert.equal(push("refs/heads/x a refs/heads/x b\n").status, 0, "a checkout without scripts/pre-push.mjs pushes unchecked");

  mkdirSync(join(repo, "scripts"));
  writeFileSync(
    join(repo, "scripts/pre-push.mjs"),
    "import { readFileSync } from 'node:fs'; console.log(JSON.stringify([process.argv.slice(2), readFileSync(0, 'utf8')])); process.exit(3);",
  );
  const gated = push("refs/heads/x a refs/heads/x b\n");
  assert.equal(gated.status, 3, "the gate's exit status is the hook's");
  assert.deepEqual(JSON.parse(gated.stdout), [["origin", "git@example.test:x.git"], "refs/heads/x a refs/heads/x b\n"]);
});
