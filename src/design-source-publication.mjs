// Design Source Package publication for prepare-build, start and build: the
// lock's critical section, collisions, evidence re-checks and publication order.
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeThemeArtifacts } from "./brand-theme.mjs";
import { cloneJson, isObject, isNonEmptyString, optionalString, readJson, resolveFromFile, sha256File } from "./cli-helpers.mjs";
import { DESIGN_SOURCE_PACKAGE_REL_PATH, createDesignSourcePackageArtifactReference, hashSerializedDesignSourcePackage, serializeDesignSourcePackage, synthesizeHtmlFunnelDesignSourcePackage, validateDesignSourcePackage } from "./design-source-package.mjs";
import { stampDoctorProducer } from "./doctor-sidecar.mjs";
import { filesystemPathsMatch } from "./doctor/next-step.mjs";
import { ASSEMBLY_REPORT_STAGE_KEYS } from "./orchestration-stage-contract.mjs";
import { targetLockPath, withTargetLock } from "./target-lock.mjs";
import { resolveTemplateFamilyDesignSource } from "./template-reference.mjs";

// Stage keys whose seed states prepare-build itself rewrites on every run
// (createInitialAssemblyReportStages): prepare_build is re-derived from this
// run's readiness result, and setup from scaffold detection — so their seed
// states never count as accumulated agent evidence. setup's seed state may
// legitimately be "skipped" (scaffold already present); every other stage is
// seeded "pending" with empty ledger arrays.
function assemblyReportStagesWithEvidence(existingReport) {
  const stages = existingReport?.stages;
  if (!isObject(stages)) return [];
  const withEvidence = [];
  for (const key of ASSEMBLY_REPORT_STAGE_KEYS) {
    if (key === "prepare_build") continue;
    const stage = stages[key];
    if (!isObject(stage)) continue;
    const seedStatuses = key === "setup" ? ["pending", "skipped"] : ["pending"];
    const nonSeedStatus = !seedStatuses.includes(optionalString(stage.status, "pending"));
    const recordedContent =
      ["inputs", "outputs", "commands", "blockers", "warnings", "evidence"].some(
        (field) => Array.isArray(stage[field]) && stage[field].length > 0,
      )
      || (isObject(stage.evidence) && Object.keys(stage.evidence).length > 0);
    if (nonSeedStatus || recordedContent) withEvidence.push(key);
  }
  return withEvidence;
}

// INV-4 guard (packet 02): prepare-build/start regenerate the assembly report
// from scratch (createAssemblyReport resets every stage), so an unconditional
// write silently destroys agent-recorded stage evidence. Mirror the
// runSessionStart pattern: refuse unless --force, and with --force announce
// exactly which stage keys are cleared. The guard keys on evidence, not file
// existence — a report whose stages are all still at their seed states (a real
// re-prepare before any work) regenerates freely with no flag.
//
// prepare-build runs it twice under its target lock: once before reading its
// inputs, and again (with `announced`, the keys the first call returned) right
// before the report is renamed into place. Stage producers commit the report
// without that lock, so evidence can land while the run is working; the second
// call refuses it without --force and, with --force, names any stage it had
// not already announced.
function guardAssemblyReportOverwrite(reportPath, args, { announced = null } = {}) {
  if (!existsSync(reportPath)) return [];
  let existingReport = null;
  try {
    existingReport = readJson(reportPath);
  } catch {
    return []; // An unreadable report carries no provable evidence; keep today's regeneration path.
  }
  const stageKeys = assemblyReportStagesWithEvidence(existingReport);
  if (stageKeys.length === 0) return [];
  if (args.force !== true) {
    throw new Error(
      `Assembly report at ${reportPath} ${announced ? "gained stage evidence while prepare-build was running" : "already carries stage evidence"} (${stageKeys.join(", ")}). `
      + `Rerunning prepare-build/start/build would reset ${stageKeys.length === 1 ? "this stage" : "these stages"} to pending and destroy that evidence. `
      + `Pass --force to overwrite (destructive).`,
    );
  }
  const unannounced = announced ? stageKeys.filter((key) => !announced.includes(key)) : stageKeys;
  if (unannounced.length > 0) {
    console.warn(
      `[campaigns-os prepare-build] --force: overwriting assembly report at ${reportPath}; clearing stage evidence for: ${unannounced.join(", ")}.`,
    );
  }
  return stageKeys;
}

function artifactRelativePath(artifactPath, targetPath) {
  const rel = relative(dirname(resolve(artifactPath)), resolve(targetPath)).replaceAll("\\", "/");
  return rel || ".";
}

function canonicalPrepareBuildOutputPath(path, label) {
  const absolute = resolve(path);
  const missingSegments = [];
  let cursor = absolute;
  let realpathRetries = 0;
  while (true) {
    let stats;
    try {
      stats = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
      continue;
    }

    // Even a dangling leaf symlink becomes writable after an earlier output
    // creates its target. Reject the alias itself instead of relying on stat,
    // which follows symlinks and cannot see a dangling one.
    if (missingSegments.length === 0 && stats.isSymbolicLink()) {
      throw new Error(`Prepare-build output path collision: ${label} at ${absolute} is a symbolic-link alias. Choose a regular, distinct output path; the Design Source Package path is fixed.`);
    }

    try {
      return resolve(realpathSync(cursor), ...missingSegments);
    } catch {
      // The entry can be replaced between lstat and realpath: a prepare-build
      // holding the target lock moves a stale DSP aside and links its
      // replacement while this run is still before the lock. Look again from
      // the top a few times; an entry that never resolves, such as a dangling
      // symlink, is an alias.
      if (realpathRetries++ < 3) {
        missingSegments.length = 0;
        cursor = absolute;
        continue;
      }
      throw new Error(`Prepare-build output path collision: ${label} at ${absolute} traverses an unresolved filesystem alias. Choose a regular, distinct output path; the Design Source Package path is fixed.`);
    }
  }
}

function prepareBuildPathIdentity(path) {
  return resolve(path).normalize("NFC").toLowerCase();
}

// A reserved tree is a directory no output may be written into: the target
// lock, whose release removes the directory recursively (#501). The staging,
// tomb and recovery siblings the lock creates and removes
// (src/directory-lock.mjs) are reserved with it; other names that merely
// start with the lock's name are ordinary outputs.
const PREPARE_BUILD_LOCK_SIBLING_SUFFIXES = [".staging-", ".recovery-staging-", ".released-", ".abandoned-"];

function prepareBuildReservedTreeContains(reservedIdentity, pathIdentity) {
  return pathIdentity === reservedIdentity
    || pathIdentity.startsWith(`${reservedIdentity}${sep}`)
    || PREPARE_BUILD_LOCK_SIBLING_SUFFIXES.some((suffix) => pathIdentity.startsWith(`${reservedIdentity}${suffix}`));
}

function assertOutsidePrepareBuildReservedTrees(label, absolute, canonical, reservedTrees) {
  for (const reserved of reservedTrees) {
    if (
      prepareBuildReservedTreeContains(reserved.identity, prepareBuildPathIdentity(absolute))
      || prepareBuildReservedTreeContains(reserved.canonicalIdentity, prepareBuildPathIdentity(canonical))
    ) {
      throw new Error(`Prepare-build output path collision: ${label} at ${absolute} is inside the ${reserved.label} at ${reserved.path}, which is removed when the lock is released. Choose an output path outside it; the Design Source Package path is fixed.`);
    }
  }
}

function assertDistinctPrepareBuildOutputPaths(entries) {
  const seenPaths = new Map();
  const seenCanonicalPaths = new Map();
  const seenFiles = new Map();
  const reservedTrees = entries
    .filter(([, , kind]) => kind?.reservedTree)
    .map(([label, path]) => {
      const absolute = resolve(path);
      return {
        label,
        path: absolute,
        identity: prepareBuildPathIdentity(absolute),
        canonicalIdentity: prepareBuildPathIdentity(canonicalPrepareBuildOutputPath(absolute, label)),
      };
    });
  const outputs = entries.filter(([, , kind]) => !kind?.reservedTree);
  for (const [label, path] of outputs) {
    const absolute = resolve(path);
    const pathIdentity = prepareBuildPathIdentity(absolute);
    const priorPath = seenPaths.get(pathIdentity);
    if (priorPath) {
      throw new Error(`Prepare-build output path collision: ${priorPath.label} at ${priorPath.path} and ${label} at ${absolute} are identical after conservative case folding. Choose distinct output paths; the Design Source Package path is fixed.`);
    }
    seenPaths.set(pathIdentity, { label, path: absolute });

    const canonical = canonicalPrepareBuildOutputPath(absolute, label);
    const canonicalIdentity = prepareBuildPathIdentity(canonical);
    assertOutsidePrepareBuildReservedTrees(label, absolute, canonical, reservedTrees);
    const priorCanonical = seenCanonicalPaths.get(canonicalIdentity);
    if (priorCanonical) {
      throw new Error(`Prepare-build output path collision: ${priorCanonical.label} at ${priorCanonical.path} and ${label} at ${absolute} resolve through filesystem aliases to ${canonical}. Choose distinct output paths; the Design Source Package path is fixed.`);
    }
    seenCanonicalPaths.set(canonicalIdentity, { label, path: absolute });

    // A lexical comparison is insufficient once an output already exists:
    // hard links can name the fixed DSP (or another sidecar) through a
    // different path, and writeFileSync would follow that alias. Symlink
    // aliases are already caught by the canonical-path check above, so
    // device + inode only need to identify hard links — files with
    // nlink > 1. Recording an identity for nlink === 1 files is unsound
    // here: the stat calls are not atomic across outputs, and a concurrent
    // prepare-build against the same target can unlink one output and let
    // the kernel recycle its inode for another, making two distinct files
    // momentarily share dev:ino.
    let identity = null;
    try {
      const stats = statSync(absolute);
      if (stats.nlink > 1) identity = `${stats.dev}:${stats.ino}`;
    } catch {
      // Missing output paths have no filesystem identity yet; the normalized
      // absolute-path check above is authoritative until they are created.
    }
    if (identity) {
      const priorFile = seenFiles.get(identity);
      if (priorFile) {
        throw new Error(`Prepare-build output path collision: ${priorFile.label} at ${priorFile.path} and ${label} at ${absolute} are aliases for the same filesystem object. Choose distinct output paths; the Design Source Package path is fixed.`);
      }
      seenFiles.set(identity, { label, path: absolute });
    }
  }
}

function preflightPrepareBuildOutputTargets(outputs, collisionOutputs) {
  assertDistinctPrepareBuildOutputPaths(collisionOutputs);
  for (const [label, path] of outputs) {
    const absolute = resolve(path);
    let stats = null;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Prepare-build could not inspect ${label} output target at ${absolute}: ${error.message}`, { cause: error });
      }
    }
    if (stats && !stats.isFile()) {
      const kind = stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symbolic link" : "non-regular filesystem entry";
      throw new Error(`Prepare-build output target is invalid: ${label} at ${absolute} must be absent or a regular file, but found a ${kind}.`);
    }

    // Atomic rename needs write + search permission on the destination's
    // directory, while mkdirSync for a missing directory needs those rights
    // on its nearest existing ancestor. Validate that capability before the
    // fixed DSP or theme artifacts can be published.
    let ancestor = dirname(absolute);
    while (true) {
      try {
        const ancestorStats = statSync(ancestor);
        if (!ancestorStats.isDirectory()) {
          throw new Error(`nearest existing ancestor ${ancestor} is not a directory`);
        }
        try {
          accessSync(ancestor, fsConstants.W_OK | fsConstants.X_OK);
        } catch (error) {
          const code = error?.code ? ` (${error.code})` : "";
          throw new Error(`Prepare-build output target is not writable: ${label} at ${absolute} has non-writable ancestor ${ancestor}${code}: ${error.message}`, { cause: error });
        }
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
}

function publishPrepareBuildJsonOutputs(outputs, collisionOutputs, { beforePublish = null } = {}) {
  preflightPrepareBuildOutputTargets(
    outputs.map(({ label, path }) => [label, path]),
    collisionOutputs,
  );
  const staged = [];
  try {
    for (const output of outputs) {
      const path = resolve(output.path);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(output.value, null, 2)}\n`, { flag: "wx" });
      staged.push({ ...output, path, tmp });
    }

    // Revalidate after all staging writes. A swap before this point is
    // rejected; a symlink or hard-link swap after it is safely replaced as a
    // directory entry by renameSync rather than followed and truncated.
    preflightPrepareBuildOutputTargets(
      outputs.map(({ label, path }) => [label, path]),
      collisionOutputs,
    );
    // Last check before anything is renamed into place; a refusal here leaves
    // every destination as it was.
    beforePublish?.();
    for (const output of staged) renameSync(output.tmp, output.path);
  } finally {
    for (const output of staged) rmSync(output.tmp, { force: true });
  }
}

function preparedDesignSourcePackageProblem(value, currentPageScope, currentHtmlFunnelScope) {
  const validation = validateDesignSourcePackage(value, {
    currentPageScope,
    currentHtmlFunnelScope,
  });
  if (validation.ok) return null;
  return validation.errors
    .map((error) => `[${error.code}] ${error.path}: ${error.message}`)
    .join("; ");
}

function assertValidPreparedDesignSourcePackage(value, path, currentPageScope, currentHtmlFunnelScope) {
  const detail = preparedDesignSourcePackageProblem(value, currentPageScope, currentHtmlFunnelScope);
  if (detail == null) return;
  throw new Error(`Design Source Package at ${path} is invalid, stale, or contradictory: ${detail}`);
}

// Which prepare-build lineage produced the Design Source Package now on disk.
// The previous Assembly Report at this run's report path is the only record of
// it: its design_source_package reference carries the exact-byte sha256 of the
// package that run bound to, and `origin: "synthesized"` when prepare-build
// wrote those bytes itself (or reused bytes it had itself written). A package
// counts as producer-synthesized only when that report says so AND the bytes on
// disk still hash to what it recorded, so a hand edit, a package dropped in by
// an operator, a report from another path, and a report written before `origin`
// existed all fall to "not provably ours" and are never overwritten.
//
// The package is published before the report that records it, so a run that
// fails or dies between the two would leave its own package unrecorded (#501).
// The pending provenance record beside the package closes that gap: it names
// the sha256 of the bytes a run is about to publish, plus the stale package's
// when a --force run is replacing one it proved its own, so a regeneration
// that fails or dies part way leaves whichever package ends up on disk
// provable. It is written before the package goes out, loses the candidate
// hash if the run adopts another writer's package instead of publishing, and
// is removed once a report has recorded the package. A retry that finds it
// still accepts only bytes that hash to one of its entries.
function readPriorDesignSourceProvenance(reportPath, packagePath) {
  const synthesized = [];
  const pending = readJsonIfExistsQuietly(pendingDesignSourceProvenancePath(packagePath));
  // All or nothing: a record with any entry that is not a digest (a torn or
  // hand-edited file) is no proof, never a partial one.
  if (isObject(pending) && pending.origin === DESIGN_SOURCE_PACKAGE_ORIGIN_SYNTHESIZED
    && Array.isArray(pending.sha256) && pending.sha256.length > 0
    && pending.sha256.every((entry) => typeof entry === "string" && /^sha256:[0-9a-f]{64}$/.test(entry))) {
    synthesized.push(...pending.sha256);
  }
  let report = null;
  try {
    report = readJson(reportPath);
  } catch {
    // No readable report: only a pending record can vouch for the package.
  }
  const ref = report?.design_source_package;
  if (isObject(ref) && ref.origin === DESIGN_SOURCE_PACKAGE_ORIGIN_SYNTHESIZED && isNonEmptyString(ref.sha256)) {
    const recordedPath = resolveFromFile(reportPath, ref.path);
    if (recordedPath && filesystemPathsMatch(recordedPath, packagePath)) synthesized.push(ref.sha256);
  }
  return synthesized.length ? { synthesized } : null;
}

function readJsonIfExistsQuietly(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pendingDesignSourceProvenancePath(designSourcePackagePath) {
  return join(dirname(designSourcePackagePath), `.${basename(designSourcePackagePath)}.pending-provenance.json`);
}

// Written (staged, then renamed into place) before a synthesized package is
// published, so the claim survives a crash between that publication and the
// report's. An empty list removes the record.
function recordPendingDesignSourceProvenance(designSourcePackagePath, sha256) {
  const pendingPath = pendingDesignSourceProvenancePath(designSourcePackagePath);
  if (!sha256.length) {
    rmSync(pendingPath, { force: true });
    return;
  }
  const stagedPath = `${pendingPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(stagedPath, `${JSON.stringify({ origin: DESIGN_SOURCE_PACKAGE_ORIGIN_SYNTHESIZED, sha256 })}\n`, { flag: "wx" });
    renameSync(stagedPath, pendingPath);
  } finally {
    rmSync(stagedPath, { force: true });
  }
}

const DESIGN_SOURCE_PACKAGE_ORIGIN_SYNTHESIZED = "synthesized";
const DESIGN_SOURCE_PACKAGE_ORIGIN_ADOPTED = "adopted";

function sourceMaterialFile(sourceRoot, path) {
  if (typeof path !== "string" || !path.trim()) return null;
  const root = resolve(sourceRoot);
  const fullPath = resolve(root, path);
  const rel = relative(root, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    const stats = statSync(fullPath);
    if (!stats.isFile()) return null;
    return { bytes: stats.size, sha256: sha256File(fullPath) };
  } catch {
    return null;
  }
}

function manifestPagesForResolvedMappings(pages, mappings) {
  if (!Array.isArray(pages)) return pages;
  const groups = new Map();
  for (const page of pages) {
    if (!isObject(page) || !isNonEmptyString(page.page_id)) continue;
    const group = groups.get(page.page_id) || [];
    group.push(page);
    groups.set(page.page_id, group);
  }
  const resolvedPathByPageId = new Map(
    mappings
      .filter((mapping) => isObject(mapping) && isNonEmptyString(mapping.page_id) && isNonEmptyString(mapping.path))
      .map((mapping) => [mapping.page_id, mapping.path]),
  );
  const resolvedDuplicate = new Map();
  for (const [pageId, group] of groups) {
    if (group.length < 2) continue;
    const resolvedPath = resolvedPathByPageId.get(pageId);
    const matches = resolvedPath
      ? group.filter((page) => page.path === resolvedPath)
      : [];
    resolvedDuplicate.set(pageId, matches.length === 1 ? matches[0] : null);
  }

  return pages.filter((page) => {
    if (!isObject(page) || !isNonEmptyString(page.page_id)) return true;
    if (!resolvedDuplicate.has(page.page_id)) return true;
    return resolvedDuplicate.get(page.page_id) === page;
  });
}

function createCurrentHtmlFunnelScope({
  packagePath,
  activePages,
  mappings,
  manifestResult,
  sourceAssetCrawl,
  templateFamily,
  templateStockPageIds = [],
  commerceCatalog,
  sourceRoot,
  mapId,
  publicRouteSlug,
}) {
  const manifest = manifestResult.manifest ? cloneJson(manifestResult.manifest) : null;
  if (manifest) {
    // Source intake owns duplicate-page resolution and records its blocker.
    // Feed the strict DSP synthesizer only the unique record that agrees with
    // that resolved mapping; an unmatched duplicate group remains ambiguous
    // and contributes no page record. Raw manifest bytes/provenance are still
    // retained through manifest.sha256 below.
    manifest.pages = manifestPagesForResolvedMappings(manifest.pages, mappings);
  }
  const crawl = isObject(sourceAssetCrawl) ? cloneJson(sourceAssetCrawl) : null;
  const materialPaths = new Set([
    ...mappings.map((mapping) => mapping?.path),
    ...(manifest?.files || []).map((file) => file?.path),
    ...(manifest?.pages || []).map((page) => page?.path),
    ...(crawl?.scanned_files || []).map((file) => file?.path),
    ...(crawl?.references || []).map((ref) => ref?.source_path),
  ].filter((path) => typeof path === "string" && path.trim()));
  const materialFiles = new Map(
    [...materialPaths].map((path) => [path, sourceMaterialFile(sourceRoot, path)]),
  );
  const currentMappings = mappings.map((mapping) => ({
    ...mapping,
    ...(mapping?.path ? { source_hash: materialFiles.get(mapping.path)?.sha256 || null } : {}),
  }));

  if (manifest) {
    // The hash of the bytes source intake parsed, not a second read of the
    // file, which an edit mid-run could have changed since (#501).
    manifest.sha256 = manifestResult.sha256 || null;
    manifest.files = (manifest.files || []).map((file) => ({
      ...file,
      sha256: materialFiles.get(file.path)?.sha256 || null,
    }));
    manifest.pages = (manifest.pages || []).map((page) => ({
      ...page,
      ...(page.path ? { source_hash: materialFiles.get(page.path)?.sha256 || null } : {}),
    }));
  }

  if (crawl) {
    const scannedByPath = new Map((crawl.scanned_files || []).map((file) => [file.path, file]));
    for (const [path, material] of materialFiles) {
      if (!material) continue;
      const existing = scannedByPath.get(path);
      scannedByPath.set(path, {
        ...(existing || { path, kind: "asset" }),
        bytes: material.bytes,
        sha256: material.sha256,
      });
    }
    crawl.scanned_files = [...scannedByPath.values()].sort((left, right) =>
      String(left.path).localeCompare(String(right.path)));
  }

  return {
    activePages,
    mappings: currentMappings,
    manifest,
    manifestPath: manifest && manifestResult.path
      ? artifactRelativePath(packagePath, manifestResult.path)
      : null,
    sourceAssetCrawl: crawl,
    templateFamily: resolveTemplateFamilyDesignSource(commerceCatalog, templateFamily),
    templateStockPageIds: [...templateStockPageIds],
    packageId: `${mapId}:design-source`,
    campaignMapId: mapId,
    campaignSlug: publicRouteSlug,
    sourceRoot: artifactRelativePath(packagePath, sourceRoot),
  };
}

function prepareDesignSourcePackage({
  path,
  activePages,
  mappings,
  manifestResult,
  sourceAssetCrawl,
  templateFamily,
  templateStockPageIds = [],
  commerceCatalog,
  sourceRoot,
  mapId,
  publicRouteSlug,
  priorProvenance = null,
  force = false,
}) {
  const currentPageScope = {
    activePages,
    mappings,
    campaignMapId: mapId,
    campaignSlug: publicRouteSlug,
  };
  const currentHtmlFunnelScope = createCurrentHtmlFunnelScope({
    packagePath: path,
    activePages,
    mappings,
    manifestResult,
    sourceAssetCrawl,
    templateFamily,
    templateStockPageIds,
    commerceCatalog,
    sourceRoot,
    mapId,
    publicRouteSlug,
  });
  let value;
  let rawBytes;
  let mode;

  const readExisting = () => {
    let existingBytes;
    try {
      const stats = lstatSync(path);
      if (!stats.isFile()) {
        const kind = stats.isDirectory()
          ? "directory"
          : stats.isSymbolicLink()
            ? "symbolic link"
            : "non-regular filesystem entry";
        throw new Error(`expected a regular file, but found a ${kind}`);
      }
      existingBytes = readFileSync(path);
    } catch (error) {
      const code = error?.code ? ` (${error.code})` : "";
      throw new Error(`Could not read Design Source Package artifact at ${path}${code}: ${error.message}`, { cause: error });
    }

    let existingValue;
    try {
      existingValue = JSON.parse(existingBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Design Source Package at ${path} is not valid JSON: ${error.message}`, { cause: error });
    }
    const existingSha256 = hashSerializedDesignSourcePackage(existingBytes);
    const synthesizedHere = Array.isArray(priorProvenance?.synthesized)
      && priorProvenance.synthesized.includes(existingSha256);
    let problem = preparedDesignSourcePackageProblem(existingValue, currentPageScope, currentHtmlFunnelScope);
    if (problem == null && existingValue.source_kind !== "html_funnel") {
      problem = `declares source_kind ${JSON.stringify(existingValue.source_kind)}; html_funnel prepare-build requires "html_funnel".`;
    }
    if (problem != null) {
      // A package an earlier prepare-build synthesized, unchanged since, is
      // this producer's own stale output: --force regenerates it from the
      // current inputs. Anything else is left for the operator to reconcile.
      if (synthesizedHere && force) return { stale: true, sha256: existingSha256 };
      const recovery = synthesizedHere
        ? "It was synthesized by an earlier prepare-build and is unchanged since, so rerun with --force to regenerate it from the current inputs "
          + "(--force also resets any stage evidence the Assembly Report carries)."
        : "prepare-build cannot show it synthesized these bytes (no Assembly Report records them as its own output, or the package changed since), so it will not overwrite it. "
          + `Reconcile the package with the current inputs, or, if no downstream stage has consumed it, delete ${path} and rerun prepare-build to synthesize a fresh one.`;
      throw new Error(`Design Source Package at ${path} is invalid, stale, or contradictory: ${problem} ${recovery}`);
    }
    return {
      value: existingValue,
      rawBytes: existingBytes,
      origin: synthesizedHere ? DESIGN_SOURCE_PACKAGE_ORIGIN_SYNTHESIZED : DESIGN_SOURCE_PACKAGE_ORIGIN_ADOPTED,
    };
  };

  const synthesizeCurrent = () => {
    const synthesized = synthesizeHtmlFunnelDesignSourcePackage(currentHtmlFunnelScope);
    assertValidPreparedDesignSourcePackage(synthesized, path, currentPageScope, currentHtmlFunnelScope);
    return { value: synthesized, rawBytes: Buffer.from(serializeDesignSourcePackage(synthesized), "utf8") };
  };

  let origin = DESIGN_SOURCE_PACKAGE_ORIGIN_SYNTHESIZED;

  // Synthesize the current package and fully write it to a same-directory
  // staging file. Nothing at `path` is touched yet, so a failure here (inputs
  // that no longer validate, a read-only target, a full disk) leaves any
  // existing package exactly as it was.
  const stageSynthesized = () => {
    ({ value, rawBytes } = synthesizeCurrent());
    mkdirSync(dirname(path), { recursive: true });
    const stagedPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(stagedPath, rawBytes, { flag: "wx" });
    } catch (error) {
      rmSync(stagedPath, { force: true });
      throw error;
    }
    return stagedPath;
  };

  // prepareBuild holds the target lock around this whole decision, so no other
  // prepare-build publishes here meanwhile. A package that still appears at
  // `path` (an operator, or a tool that does not take the lock) is
  // authoritative: validate and reuse its exact bytes rather than overwrite.
  const reuseWinner = () => {
    const winner = readExisting();
    if (winner.stale) {
      throw new Error(`Design Source Package at ${path} appeared while prepare-build was publishing and does not match this run's inputs; if it is a stale package an earlier prepare-build synthesized, rerun prepare-build with --force.`);
    }
    ({ value, rawBytes, origin } = winner);
    mode = "reused";
  };

  const publishStaged = (stagedPath) => {
    try {
      // Linking a fully written same-directory staging file is the Node
      // primitive that combines atomic visibility with no-replace
      // publication. A plain rename fallback is intentionally unsafe here:
      // it could replace a package that appeared after the absence check.
      linkSync(stagedPath, path);
      mode = "emitted";
    } catch (error) {
      // EEXIST means a package appeared at the publication seam; for any
      // other link failure, prefer validating such a package before failing
      // closed.
      if (error?.code !== "EEXIST" && !existsSync(path)) {
        throw new Error(
          `Could not atomically publish Design Source Package artifact at ${path}${error?.code ? ` (${error.code})` : ""}: `
          + `exclusive hard-link publication failed; refusing an unsafe rename fallback that could overwrite a concurrent winner: ${error.message}`,
          { cause: error },
        );
      }
      // Another writer's package is at the path, not this run's bytes: the
      // pending record stops vouching for the candidate before it is judged.
      recordPendingDesignSourceProvenance(path, pendingCarried);
      reuseWinner();
    }
  };

  // --force over this producer's own stale package. The replacement is
  // already staged. The stale bytes are claimed by moving them aside and
  // re-hashed there, so an edit that landed after they were judged stale is
  // caught instead of discarded; the replacement then goes out through the
  // same no-replace link as a fresh emit. The claimed bytes are deleted only
  // once they are proven to be the stale bytes and the replacement is out, or
  // once they are back in place after a failure; otherwise they are kept and
  // named.
  const replaceStale = (stagedPath, staleSha256) => {
    const retiredPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.stale`);
    try {
      renameSync(path, retiredPath);
    } catch (error) {
      // Removed since it was read: there is nothing left to replace.
      if (error?.code === "ENOENT") return publishStaged(stagedPath);
      throw new Error(`Could not claim the stale Design Source Package at ${path} for regeneration${error?.code ? ` (${error.code})` : ""}: ${error.message}`, { cause: error });
    }
    // Put the claimed bytes back without replacing anything that has appeared
    // at `path` since. True only when `path` is now those very bytes (the
    // same file), not merely occupied by another package.
    const putBack = () => {
      try {
        linkSync(retiredPath, path);
      } catch (error) {
        if (error?.code !== "EEXIST") return false;
      }
      try {
        const atPath = statSync(path);
        const retired = statSync(retiredPath);
        return atPath.ino === retired.ino && atPath.dev === retired.dev;
      } catch {
        return false;
      }
    };
    try {
      if (hashSerializedDesignSourcePackage(readFileSync(retiredPath)) !== staleSha256) {
        throw new Error(`Design Source Package at ${path} changed after prepare-build judged it stale, so it was not replaced. Rerun prepare-build to judge the current package.`);
      }
      publishStaged(stagedPath);
    } catch (error) {
      if (putBack()) {
        rmSync(retiredPath, { force: true });
        throw error;
      }
      throw new Error(`${error.message} The Design Source Package moved aside for regeneration could not be put back and is kept at ${retiredPath}.`, { cause: error });
    }
    rmSync(retiredPath, { force: true });
  };

  const existing = existsSync(path) ? readExisting() : null;
  // The stale package a --force run replaces is provably the producer's own;
  // its hash stays in the pending record until the replacement is recorded,
  // so a failed or interrupted replacement that leaves it in place (put back,
  // or never moved) can still be regenerated.
  const pendingCarried = existing?.stale ? [existing.sha256] : [];
  if (existing && !existing.stale) {
    ({ value, rawBytes, origin } = existing);
    mode = "reused";
  } else {
    const stagedPath = stageSynthesized();
    try {
      recordPendingDesignSourceProvenance(path, [hashSerializedDesignSourcePackage(rawBytes), ...pendingCarried]);
      if (existing?.stale) replaceStale(stagedPath, existing.sha256);
      else publishStaged(stagedPath);
    } finally {
      rmSync(stagedPath, { force: true });
    }
    if (existing?.stale && mode === "emitted") {
      mode = "regenerated";
      console.warn(
        `[campaigns-os prepare-build] --force: regenerated the stale Design Source Package at ${path} that an earlier prepare-build synthesized.`,
      );
    }
  }

  const referenceIdentity = createDesignSourcePackageArtifactReference(value, {
    path: ".",
    serialized: rawBytes,
  });

  return {
    path,
    value,
    rawBytes,
    mode,
    origin,
    referenceFor(artifactPath) {
      return {
        ...referenceIdentity,
        path: artifactRelativePath(artifactPath, path),
      };
    },
  };
}

const PUBLICATION_STEPS = ["package", "writeTheme", "publish", "publishDoctorOutput"];

// Runs `fn(publication)` inside the target lock; the handle's steps run in
// PUBLICATION_STEPS order, and `package` and `publish` run once.
export async function withDesignSourcePublication({ targetRepo, outputs, force = false, publishSpec = null }, fn) {
  const { packetPath, contextPath, reportPath, doctorOutPath, briefPath } = outputs;
  const designSourcePackagePath = resolve(targetRepo, DESIGN_SOURCE_PACKAGE_REL_PATH);
  const paths = Object.freeze({ packetPath, contextPath, reportPath, doctorOutPath, briefPath, designSourcePackagePath });
  const prepareBuildOutputPaths = [
    ["Build Packet", packetPath],
    ["Build Context", contextPath],
    ["Assembly Report", reportPath],
    ["Doctor Output", doctorOutPath],
    ["Campaign Build Brief", briefPath],
  ];
  const prepareBuildThemeOutputPaths = [
    ["Theme Report", resolve(targetRepo, ".campaign-runtime/theme/theme-report.json")],
    ["Brand Theme CSS", resolve(targetRepo, ".campaign-runtime/theme/brand-theme.css")],
  ];
  const prepareBuildCollisionPaths = [
    ...prepareBuildOutputPaths,
    ...prepareBuildThemeOutputPaths,
    ["Design Source Package", designSourcePackagePath],
    ["prepare-build target lock directory", targetLockPath(targetRepo), { reservedTree: true }],
    ["Design Source Package pending provenance record", pendingDesignSourceProvenancePath(designSourcePackagePath)],
  ];
  assertDistinctPrepareBuildOutputPaths(prepareBuildCollisionPaths);
  // One prepare-build at a time per target, from reading its inputs through
  // the packet, context and report that record them. Stage writers take the
  // same lock around their Assembly Report edits (commitAssemblyReport), so
  // no stage evidence lands between the pre-publish re-check and the rename;
  // they enter directly when prepare-build itself reaches them. The lock is taken before
  // the stage-evidence guard and before the CampaignSpec, manifest, mappings
  // and asset crawl are read, so the evidence check, the input snapshot whose
  // hashes the Design Source Package records, and the publication are one
  // critical section: a run that waited here sees exactly what the last
  // completed run left, not what was on disk when it started waiting.
  return withTargetLock(targetRepo, () => {
    // The fetched spec goes into the shared cache file inside the critical
    // section: the spec this run reads, hashes and records is the one it
    // fetched, and a run waiting here cannot replace it meanwhile.
    publishSpec?.();
    let announcedStageEvidence = guardAssemblyReportOverwrite(reportPath, { force });
    // Stage producers commit the report without this lock, so evidence can land
    // while the run works. Re-check before each write that is not rolled back:
    // the theme artifacts, then the JSON outputs. --force names a stage once.
    const recheckStageEvidence = () => {
      const found = guardAssemblyReportOverwrite(reportPath, { force }, { announced: announcedStageEvidence });
      announcedStageEvidence = [...new Set([...announcedStageEvidence, ...found])];
    };
    let completed = 0;
    const enter = (index, { once = false } = {}) => {
      if (completed < index) throw new TypeError(`Design Source Package publication: ${PUBLICATION_STEPS[index]}() cannot run before ${PUBLICATION_STEPS[completed]}().`);
      if (once && completed > index) throw new TypeError(`Design Source Package publication: ${PUBLICATION_STEPS[index]}() already ran.`);
    };
    let designSourcePackage = null;
    return fn(Object.freeze({
      paths,
      package(inputs) {
        enter(0, { once: true });
        // Reject deterministic destination failures before publishing the fixed
        // DSP. The DSP intentionally precedes the theme and JSON artifacts that
        // reference it; a later I/O race may therefore leave a valid DSP for a
        // subsequent run to validate and reuse. Never roll it back here because a
        // concurrent prepare may already have consumed its exact bytes.
        preflightPrepareBuildOutputTargets(
          [...prepareBuildOutputPaths, ...prepareBuildThemeOutputPaths],
          prepareBuildCollisionPaths,
        );
        designSourcePackage = prepareDesignSourcePackage({
          ...inputs,
          path: designSourcePackagePath,
          priorProvenance: readPriorDesignSourceProvenance(reportPath, designSourcePackagePath),
          force,
        });
        completed = 1;
        return designSourcePackage;
      },
      writeTheme(inspection, { writeCss }) {
        enter(1);
        // Inspection can take time, so reject aliases or invalid target types again
        // before publication. The shared theme writer then stages each artifact in
        // its destination directory and atomically replaces the final entry, making
        // a post-preflight symlink or hard-link swap safe without rolling back DSP.
        preflightPrepareBuildOutputTargets(
          prepareBuildThemeOutputPaths,
          prepareBuildCollisionPaths,
        );
        // The theme files are replaced in place, not staged with the JSON outputs,
        // so evidence that has landed by now refuses the run before any is written.
        recheckStageEvidence();
        const written = writeThemeArtifacts(inspection, { writeReport: true, writeCss, force, packetPath });
        completed = Math.max(completed, 2);
        return written;
      },
      publish({ packet, brief, context, report }) {
        enter(2, { once: true });
        // Before the report goes out, narrow the pending record to exactly what the
        // report will say: the package's own hash when it is synthesized, nothing
        // when it is adopted. A candidate this run or an earlier failed one never
        // published cannot then outlive the report, even if the run dies between
        // publishing the report and removing the record below.
        recordPendingDesignSourceProvenance(
          designSourcePackagePath,
          designSourcePackage.origin === DESIGN_SOURCE_PACKAGE_ORIGIN_SYNTHESIZED
            ? [hashSerializedDesignSourcePackage(designSourcePackage.rawBytes)]
            : [],
        );
        publishPrepareBuildJsonOutputs([
          { label: "Build Packet", path: packetPath, value: packet },
          { label: "Campaign Build Brief", path: briefPath, value: brief },
          { label: "Build Context", path: contextPath, value: context },
          { label: "Assembly Report", path: reportPath, value: report },
        ], prepareBuildCollisionPaths, {
          beforePublish: recheckStageEvidence,
        });
        // The report now records the package and its origin, so a pending
        // provenance record has served its purpose.
        rmSync(pendingDesignSourceProvenancePath(designSourcePackagePath), { force: true });
        completed = 3;
      },
      publishDoctorOutput(doctor, { command }) {
        enter(3);
        // Through the intake's own collision-checked writer, so the sidecar is
        // stamped with the intake command that ran doctor (`start` or `build`,
        // #312) without a second write path for it.
        publishPrepareBuildJsonOutputs([
          { label: "Doctor Output", path: doctorOutPath, value: stampDoctorProducer(doctor, command) },
        ], prepareBuildCollisionPaths);
      },
    }));
  }, { command: "prepare-build" });
}
