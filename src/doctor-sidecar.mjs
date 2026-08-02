import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DOCTOR_SIDECAR_REL_PATH = ".campaign-runtime/doctor-output.json";

export function doctorSidecarPath(targetBaseDir) {
  return join(targetBaseDir, DOCTOR_SIDECAR_REL_PATH);
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
  // Atomic tmp+rename, matching the assembly-report write discipline: a torn
  // sidecar would itself break the freshness contract this stamp implements.
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stamped, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}
