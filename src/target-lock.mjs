// The per-target writer lock (#496, #501). prepare-build holds it from reading
// its inputs through publishing the packet, context and report; the stage
// writers (every commitAssemblyReport) hold it for their read-modify-write of
// the Assembly Report, so no stage evidence lands between prepare-build's
// pre-publish re-check and its rename. It lives beside the Design Source
// Package, inside the input directory prepare-build's writes already cover.
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DESIGN_SOURCE_PACKAGE_REL_PATH } from "./design-source-package.mjs";
import { withDirectoryLock, withDirectoryLockSync } from "./directory-lock.mjs";

// Generous: a live holder is doing ordinary local work, and a holder that
// died is recovered by pid.
export const TARGET_LOCK_BUDGET_MS = 60000;

export function targetLockPath(targetRepo) {
  const designSourcePackagePath = resolve(targetRepo, DESIGN_SOURCE_PACKAGE_REL_PATH);
  return join(dirname(designSourcePackagePath), `.${basename(designSourcePackagePath)}.lock`);
}

// `command` names the waiting command. The lock does not record which command
// holds it, only a pid, so the holder is described generically. A lock with
// no owner record is called out on its own: it is never taken over, and the
// operator needs to know it will not clear by waiting. So is anything at the
// lock path that is not a lock at all, named by what it is (#514).
function unavailable(targetRepo, lockPath, command) {
  return (error) => {
    if (error?.code === "ENOTLOCK") {
      return new Error(
        `${command}: the target lock path ${lockPath} is occupied by ${error.obstruction}, not a campaigns-os lock. `
        + "It is never removed automatically. Move it out of the way, then retry.",
        { cause: error },
      );
    }
    if (error?.code !== "EEXIST") {
      return new Error(`${command} could not take the target lock at ${lockPath}${error?.code ? ` (${error.code})` : ""}: ${error?.message}`, { cause: error });
    }
    if (existsSync(lockPath) && !existsSync(join(lockPath, "owner.json"))) {
      return new Error(
        `${command}: the target lock at ${lockPath} has no owner record, so it is never taken over automatically `
        + "(an older campaigns-os release or an interrupted run left it). "
        + `Confirm no campaigns-os process is working on ${targetRepo}, then remove that lock directory and retry.`,
      );
    }
    return new Error(
      `${command}: another campaigns-os command is writing ${targetRepo} (lock ${lockPath}). `
      + "Retry after it finishes. If a run was interrupted, confirm no campaigns-os process is working on this target before removing that lock directory.",
    );
  };
}

export function withTargetLock(targetRepo, fn, { command = "campaigns-os", budgetMs = TARGET_LOCK_BUDGET_MS } = {}) {
  const lockPath = targetLockPath(targetRepo);
  mkdirSync(dirname(lockPath), { recursive: true });
  return withDirectoryLock(lockPath, fn, { budgetMs, unavailable: unavailable(targetRepo, lockPath, command) });
}

export function withTargetLockSync(targetRepo, fn, { command = "campaigns-os", budgetMs = TARGET_LOCK_BUDGET_MS } = {}) {
  const lockPath = targetLockPath(targetRepo);
  mkdirSync(dirname(lockPath), { recursive: true });
  return withDirectoryLockSync(lockPath, fn, { budgetMs, unavailable: unavailable(targetRepo, lockPath, command) });
}
