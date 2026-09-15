// Install-mode detection shared by `tooling status`, the printed `next`
// commands, and the browser-missing hints: where is this package running
// from, which commit is it pinned at, and how should a command be spelled so
// it runs THIS copy where the operator is.
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";

const PACKAGE_INSTALL_MODE_LABELS = Object.freeze({
  checkout: "git checkout",
  npx_cache: "package install (npx cache)",
  node_modules: "package install (node_modules)",
  package_directory: "package install",
});

const PUBLIC_GIT_SOURCE = "github:NextCommerceCo/campaigns-os";

function realpathOrSelf(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return path;
    throw error;
  }
}

// Is `root` the top level of its own git worktree? A package directory can
// sit INSIDE someone else's repository (a consumer's node_modules, a home
// directory under dotfiles control), and `git -C root` would happily answer
// for that outer repository. Only a root that IS the worktree top level is a
// checkout of this toolkit.
function isOwnGitCheckout(root) {
  const inside = runCommand("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") return false;
  const top = runCommand("git", ["-C", root, "rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout) return false;
  return realpathOrSelf(top.stdout) === realpathOrSelf(root);
}

// Locate the nearest enclosing `node_modules` directory, so the install root
// beside it can be read for the resolved package pin.
function enclosingNodeModules(root) {
  let cursor = root;
  for (;;) {
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    if (basename(parent) === "node_modules") return parent;
    cursor = parent;
  }
}

function pinFromResolved(resolved, version) {
  if (typeof resolved !== "string") return null;
  const match = resolved.match(/#([0-9a-f]{7,40})$/i);
  if (!match) return null;
  const commit = match[1].toLowerCase();
  const source = resolved.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:#|$)/i);
  return {
    version: version || null,
    commit,
    resolved,
    spec: source ? `github:${source[1]}/${source[2]}#${commit.slice(0, 12)}` : null,
  };
}

// Derive "which commit is this package?" for a non-checkout install. npm
// records the resolved git URL, sha included, in the install root's hidden
// lockfile (`node_modules/.package-lock.json`) and in `package-lock.json`;
// `npm pack` additionally stamps `gitHead` into the packed package.json.
export function derivePackagePin(root, pkg = {}) {
  if (typeof pkg.gitHead === "string" && /^[0-9a-f]{7,40}$/i.test(pkg.gitHead)) {
    return { version: pkg.version || null, commit: pkg.gitHead.toLowerCase(), resolved: null, spec: `${PUBLIC_GIT_SOURCE}#${pkg.gitHead.slice(0, 12)}` };
  }
  // A nested dependency (project/node_modules/consumer/node_modules/<pkg>) is
  // recorded in the PROJECT's lockfile under its full relative path, so walk
  // every enclosing install root outward, recomputing the key per root.
  let nodeModules = enclosingNodeModules(root);
  while (nodeModules) {
    const installRoot = dirname(nodeModules);
    const key = relative(installRoot, root).split(sep).join("/");
    for (const lockPath of [join(nodeModules, ".package-lock.json"), join(installRoot, "package-lock.json")]) {
      if (!existsSync(lockPath)) continue;
      let lock;
      try {
        lock = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      const entry = lock?.packages?.[key];
      const pin = pinFromResolved(entry?.resolved, entry?.version || pkg.version);
      if (pin) return pin;
    }
    nodeModules = enclosingNodeModules(installRoot);
  }
  return null;
}

export function localInstallStatus(root, pkg = {}) {
  if (isOwnGitCheckout(root)) {
    return {
      mode: "checkout",
      mode_label: PACKAGE_INSTALL_MODE_LABELS.checkout,
      location: root,
      pinned: null,
      summary: `Install mode: git checkout at ${root}.`,
    };
  }
  const mode = root.split(sep).includes("_npx")
    ? "npx_cache"
    : enclosingNodeModules(root)
      ? "node_modules"
      : "package_directory";
  const pinned = derivePackagePin(root, pkg);
  const pinText = pinned
    ? `pinned at ${pinned.version || "unknown version"} @ ${pinned.commit.slice(0, 12)}`
    : `version ${pkg.version || "unknown"}, pinned commit not derivable`;
  return {
    mode,
    mode_label: PACKAGE_INSTALL_MODE_LABELS[mode],
    location: root,
    pinned,
    summary: `Install mode: ${PACKAGE_INSTALL_MODE_LABELS[mode]}, ${pinText}.`,
  };
}


// The file a PATH executable ultimately runs: a symlink (node_modules/.bin on
// POSIX) is followed; an npm cmd-shim is read for the script it execs. Falls
// back to the executable itself when neither applies.
function executableTargetPath(executable) {
  const real = realpathOrSelf(executable);
  if (real !== executable || process.platform !== "win32") return real;
  try {
    const shim = readFileSync(executable, "utf8");
    const match = shim.match(/"([^"]+\.mjs)"/);
    return match ? resolve(dirname(executable), match[1]) : real;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return real;
    throw error;
  }
}

function findExecutableOnPath(name) {
  const pathEnv = process.env.PATH || "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, process.platform === "win32" && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(candidate) {
  if (!existsSync(candidate)) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      error: error.message || String(error),
    };
  }
}

// How a command should be spelled so it runs THIS install: the checkout
// script from a checkout; `npx --yes <spec>` from an npx cache (nothing is on
// PATH); `npx campaigns-os` from a consumer install (the toolkit pinned as a
// devDependency of the campaign folder) — always, because `npx` itself puts
// node_modules/.bin on PATH for the duration of the command, so a PATH match
// seen here says nothing about the operator's shell, and a bare command they
// paste there would not resolve; the bare binary from a plain package
// directory. The PATH comparison is still reported so a shadowing install is
// visible.
export function resolveInvocation(root, pkg = {}, install = localInstallStatus(root, pkg)) {
  const binRel = pkg.bin && typeof pkg.bin === "object"
    ? pkg.bin["campaigns-os"]
    : typeof pkg.bin === "string"
      ? pkg.bin
      : null;
  const localBin = binRel ? resolve(root, binRel) : resolve(root, "bin/campaigns-os.mjs");
  const globalPath = findExecutableOnPath("campaigns-os");
  const globalTarget = globalPath ? executableTargetPath(globalPath) : null;
  const matches = Boolean(globalTarget && realpathOrSelf(globalTarget) === realpathOrSelf(localBin));
  const nodeModules = install.mode === "checkout" ? null : enclosingNodeModules(root);
  let prefix;
  if (install.mode === "checkout") prefix = "npm run campaigns-os --";
  else if (install.mode === "npx_cache") prefix = install.pinned?.spec ? `npx --yes ${install.pinned.spec}` : "campaigns-os";
  else if (install.mode === "node_modules") prefix = "npx campaigns-os";
  else prefix = "campaigns-os";
  return {
    install,
    prefix,
    // What printed commands are spelled with. A checkout keeps the canonical
    // bare form: its printed output is a tested contract, and the README
    // states the `npm run campaigns-os --` translation once.
    print_prefix: install.mode === "checkout" ? "campaigns-os" : prefix,
    local_bin: localBin,
    local_bin_exists: existsSync(localBin),
    bin_dir: nodeModules ? join(nodeModules, ".bin") : null,
    global_binary: globalPath
      ? { status: matches ? "found" : "found_other_install", path: globalPath, resolves_to: globalTarget, matches_local_bin: matches }
      : { status: "not_found", path: null, resolves_to: null, matches_local_bin: false },
  };
}

const prefixCache = new Map();

// The PRINT prefix for the package at `root`, computed once per process (it
// costs two git subprocesses and a PATH scan).
export function invocationPrefixFor(root, pkg = null) {
  if (prefixCache.has(root)) return prefixCache.get(root);
  let manifest = pkg;
  if (!manifest) {
    try {
      manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      manifest = {};
    }
  }
  const prefix = resolveInvocation(root, manifest).print_prefix;
  prefixCache.set(root, prefix);
  return prefix;
}

// Rewrites every command spelled with the canonical bare `campaigns-os <verb>`
// into the given prefix. Internal bookkeeping (deviation tracking, gate
// registries, tests) keeps the canonical spelling; only what is printed or
// emitted for an operator or agent to copy is rewritten. Skill names such as
// next-campaigns-os-setup, file names (campaigns-os.mjs), and already-prefixed
// forms (`npx campaigns-os`, `npm run campaigns-os --`) are left alone.
const DEFAULT_COMMAND_WORDS = ["start", "prepare-build", "build", "polish", "checkpoint", "doctor", "bundle", "next", "theme", "tooling", "install-skills", "install-agent-context", "validate-assembly-report", "telemetry", "standardize", "qa", "findings", "run-record", "run"];
const patternCache = new Map();

function bareCommandPattern(commands) {
  const key = commands.join("|");
  if (!patternCache.has(key)) {
    patternCache.set(key, new RegExp(`(?<![\\w./-])(?<!npx )campaigns-os(?= (?:${key})\\b)`, "g"));
  }
  return patternCache.get(key);
}

export function applyInvocationPrefix(value, prefix, commands = DEFAULT_COMMAND_WORDS) {
  if (!prefix || prefix === "campaigns-os") return value;
  if (typeof value === "string") return value.replace(bareCommandPattern(commands), prefix);
  if (Array.isArray(value)) return value.map((item) => applyInvocationPrefix(item, prefix, commands));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = applyInvocationPrefix(item, prefix, commands);
    return out;
  }
  return value;
}
