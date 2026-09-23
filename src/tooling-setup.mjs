import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PACKAGE = "@nextcommerce/campaigns-os";
const CONTEXT = ".campaign-runtime/agent-context/CLAUDE.md";
const IMPORT = `@${CONTEXT}`;

// Setup composes the existing installers after npm has installed the project
// dependencies. It never chooses a campaign, scaffolds pages, or opens a run.
export function setupArguments(args, argv) {
  const values = new Set(["target", "platform"]);
  const flags = new Set(["dry-run", "json"]);
  const seen = new Set();
  const tokens = argv[0] === "campaigns-os" ? argv.slice(1) : argv;
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i];
    const key = token.startsWith("--") ? token.slice(2) : "";
    if ((!values.has(key) && !flags.has(key)) || seen.has(key)) {
      throw new Error(`tooling setup: unsupported or repeated argument ${JSON.stringify(token)}.`);
    }
    seen.add(key);
    if (values.has(key)) {
      if (!tokens[i + 1] || tokens[i + 1].startsWith("--")) throw new Error(`tooling setup: --${key} requires a value.`);
      i++;
    }
  }
  if (typeof args.target !== "string" || !args.target.trim()) throw new Error("tooling setup: select the campaign folder with --target <directory>.");
  if (args.platform && args.platform !== "claude") throw new Error("tooling setup: this entry supports --platform claude. Other agents can use install-skills and install-agent-context.");
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hasContextImport(text) {
  let fence = null;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) {
      fence = marker[1];
    } else if (/^ {0,3}@/.test(line) && line.trim() === IMPORT) {
      found = true;
    }
  }
  if (!found && fence) throw new Error("tooling setup: close the unterminated code fence in CLAUDE.md before setup can append an active context import; no files were changed.");
  return found;
}

function regularDestination(root, path) {
  const parts = relative(root, path).split(/[\\/]/);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    if (!existsSync(current)) {
      // existsSync follows symlinks, including dangling ones.
      try { lstatSync(current); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`tooling setup: preserve ${current}; expected a regular ${i < parts.length - 1 ? "directory" : "file"}, not a symlink or another file type.`);
    }
  }
}

export function setupTooling(args, { packageRoot, installSkills, installAgentContext, installBrowser }) {
  const target = realpathSync(resolve(args.target));
  const pkg = json(join(packageRoot, "package.json"));
  const manifestPath = join(target, "package.json");
  const lockPath = join(target, "package-lock.json");
  const installCommand = `npm install --save-dev --save-exact ${PACKAGE}@${pkg.version} next-campaign-page-kit@0.2.0`;
  if (!existsSync(manifestPath) || !existsSync(lockPath)) {
    throw new Error(`tooling setup: install the project dependencies first, from the selected folder: ${installCommand}`);
  }
  const manifest = json(manifestPath);
  const pins = [manifest.devDependencies?.[PACKAGE], manifest.dependencies?.[PACKAGE]].filter(Boolean);
  if (!pins.length || pins.some((pin) => pin !== pkg.version)) {
    throw new Error(`tooling setup: the project must pin ${PACKAGE} exactly to the running version ${pkg.version}; preserve its current pin or explicitly install the reviewed version first.`);
  }
  const installed = join(target, "node_modules", "@nextcommerce", "campaigns-os");
  if (!existsSync(installed) || realpathSync(installed) !== realpathSync(packageRoot)) {
    throw new Error("tooling setup: run the selected project's installed copy: cd into that folder and use npx --no-install campaigns-os tooling setup --target . --platform claude.");
  }
  const lock = json(lockPath);
  if (lock.packages?.["node_modules/@nextcommerce/campaigns-os"]?.version !== pkg.version) {
    throw new Error("tooling setup: the lockfile does not match the project toolkit pin; reconcile the reviewed dependency with npm before setup.");
  }
  if (!manifest.dependencies?.["next-campaign-page-kit"] && !manifest.devDependencies?.["next-campaign-page-kit"]) {
    throw new Error("tooling setup: install next-campaign-page-kit in this project first. No campaign pages have been scaffolded or changed.");
  }
  if (!existsSync(join(target, "node_modules", "next-campaign-page-kit", "package.json"))) {
    throw new Error("tooling setup: page-kit is declared but not installed; run npm ci in the selected project first.");
  }

  // Preflight every destination before any installer runs. Custom repository
  // instructions are preserved; only one Claude import line is appended.
  const instructions = join(target, "CLAUDE.md");
  regularDestination(target, instructions);
  regularDestination(target, join(target, ".gitignore"));
  for (const name of ["CLAUDE.md", "AGENTS.md", "campaigns-os.mdc", "copilot-instructions.md"]) {
    const dest = join(target, ".campaign-runtime", "agent-context", name);
    regularDestination(target, dest);
    const source = { "CLAUDE.md": "agents/claude/CLAUDE.md", "AGENTS.md": "agents/codex/AGENTS.md", "campaigns-os.mdc": "agents/cursor/campaigns-os.mdc", "copilot-instructions.md": "agents/copilot/copilot-instructions.md" }[name];
    if (existsSync(dest) && readFileSync(dest, "utf8") !== readFileSync(join(packageRoot, source), "utf8")) {
      throw new Error(`tooling setup: ${dest} differs from this toolkit's context. Preserve and reconcile it before rerunning setup; no files were changed.`);
    }
  }
  const prior = existsSync(instructions) ? readFileSync(instructions, "utf8") : "";
  const hasImport = hasContextImport(prior);
  // Do the fallible download before changing the shared skills or project.
  const browser = args["dry-run"] ? { ok: true, status: "not_run" } : installBrowser({ json: Boolean(args.json) });
  const skills = browser.ok ? installSkills(null, Boolean(args["dry-run"]), "claude") : null;
  const context = browser.ok ? installAgentContext(target, Boolean(args["dry-run"])) : null;
  const contextFailed = context?.gitignore?.action === "skipped";
  const ready = browser.ok && !contextFailed;
  if (ready && !args["dry-run"] && !hasImport) {
    writeFileSync(instructions, `${prior}${prior && !prior.endsWith("\n") ? "\n" : ""}\n${IMPORT}\n`);
  }
  const revision = json(join(packageRoot, "skills.json")).bundle_revision;
  return {
    ok: ready,
    status: !browser.ok ? "browser_install_failed" : contextFailed ? "context_install_failed" : args["dry-run"] ? "dry_run" : "restart_required",
    target_repo: target,
    skills_revision: revision,
    skills,
    context,
    instructions: { path: instructions, action: !ready ? "not_run" : hasImport ? "unchanged" : "append_import" },
    browser,
    next_action: contextFailed
      ? `Setup could not add the runtime ignore block (${context.gitignore.reason}). Fix .gitignore and rerun setup; skills and context files may already be installed.`
      : args["dry-run"]
      ? "Run tooling setup with the same target and without --dry-run to install the browser, skills and agent context."
      : browser.ok
      ? `Restart Claude Code in this folder, then use the next-campaigns-os skill with your CampaignSpec and source material. Confirm the loaded bundle with npx --no-install campaigns-os tooling status --platform claude --skills-revision ${revision}.`
      : "Fix the browser installation error and rerun tooling setup; existing page source and repository instructions are preserved.",
    note: "Setup prepares tools; it does not scaffold pages, create a spec, select a campaign, log in, or prove that an agent loaded the installed skills.",
  };
}

export function setupTextLines(result) {
  return [
    `Status: ${result.status.toUpperCase()}`,
    `Campaign folder: ${result.target_repo}`,
    `Skills revision: ${result.skills_revision}`,
    `Browser: ${result.browser.status}`,
    ...(result.browser.note ? [result.browser.note] : []),
    result.next_action,
    result.note,
  ];
}
