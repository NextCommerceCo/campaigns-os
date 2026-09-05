# Slice 7 remote review disposition

Kilobot reviewed `8b0c32b` on PR #291 and raised three future compatibility concerns.

- Dependency install scripts are intentionally suppressed by the runtime recipe.
  The existing `check-runtime-recipe` CI check compares lockfile `hasInstallScript`
  dependencies with the recipe's declared list (currently fsevents); a new scripted
  dependency fails that check and needs review. It is not silently accepted.
- The fast pack path now refuses nonempty prepack/postpack hooks before invoking
  npm, because ignore-scripts would skip them. Standalone packing remains available.
  The opt-in real-pack test proves both hooks fail closed without running a hook
  or compiler. This prevents future CI/standalone packaging drift.
- The expensive packaging integration test remains outside default CI. A file-level
  comment now records why, alongside the existing optimization procedure. Changes
  to this boundary should explicitly run `node --test scripts/check-pack.test.mjs`.
