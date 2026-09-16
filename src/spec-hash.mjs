// ---------------------------------------------------------------------------
// Spec-hash identity comparison.
//
// A spec hash reaches a comparison from several producers (the saved Map, a
// Build Context, an Assembly Report, a stored QA verdict, a pricing
// calculation envelope) and they do not all spell it the same way: some carry
// the `sha256:` prefix, some do not; some upper-case the hex; some carry
// surrounding whitespace. A raw string compare turns those spellings into a
// false "stale" or "mismatch", and a consumer that normalises differently can
// disagree with this toolkit about whether the same verdict matches the same
// spec. Every "is this the same spec?" check goes through these three
// functions so the answer is the same everywhere.
// ---------------------------------------------------------------------------

/**
 * Canonical form of a spec hash: trimmed, lower-cased, with one leading
 * `sha256:` removed. Returns null for any non-string, for empty/whitespace-only
 * input and for a bare prefix with nothing after it.
 */
export function normalizeSpecHash(value) {
  // Only a string can carry a hash. Numbers, booleans, NaN, objects and
  // arrays all stringify to something (`"nan"`, `"[object Object]"`) that two
  // unrelated malformed documents would share, so they never normalise.
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase().replace(/^sha256:/, "").trim();
  return text || null;
}

/**
 * True only when both sides normalise to a non-null value and those values
 * are equal. Two missing hashes are NOT a match: absence carries no identity,
 * and treating it as agreement would let an unhashed artifact pass as the
 * same spec.
 */
export function specHashesMatch(left, right) {
  const a = normalizeSpecHash(left);
  const b = normalizeSpecHash(right);
  return a != null && b != null && a === b;
}

/**
 * The spec hash a Map / CampaignSpec document carries, in either of the two
 * places producers put it: a top-level `spec_hash`, or `spec_identity.spec_hash`.
 * Returns the raw stored value (not normalised) or null.
 */
export function specHashOf(doc) {
  return doc?.spec_hash ?? doc?.spec_identity?.spec_hash ?? null;
}
