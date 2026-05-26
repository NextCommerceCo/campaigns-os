/**
 * Shared constants for the source-html-manifest contract.
 *
 * Imported by:
 *   - src/cli.mjs        (consumer: doctor + prepare-build)
 *   - scripts/reference-ai-producer.mjs (producer)
 *   - any future producer that ships in this repo
 *
 * External producers (figma-sections-export, custom AI agents, etc.)
 * embed these values directly in their own code — they're a public
 * contract, not an implementation detail. When they change, both
 * sides of the seam ship at the same time via coordinated PRs.
 *
 * The point of this module is just to keep the two in-repo callers
 * lockstep so a schema bump (v0 → v1) doesn't half-update.
 */

export const SOURCE_HTML_MANIFEST_REL_PATH = ".campaigns-os/source-html-manifest.json";
export const SOURCE_HTML_MANIFEST_SCHEMA = "source-html-manifest/v0";
