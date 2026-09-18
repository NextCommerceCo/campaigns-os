import { mkdirSync, openSync, fstatSync, lstatSync, writeFileSync, closeSync, unlinkSync, rmdirSync, realpathSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDemoArtifact } from "./demo-artifact.mjs";

const BUNDLE = fileURLToPath(new URL("../demo/apollo-v0", import.meta.url));
const TARGET_CHANGED_MESSAGE = "demo.target_changed: destination changed during copy; inspect and preserve its files, then retry with a different new directory";
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
function owns(path, stat) {
  try { const current = lstatSync(path); return !current.isSymbolicLink() && same(current, stat); } catch { return false; }
}

export function resolveDemoTarget(target, { resolveParent = realpathSync } = {}) {
  if (typeof target !== "string" || !target.trim()) throw Error("demo.target_required: use --target <new-directory>");
  const destination = resolve(target), name = basename(destination);
  if (!name) throw Error("demo.target_invalid: choose a new directory below an existing parent");
  return join(resolveParent(dirname(destination)), name);
}

// Exclusive creation only. Failure cleanup removes precisely the entries this
// invocation created, and never recursively removes a caller's directory.
export function createDemo(target, { bundle = BUNDLE, writeBytes = writeFileSync } = {}) {
  if (typeof target !== "string" || !target.trim()) throw Error("demo.target_required: use --target <new-directory>");
  const artifact = validateDemoArtifact(bundle);
  // Resolve the existing parent once; mkdir remains exclusive at the final
  // component, so an existing directory, file or symlink cannot be overwritten.
  const root = resolveDemoTarget(target);
  const directories = [], files = [];
  function directory(path) {
    mkdirSync(path);
    const stat = lstatSync(path);
    directories.push({ path, stat });
    return stat;
  }
  let rootStat;
  try { rootStat = directory(root); } catch (error) {
    if (error.code === "EEXIST") throw Error("demo.target_exists: choose a new directory; demo never merges or overwrites");
    throw error;
  }
  const created = new Map([[root, rootStat]]);
  try {
    for (const [name, bytes] of artifact.files) {
      const path = join(root, name);
      const parts = name.split("/"); parts.pop();
      let current = root;
      for (const part of parts) {
        if (!owns(current, created.get(current))) throw Error(TARGET_CHANGED_MESSAGE);
        current = join(current, part);
        if (!created.has(current)) created.set(current, directory(current));
      }
      if (!owns(current, created.get(current))) throw Error(TARGET_CHANGED_MESSAGE);
      const fd = openSync(path, "wx");
      try {
        files.push({ path, stat: fstatSync(fd) });
        writeBytes(fd, bytes);
      } finally { closeSync(fd); }
    }
  } catch (error) {
    for (const entry of files.reverse()) if (owns(entry.path, entry.stat)) { try { unlinkSync(entry.path); } catch {} }
    for (const entry of directories.reverse()) if (owns(entry.path, entry.stat)) { try { rmdirSync(entry.path); } catch {} }
    throw error;
  }
  return { index: join(root, "landing", "index.html"), files: artifact.files.size };
}

export function demoArguments(args, argv = null) {
  if (argv) {
    const tokens = argv[0] === "campaigns-os" ? argv.slice(1) : argv;
    const seen = new Set();
    for (let index = 1; index < tokens.length; index++) {
      const flag = tokens[index];
      if (!["--target", "--help"].includes(flag) || seen.has(flag)) throw Error("demo.unsupported_arguments: only one --target and --help are supported");
      seen.add(flag);
      if (flag === "--target") {
        if (!tokens[index + 1] || tokens[index + 1].startsWith("--")) throw Error("demo.target_required: use --target <new-directory>");
        index++;
      }
    }
  }
  const unsupported = Object.keys(args).filter(name => !["_", "target", "help"].includes(name));
  if (unsupported.length || args._.length !== 1 || (args.help !== undefined && args.help !== true)) throw Error("demo.unsupported_arguments: supported usage is demo --target <new-directory> or demo --help; no-write and dry-run are unsupported");
  if (args.help) return null;
  if (typeof args.target !== "string" || !args.target.trim()) throw Error("demo.target_required: use --target <new-directory>");
  return args.target;
}
