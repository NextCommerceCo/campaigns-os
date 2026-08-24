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
