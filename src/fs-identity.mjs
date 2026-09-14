// Path identity, answered once for every module that asks "is this the same
// file" or "which spelling of this path do I record".
//
// A path reached through a symlinked checkout and the same file reached
// directly are one file; two lexically different spellings of a path that
// does not exist cannot be shown to be one file. Every caller used to pick a
// policy for the second case on its own — one compared missing paths by
// spelling, another refused to treat them as equal — so the two decisions
// that key on packet identity (session join/refuse, context-to-report
// binding) could disagree on the same checkout. The policy is now an
// argument. A leaf: node built-ins only.

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// The path as the filesystem knows it: the real path when it exists, else
// the real path of its nearest existing ancestor with the missing tail
// re-appended. What run sessions, Run Record artifact refs and portable
// (`--strip-paths`) output record. Canonicalising only the side that exists
// is worse than canonicalising neither — a real base and a lexical target
// relativize to `../<link>/…` — so a path that is not there yet still
// resolves through the directory links above it.
export function canonicalPath(path) {
  const resolved = resolve(path);
  const missing = [];
  let cursor = resolved;
  for (;;) {
    try {
      return join(realpathSync(cursor), ...missing);
    } catch (error) {
      if (!absentOrMalformed(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolved;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

// The same file. Equal once resolved, or one file behind any symlinks. With
// `requireExisting`, a side that is not on disk is never the same file as
// anything spelled differently; without it, a missing path compares by its
// canonical spelling (the directory links above it resolved).
export function sameFile(left, right, { requireExisting = false } = {}) {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  if (!requireExisting) return canonicalPath(resolvedLeft) === canonicalPath(resolvedRight);
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch (error) {
      if (absentOrMalformed(error)) return null;
      throw error;
    }
  };
  const realLeft = real(resolvedLeft);
  return realLeft !== null && realLeft === real(resolvedRight);
}

// The errors a best-effort read may treat as "nothing there": the path is
// absent (ENOENT), a component of it is not a directory (ENOTDIR), or the
// bytes are not JSON (SyntaxError). A permission failure, EISDIR, EIO and

// every other error are not absence and must reach the caller.
export function absentOrMalformed(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR" || error instanceof SyntaxError;
}
