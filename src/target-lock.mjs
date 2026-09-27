// The per-target writer lock (#496, #501). prepare-build holds it from reading
// its inputs through publishing the packet, context and report; the stage
// writers (every commitAssemblyReport) hold it for their read-modify-write of
// the Assembly Report, so no stage evidence lands between prepare-build's
// pre-publish re-check and its rename. It lives beside the Design Source
// Package, inside the input directory prepare-build's writes already cover.
import { mkdirSync } from "node:fs";
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

function unavailable(targetRepo, lockPath, holder) {
  return (error) => error?.code === "EEXIST"
    ? new Error(
      `Another ${holder} is writing ${targetRepo} (lock ${lockPath}). `
      + "Retry after it finishes. If a run was interrupted, confirm no campaigns-os process is working on this target before removing that lock directory.",
    )
    : new Error(`Could not take the target lock at ${lockPath}${error?.code ? ` (${error.code})` : ""}: ${error?.message}`, { cause: error });
}

export function withTargetLock(targetRepo, fn, { holder = "campaigns-os writer", budgetMs = TARGET_LOCK_BUDGET_MS } = {}) {
  const lockPath = targetLockPath(targetRepo);
  mkdirSync(dirname(lockPath), { recursive: true });
  return withDirectoryLock(lockPath, fn, { budgetMs, unavailable: unavailable(targetRepo, lockPath, holder) });
}

export function withTargetLockSync(targetRepo, fn, { holder = "campaigns-os writer", budgetMs = TARGET_LOCK_BUDGET_MS } = {}) {
  const lockPath = targetLockPath(targetRepo);
  mkdirSync(dirname(lockPath), { recursive: true });
  return withDirectoryLockSync(lockPath, fn, { budgetMs, unavailable: unavailable(targetRepo, lockPath, holder) });
}
