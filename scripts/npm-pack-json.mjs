// The tarball file name in `npm pack --json` output. npm 11 prints an array of
// packed packages, npm 12 an object keyed by package name; both name one
// tarball here. Throws when the output names none.
export function packedTarballName(packed) {
  const [entry] = Array.isArray(packed) ? packed : Object.values(packed ?? {});
  if (!entry?.filename) throw new Error(`npm pack --json named no tarball: ${JSON.stringify(packed)?.slice(0, 200)}`);
  return entry.filename;
}
