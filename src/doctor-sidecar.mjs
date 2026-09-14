import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DOCTOR_SIDECAR_REL_PATH = ".campaign-runtime/doctor-output.json";
export const DOCTOR_SIDECAR_SCHEMA = "campaigns-os-doctor-output/v0";

export function doctorSidecarPath(targetBaseDir) {
  return join(targetBaseDir, DOCTOR_SIDECAR_REL_PATH);
}

// Atomic JSON write (tmp + rename) for the artifacts other commands may read
// concurrently: the assembly report, the doctor sidecar, a run session. A
// torn report would defeat the gate decision it records, and a torn sidecar
// would itself break the freshness contract the stale stamp implements.
export function writeJsonAtomic(path, value) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  const tmp = `${resolved}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, resolved);
}

// #171 v1 freshness contract for the retained doctor sidecar: commands that
// mutate doctor inputs WITHOUT recomputing doctor state (theme waive/generate,
// qa policy set) stamp the retained snapshot stale instead of leaving a green
// lie on disk, while commands that DO recompute (doctor, prepare-build/start,
// next) rewrite the sidecar wholesale — which clears any stale stamp.
export function markDoctorSidecarStale(targetBaseDir, { command = null, reason = null } = {}) {
  const path = doctorSidecarPath(targetBaseDir);
  if (!existsSync(path)) return null;
  let sidecar;
  try {
    sidecar = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) return null;
  const stamped = {
    ...sidecar,
    stale: true,
    stale_marked_by: command,
    stale_marked_at: new Date().toISOString(),
    stale_reason: reason
      || "A later command changed doctor inputs after this snapshot was written. Re-run campaigns-os doctor (or campaigns-os next) for current state.",
  };
  writeJsonAtomic(path, stamped);
  return path;
}
