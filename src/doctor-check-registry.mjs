function defineDoctorCheck({ id, phase = "doctor", run, when = null }) {
  if (!isNonEmptyString(id)) throw new Error("Doctor check id is required.");
  if (!isNonEmptyString(phase)) throw new Error(`Doctor check "${id}" needs a phase.`);
  if (typeof run !== "function") throw new Error(`Doctor check "${id}" needs a run function.`);
  if (when != null && typeof when !== "function") throw new Error(`Doctor check "${id}" has a non-function when predicate.`);

  return Object.freeze({
    id: id.trim(),
    phase: phase.trim(),
    run,
    when,
  });
}

export function createDoctorCheckRegistry(checks, { registryId = "doctor" } = {}) {
  if (!Array.isArray(checks)) throw new Error(`Doctor check registry "${registryId}" must be an array.`);
  const seen = new Map();
  const normalized = checks.map((check, index) => {
    if (!check || typeof check !== "object") {
      throw new Error(`Doctor check registry "${registryId}" has a non-object check at index ${index}.`);
    }
    const doctorCheck = defineDoctorCheck(check);
    if (seen.has(doctorCheck.id)) {
      throw new Error(`Doctor check registry "${registryId}" has duplicate check id "${doctorCheck.id}".`);
    }
    seen.set(doctorCheck.id, doctorCheck);
    return doctorCheck;
  });
  return Object.freeze(normalized);
}

export function runDoctorCheckRegistry(checks, context) {
  const executed = [];
  for (const check of checks) {
    if (check.when && !check.when(context)) continue;
    check.run(context);
    executed.push(check.id);
  }
  return executed;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
