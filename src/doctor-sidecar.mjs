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

// #312: every retained sidecar names the command that persisted it, the way
// a stale stamp already names the command that made it (`stale_marked_by`).
// `generated_at` alone cannot tell a fresh `doctor --write` from a two-day-old
// gitignored copy carried along by `cp -R` — which is exactly what got a
// read-only command accused of writing this file. The name is threaded from
// the producer that knows it (its own argv word), never inferred here, and a
// producer that forgets to say who it is fails loudly rather than writing an
// anonymous artifact. Placed beside `generated_at` so the two read together.
export function stampDoctorProducer(doctor, command) {
  if (typeof command !== "string" || !command.trim()) {
    throw new TypeError("stampDoctorProducer requires command: the retained doctor sidecar names the command that produced it (generated_by).");
  }
  if (!doctor || typeof doctor !== "object" || Array.isArray(doctor)) {
    throw new TypeError("stampDoctorProducer requires a doctor result object.");
  }
  const { schema_version, generated_at, generated_by: _previous, ...rest } = doctor;
  return {
    ...(schema_version !== undefined ? { schema_version } : {}),
    ...(generated_at !== undefined ? { generated_at } : {}),
    generated_by: command.trim(),
    ...rest,
  };
}

// The one writer of the retained doctor sidecar: a wholesale, atomic rewrite
// of a doctorPacket result stamped with its producer. Every producer —
// `doctor --write`, `next`, `start`/`build`, the QA stage refresh — goes
// through this (or through `stampDoctorProducer` when its own transactional
// writer must do the rename), so `generated_by` cannot be skipped by one of
// them the way #327's cause labels once were.
export function writeDoctorSidecar(path, doctor, { command } = {}) {
  writeJsonAtomic(path, stampDoctorProducer(doctor, command));
  return path;
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

// The retained doctor sidecar records its own verdict twice: `ok` (boolean)
// and `status` ("ready", "ready_with_warnings", "ready_with_waivers",
// "blocked"). A bundle consumer must read that verdict rather than treat the
// sidecar's presence, schema validity, or freshness as readiness: a blocked
// doctor run is a perfectly well-formed artifact whose content says the
// campaign cannot proceed. Either signal blocks; a sidecar that is not an
// object reports nothing (its shape is the schema check's job, not this one's).
export function doctorSidecarBlocked(sidecar) {
  if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) return false;
  return sidecar.status === "blocked" || sidecar.ok === false;
}
