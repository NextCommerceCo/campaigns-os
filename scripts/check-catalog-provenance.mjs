#!/usr/bin/env node

/**
 * Contract check: the vendored starter-template catalog snapshot must record the
 * exact source commit it was built from (`_synced_from_sha`), so portal/agent
 * consumers read a known-fresh snapshot and CI can pin the doctrine check to the
 * same commit instead of validating against drifting live HEAD.
 *
 * Policy (ratchet):
 *   - `_synced_from_sha` PRESENT  -> hard-validate it is a 40-char commit SHA and
 *     that `_synced_from_repo` is set. Malformed provenance FAILS.
 *   - `_synced_from_sha` ABSENT   -> WARN and pass. Legacy snapshots predate the
 *     refresh script's stamping; the next `refresh:starter-catalog` run stamps it,
 *     after which presence is guaranteed. (This keeps the gate mergeable without
 *     fabricating provenance for a snapshot whose true source commit is unknown.)
 *
 * The refresh script (scripts/refresh-starter-template-catalog.mjs) is what writes
 * the field; this check is the gate that keeps it well-formed once present.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;

export function validateProvenance(catalog) {
  const errors = [];
  const warnings = [];

  const sha = catalog?._synced_from_sha;
  if (sha === undefined || sha === null) {
    warnings.push(
      "no `_synced_from_sha` recorded — legacy snapshot. The next `npm run refresh:starter-catalog` " +
        "run will stamp it; provenance becomes enforced once present.",
    );
    return { ok: true, errors, warnings };
  }

  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    errors.push(`\`_synced_from_sha\` must be a 40-char commit SHA, got: ${JSON.stringify(sha)}`);
  }
  if (typeof catalog._synced_from_repo !== "string" || catalog._synced_from_repo.length === 0) {
    errors.push("`_synced_from_sha` is set but `_synced_from_repo` is missing — record the source repo too.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

function main() {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const catalogPath = resolve(root, "contracts/commerce-surface-catalog.json");
  if (!existsSync(catalogPath)) {
    console.error(`check-catalog-provenance: missing ${catalogPath}`);
    process.exit(1);
  }

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch (error) {
    console.error(`check-catalog-provenance: ${catalogPath} is not valid JSON: ${error.message}`);
    process.exit(1);
  }

  const { ok, errors, warnings } = validateProvenance(catalog);
  for (const w of warnings) console.warn(`check-catalog-provenance: note: ${w}`);

  if (!ok) {
    console.error(`check-catalog-provenance: ${errors.length} provenance error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "\nThe catalog snapshot is refreshed by scripts/refresh-starter-template-catalog.mjs, " +
        "which stamps `_synced_from_*`. Re-run `npm run refresh:starter-catalog` rather than hand-editing.",
    );
    process.exit(1);
  }

  if (catalog._synced_from_sha) {
    console.log(
      `Catalog provenance check passed (_synced_from_sha=${catalog._synced_from_sha} ` +
        `from ${catalog._synced_from_repo}@${catalog._synced_from_ref ?? "?"}).`,
    );
  } else {
    console.log("Catalog provenance check passed (legacy snapshot, not yet stamped).");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main();
}
