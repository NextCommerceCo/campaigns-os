// A cross-process exclusive lock held as a directory. mkdir is atomic, so of
// several processes exactly one creates the directory; it records its pid and
// a random token in owner.json and removes the directory when `fn` settles.
//
// A lock left behind by a process that died is recovered: the owner's pid no
// longer exists (or, for a process killed before it wrote owner.json, the
// directory is old), and one waiter claims recovery exclusively before
// renaming the abandoned lock away. An interrupted recovery claim fails closed
// rather than being stolen, which would reintroduce a check/rename race.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const readOwner = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

function writeOwner(path, value) {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function withDirectoryLock(path, fn, { budgetMs, unavailable }) {
  const start = Date.now();
  const token = randomBytes(16).toString("hex");
  const abandoned = (unownedMtime = null) => {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const owner = readOwner(join(path, "owner.json"));
      if (Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.token === "string") {
        try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
      }
      // A killed process can leave the directory before writing its owner.
      // Give a live holder ample time to finish that tiny synchronous gap.
      return Date.now() - (unownedMtime ?? stat.mtimeMs) > 10000;
    } catch {
      return false;
    }
  };
  const recover = () => {
    if (!abandoned()) return;
    let originalMtime;
    try { originalMtime = lstatSync(path).mtimeMs; } catch { return; }
    const claim = join(path, ".recovery");
    try { mkdirSync(claim); writeOwner(join(claim, "owner.json"), { pid: process.pid, token }); } catch { return; }
    let moved = false;
    try {
      if (!abandoned(originalMtime)) return;
      const tomb = `${path}.abandoned-${token}`;
      renameSync(path, tomb);
      moved = true;
      rmSync(tomb, { recursive: true, force: true });
    } catch {
      // Leave the lock for the next waiter or the offline procedure.
    } finally {
      if (!moved && readOwner(join(claim, "owner.json"))?.token === token) {
        try { rmSync(claim, { recursive: true, force: true }); } catch {}
      }
    }
  };
  while (true) {
    try {
      mkdirSync(path);
      writeOwner(join(path, "owner.json"), { pid: process.pid, token });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() - start >= budgetMs) throw unavailable(error);
      recover();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await fn();
  } finally {
    if (readOwner(join(path, "owner.json"))?.token === token) rmSync(path, { recursive: true, force: true });
  }
}
