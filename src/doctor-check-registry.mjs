function defineDoctorCheck({ id, phase = "doctor", run, when = null }, { registryId, index }) {
  const location = `Doctor check registry "${registryId}" check at index ${index}`;
  if (!isNonEmptyString(id)) throw new Error(`${location} needs a non-empty id.`);
  const checkLabel = `Doctor check registry "${registryId}" check "${id}"`;
  if (!isNonEmptyString(phase)) throw new Error(`${checkLabel} needs a phase.`);
  if (typeof run !== "function") throw new Error(`${checkLabel} needs a run function.`);
  if (when != null && typeof when !== "function") throw new Error(`${checkLabel} has a non-function when predicate.`);

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
    const doctorCheck = defineDoctorCheck(check, { registryId, index });
    if (seen.has(doctorCheck.id)) {
      throw new Error(`Doctor check registry "${registryId}" has duplicate check id "${doctorCheck.id}".`);
    }
    seen.set(doctorCheck.id, doctorCheck);
    return doctorCheck;
  });
  return Object.freeze(normalized);
}

export function runDoctorCheckRegistry(checks, context, { phase = null } = {}) {
  const phaseFilter = isNonEmptyString(phase) ? phase.trim() : null;
  const executed = [];
  for (const check of checks) {
    if (phaseFilter && check.phase !== phaseFilter) continue;
    if (check.when && !check.when(context)) continue;
    check.run(context);
    executed.push(check.id);
  }
  return executed;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
