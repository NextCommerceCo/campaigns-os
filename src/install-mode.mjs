// Install-mode detection shared by `tooling status`, the printed `next`
// commands, and the browser-missing hints: where is this package running
// from, which commit is it pinned at, and how should a command be spelled so
// it runs THIS copy where the operator is.
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { shellToken } from "./shell-token.mjs";

const PACKAGE_INSTALL_MODE_LABELS = Object.freeze({
  checkout: "git checkout",
  npx_cache: "package install (npx cache)",
  node_modules: "package install (node_modules)",
  package_directory: "package install",
  global: "global package install",
});

const PUBLIC_GIT_SOURCE = "github:NextCommerceCo/campaigns-os";

// How a consumer install is spelled. `campaigns-os` is only the bin name of
// @nextcommerce/campaigns-os: where no installed copy is found, a plain
// `npx campaigns-os` looks the bin name up as a registry package and, with no
// terminal to ask, installs whatever answers. `--no-install` makes npx run the
// project's copy or fail.
export const LOCAL_INVOCATION_PREFIX = "npx --no-install campaigns-os";

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
  // npm's exec cache lays packages out as <cache>/_npx/<hex hash>/node_modules/<pkg>;
  // a project that merely has `_npx` somewhere in its path is not that.
  const segments = root.split(sep);
  const npxIndex = segments.indexOf("_npx");
  const inNpxCache = npxIndex >= 0 && /^[0-9a-f]{8,}$/i.test(segments[npxIndex + 1] || "") && segments[npxIndex + 2] === "node_modules";
  const modules = enclosingNodeModules(root);
  // npm's global layout is prefix/lib/node_modules on POSIX and
  // prefix/node_modules on Windows. Verify the prefix's own bin points to
  // this package, independently of PATH, which may select another install.
  const globalPrefix = modules && (process.platform === "win32" ? dirname(modules) : basename(dirname(modules)) === "lib" ? dirname(dirname(modules)) : null);
  const globalBin = globalPrefix ? join(globalPrefix, process.platform === "win32" ? "campaigns-os.cmd" : "bin/campaigns-os") : null;
  const ownBin = resolve(root, typeof pkg.bin === "object" ? pkg.bin["campaigns-os"] || "bin/campaigns-os.mjs" : "bin/campaigns-os.mjs");
  const globalInstall = globalBin && existsSync(globalBin) && executableTargetPath(globalBin) === realpathOrSelf(ownBin);
  const mode = inNpxCache
    ? "npx_cache"
    : globalInstall ? "global"
    : modules
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
export function executableTargetPath(executable) {
  const real = realpathOrSelf(executable);
  if (real !== executable) return real;
  // Not a symlink: an npm cmd-shim (Windows, `%~dp0`-relative), a pnpm/yarn
  // shell wrapper, or the script itself. Read a small text wrapper for the
  // script it execs; anything else is the executable.
  let text;
  try {
    text = readFileSync(executable, "utf8").slice(0, 4096);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return real;
    throw error;
  }
  // Only the script argument of a node invocation counts, and only on a real
  // command line: comment lines (`#`, `REM`, `::`) are dropped first so a
  // `.mjs` or even a `node ./x.mjs` mentioned in a prologue cannot win, and
  // the invocation must open its logical line (optionally after `exec`, an
  // `@`, or `&&`/`;`/`|`). The path is a quoted or bare token that starts with
  // a wrapper-relative or absolute prefix and ends at the quote/whitespace
  // after `.mjs`.
  const code = text.split(/\r?\n/).filter((line) => !/^\s*(?:#|@?rem\b|::)/i.test(line)).join("\n");
  const prefix = String.raw`(?:%~dp0|\$basedir|\$\{basedir\}|\.|\.\.|\/|[A-Za-z]:)`;
  const match = code.match(new RegExp(String.raw`(?:^|[;&|])\s*@?(?:exec\s+)?(?:"[^"\n]*node(?:\.exe)?"|node(?:\.exe)?)\s+(?:"(${prefix}[^"\n]*?\.mjs)"|'(${prefix}[^'\n]*?\.mjs)'|(${prefix}[^\s"'\n]*?\.mjs))(?=[\s"']|$)`, "m"));
  if (!match) return real;
  const scriptToken = match[1] ?? match[2] ?? match[3];
  const script = scriptToken.replace(/^(%~dp0|\$basedir|\$\{basedir\})[\\/]?/, "");
  return realpathOrSelf(resolve(dirname(executable), script.replace(/\\/g, "/")));
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
// PATH); `npx --no-install campaigns-os` from a consumer install (the toolkit
// pinned as a devDependency of the campaign folder) — always, because `npx`
// itself puts node_modules/.bin on PATH for the duration of the command, so a
// PATH match seen here says nothing about the operator's shell, and a bare
// command they paste there would not resolve; the bare binary from a plain
// package directory. The PATH comparison is still reported so a shadowing
// install is visible.
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
  else if (install.mode === "node_modules") prefix = LOCAL_INVOCATION_PREFIX;
  else if (install.mode === "global") prefix = matches ? "campaigns-os" : `node ${shellToken(localBin)}`;
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
// forms (`npx --no-install campaigns-os`, `npm run campaigns-os --`) are left
// alone.
