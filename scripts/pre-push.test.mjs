import assert from "node:assert/strict";
import test from "node:test";

import { canCheckInPlace, childEnv, commitsToCheck } from "./pre-push.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

test("checks each pushed branch commit once, and no tag or deletion", () => {
  assert.deepEqual(commitsToCheck(`refs/heads/feature ${A} refs/heads/feature ${B}\n`), [A]);
  assert.deepEqual(commitsToCheck(`refs/heads/one ${A} refs/heads/one ${ZERO}\nrefs/heads/two ${A} refs/heads/two ${ZERO}\nrefs/heads/three ${B} refs/heads/three ${ZERO}\n`), [A, B]);
  assert.deepEqual(commitsToCheck(`refs/tags/v1.55.0 ${A} refs/tags/v1.55.0 ${ZERO}\n`), []);
  assert.deepEqual(commitsToCheck(`(delete) ${ZERO} refs/heads/old ${B}\n`), []);
  assert.deepEqual(commitsToCheck(`refs/heads/old ${ZERO} refs/heads/old ${B}\n`), []);
  assert.deepEqual(commitsToCheck(""), []);
  assert.deepEqual(commitsToCheck("refs/heads/x not-a-sha refs/heads/x\n\n"), []);
});

test("child processes do not inherit the hook's repository location", () => {
  const env = childEnv({ PATH: "/bin", HOME: "/home/a", GIT_DIR: "/repo/.git/worktrees/x", GIT_WORK_TREE: "/repo", GIT_INDEX_FILE: "i", GIT_SSH_COMMAND: "ssh" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/a", GIT_SSH_COMMAND: "ssh" });
});

test("a commit is checked in place only in a clean checkout of it with current dependencies", () => {
  const ready = { head: A, commit: A, porcelain: "", lockfileMtime: 100, installedMtime: 200 };
  assert.equal(canCheckInPlace(ready), true);
  assert.equal(canCheckInPlace({ ...ready, head: B }), false, "another commit is checked out");
  assert.equal(canCheckInPlace({ ...ready, porcelain: "?? stray.log" }), false, "uncommitted changes");
  assert.equal(canCheckInPlace({ ...ready, installedMtime: null }), false, "nothing installed");
  assert.equal(canCheckInPlace({ ...ready, lockfileMtime: 300 }), false, "the lockfile changed after the last install");
});
