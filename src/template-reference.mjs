function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const UNRESOLVED_TEMPLATE_FAMILIES = Object.freeze(["auto", "undecided"]);

export function isUnresolvedTemplateFamily(value) {
  const family = nonEmptyString(value);
  return !family || UNRESOLVED_TEMPLATE_FAMILIES.includes(family);
}

export const TEMPLATE_FAMILY_FLAG_SOURCE = "--template-family";
export const TEMPLATE_FAMILY_HINT_SOURCE = "CampaignSpec preferred_template_family";

/**
 * Resolve the template family an entry-point command will build on, from the
 * two channels an operator has: the `--template-family` flag and the
 * CampaignSpec authoring hint. The flag wins — that was always the behaviour
 * (docs/build-packet.md "Authoring-Time Hints") — but it used to win in
 * silence, so a spec hinting one family and a flag naming another produced a
 * packet with no trace of the discarded hint. The resolution is returned as
 * data, including `overridden`, so the caller can say which value won.
 */
export function resolveTemplateFamilySelection({ flag = null, hint = null } = {}) {
  const flagValue = nonEmptyString(flag);
  const hintValue = nonEmptyString(hint);
  const value = flagValue || hintValue || "undecided";
  const source = flagValue
    ? TEMPLATE_FAMILY_FLAG_SOURCE
    : hintValue
      ? TEMPLATE_FAMILY_HINT_SOURCE
      : "default";
  return {
    value,
    source,
    flag: flagValue,
    hint: hintValue,
    // Only a disagreement is an override. A flag that merely repeats the hint
    // confirms it, and warning there would train operators to ignore the line.
    overridden: Boolean(flagValue && hintValue && flagValue !== hintValue),
  };
}

/**
 * Resolve the selected catalog family into the input shape consumed by the
 * Design Source Package synthesizer. A family without published proof remains
 * a family-only input so the DSP emits its existing missing-reference blocker.
 */
export function resolveTemplateFamilyDesignSource(catalog, family) {
  const normalizedFamily = nonEmptyString(family);
  if (isUnresolvedTemplateFamily(normalizedFamily)) return null;

  const entry = isObject(catalog?.families?.[normalizedFamily])
    ? catalog.families[normalizedFamily]
    : null;
  const reference = isObject(entry?.templateReference)
    ? entry.templateReference
    : isObject(entry?.template_reference)
      ? entry.template_reference
      : null;
  if (!reference) return { family: normalizedFamily };

  const referenceFamily = nonEmptyString(reference.family);
  if (referenceFamily && referenceFamily !== normalizedFamily) {
    throw new TypeError(
      `Template Reference family ${JSON.stringify(referenceFamily)} does not match selected family ` +
        `${JSON.stringify(normalizedFamily)}.`,
    );
  }

  const version = nonEmptyString(reference.version);
  return {
    family: normalizedFamily,
    ...(version ? { version } : {}),
    template_reference: structuredClone(reference),
  };
}
