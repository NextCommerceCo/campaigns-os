#!/usr/bin/env node

import { main } from "../src/cli.mjs";

// Filesystem errno codes worth a friendly, path-named message instead of the
// raw Node error string. Each maps `where` (": <path>" when known, else "")
// to a full message. Only ENOENT gets the "run start first" packet hint — for
// permission/type errors that guidance would be wrong, and EACCES is not
// read-specific (a write to an unwritable target raises it too).
const FS_ERRNO_MESSAGE = {
  ENOENT: (where) =>
    `file not found${where}. Check the path; ` +
    "run `campaigns-os start ...` first if you have not generated the packet yet.",
  EACCES: (where) => `permission denied accessing${where}. Check the file's permissions.`,
  EPERM: (where) => `operation not permitted on${where}. Check the file's permissions.`,
  EISDIR: (where) => `expected a file but found a directory${where}. Check the path.`,
  ENOTDIR: (where) => `a path segment is not a directory${where}. Check the path.`,
};

main(process.argv.slice(2)).catch((error) => {
  // Rewrite raw Node filesystem errno errors (e.g. a mistyped or unreadable
  // --packet path) into a clearer message, instead of leaking bare errno
  // strings like `ENOENT: no such file or directory, open '...'`.
  const buildMessage = error && error.code ? FS_ERRNO_MESSAGE[error.code] : null;
  if (buildMessage) {
    // `error.path` is present for open-time failures (ENOENT/EACCES/EPERM/
    // ENOTDIR) but absent for read-time ones (EISDIR reading a directory), so
    // name the path only when we have it.
    const where = typeof error.path === "string" ? `: ${error.path}` : "";
    console.error(`campaigns-os: ${buildMessage(where)}`);
    process.exit(1);
  }
  console.error(`campaigns-os: ${error.message}`);
  process.exit(1);
});
