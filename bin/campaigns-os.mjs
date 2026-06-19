#!/usr/bin/env node

import { main } from "../src/cli.mjs";

// Filesystem errno codes worth a friendly, path-named message instead of the
// raw Node error string. Each maps to a short human phrase.
const FS_ERRNO_HINT = {
  ENOENT: "file not found",
  EACCES: "permission denied reading",
  EPERM: "operation not permitted on",
  EISDIR: "expected a file but found a directory",
  ENOTDIR: "expected a directory in the path to",
};

main(process.argv.slice(2)).catch((error) => {
  // Rewrite raw Node filesystem errno errors (e.g. a mistyped or unreadable
  // --packet path) into a message that names the path and the likely fix,
  // instead of leaking bare errno strings like
  // `ENOENT: no such file or directory, open '...'`.
  const fsHint = error && error.code ? FS_ERRNO_HINT[error.code] : null;
  if (fsHint) {
    // `error.path` is present for open-time failures (ENOENT/EACCES/EPERM/
    // ENOTDIR) but absent for read-time ones (EISDIR reading a directory), so
    // name the path only when we have it.
    const where = typeof error.path === "string" ? `: ${error.path}` : "";
    console.error(
      `campaigns-os: ${fsHint}${where}. Check the path; ` +
        "run `campaigns-os start ...` first if you have not generated the packet yet.",
    );
    process.exit(1);
  }
  console.error(`campaigns-os: ${error.message}`);
  process.exit(1);
});
