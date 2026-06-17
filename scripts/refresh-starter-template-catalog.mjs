#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);

const DEFAULT_SOURCE_REPO = "NextCommerceCo/campaign-cart-starter-templates";
const DEFAULT_SOURCE_REF = "main";
const DEFAULT_SOURCE_CATALOG = "docs/commerce-surface-catalog.json";
const DEFAULT_TARGET_CATALOG = "contracts/commerce-surface-catalog.json";
const TEMPLATE_FIXTURE_PREFIX = "docs/fixtures/campaign-specs/";
const SNAPSHOT_FIXTURE_PREFIX = "contracts/fixtures/campaign-specs/";

function parseArgs(argv) {
  const args = {
    sourceRepo: DEFAULT_SOURCE_REPO,
    sourceRef: DEFAULT_SOURCE_REF,
    sourceCatalog: DEFAULT_SOURCE_CATALOG,
    targetCatalog: DEFAULT_TARGET_CATALOG,
    dryRun: false,
    syncFixtures: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };

    if (arg === "--source-repo") args.sourceRepo = next();
    else if (arg === "--source-ref") args.sourceRef = next();
    else if (arg === "--source-catalog") args.sourceCatalog = next();
    else if (arg === "--target-catalog") args.targetCatalog = next();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-fixtures") args.syncFixtures = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/refresh-starter-template-catalog.mjs [options]

Options:
  --source-repo <owner/repo>       Source template repo. Default: ${DEFAULT_SOURCE_REPO}
  --source-ref <ref>              Source branch, tag, or SHA. Default: ${DEFAULT_SOURCE_REF}
  --source-catalog <path>         Source catalog path. Default: ${DEFAULT_SOURCE_CATALOG}
  --target-catalog <path>         Vendored catalog path. Default: ${DEFAULT_TARGET_CATALOG}
  --dry-run                       Fetch and adapt without writing files
  --no-fixtures                   Refresh only the catalog file
`);
}

export function mapTemplateSnapshotPath(path) {
  if (typeof path !== "string") return path;
  if (path === "docs/fixtures/campaign-specs") return "contracts/fixtures/campaign-specs";
  if (path.startsWith(TEMPLATE_FIXTURE_PREFIX)) {
    return `${SNAPSHOT_FIXTURE_PREFIX}${path.slice(TEMPLATE_FIXTURE_PREFIX.length)}`;
  }
  return path;
}

export function adaptCatalogForCampaignsOs(catalog) {
  const next = structuredClone(catalog);

  if (next.campaignSpecFixturePolicy?.directory) {
    next.campaignSpecFixturePolicy.directory = mapTemplateSnapshotPath(next.campaignSpecFixturePolicy.directory);
  }

  for (const family of Object.values(next.families || {})) {
    const fixtures = family.agentContract?.fixtures;
    if (Array.isArray(fixtures)) {
      family.agentContract.fixtures = fixtures.map(mapTemplateSnapshotPath);
    }
  }

  return next;
}

export function mergeLocalQaStructure(adaptedCatalog, sourceCatalog, existingCatalog) {
  if (!existingCatalog || typeof existingCatalog !== "object") return adaptedCatalog;
  for (const [family, existingFamily] of Object.entries(existingCatalog.families || {})) {
    const existingQaStructure = existingFamily?.agentContract?.qaStructure;
    if (!existingQaStructure || typeof existingQaStructure !== "object" || Array.isArray(existingQaStructure)) continue;

    const targetContract = adaptedCatalog.families?.[family]?.agentContract;
    if (!targetContract) continue;

    const sourceQaStructure = sourceCatalog.families?.[family]?.agentContract?.qaStructure;
    if (!sourceQaStructure || typeof sourceQaStructure !== "object" || Array.isArray(sourceQaStructure)) {
      targetContract.qaStructure = structuredClone(existingQaStructure);
      continue;
    }

    targetContract.qaStructure = {
      ...structuredClone(existingQaStructure),
      ...targetContract.qaStructure,
    };
  }
  return adaptedCatalog;
}

// Families maintained directly in campaigns-os — private template families like
// `arjuna`, whose source lives in a private repo — are not present in the PUBLIC
// source catalog this script pulls. A refresh rebuilds `families` from the source,
// so without this step those local-only entries would be silently dropped. Carry
// private families through untouched (along with locally-authored brand contract
// + fixtures, which live outside the source catalog and are never overwritten by
// a refresh). Public families that disappear from the source are intentionally
// dropped instead of being preserved as stale local copies.
export function preserveLocalOnlyFamilies(adaptedCatalog, existingCatalog) {
  if (!existingCatalog || typeof existingCatalog !== "object") return adaptedCatalog;
  if (!adaptedCatalog.families || typeof adaptedCatalog.families !== "object") {
    adaptedCatalog.families = {};
  }
  for (const [family, existingFamily] of Object.entries(existingCatalog.families || {})) {
    if (!Object.prototype.hasOwnProperty.call(adaptedCatalog.families, family)) {
      if (isPrivateFamily(existingFamily)) {
        adaptedCatalog.families[family] = structuredClone(existingFamily);
      } else {
        // A PUBLIC family that disappeared from the source is dropped, not
        // preserved as a stale local copy. Warn loudly (like the collision
        // guard below) so a maintainer notices before the change ships — any
        // local-only customizations to this family (custom qaStructure, added
        // frontmatterInputsObserved, etc.) are not carried through.
        console.warn(
          `[refresh] public family "${family}" is no longer in the source catalog and was dropped; ` +
            `any local-only customizations to it are NOT preserved. If it should persist, re-add it ` +
            `to the source catalog or mark it private.`,
        );
      }
    } else if (isPrivateFamily(existingFamily)) {
      // Collision: a private, locally-maintained family (e.g. arjuna) also appears in
      // the refreshed public source. A refresh would otherwise silently replace the
      // private, locally-authored block with the public one — almost certainly a
      // mistake (the public starter-templates repo must not redefine a private family).
      // Keep the local copy and warn loudly so a maintainer notices the collision.
      adaptedCatalog.families[family] = structuredClone(existingFamily);
      console.warn(
        `[refresh] private local family "${family}" collided with an incoming public source entry; ` +
          `kept the local copy. The public source must not redefine a private family.`,
      );
    }
  }
  return adaptedCatalog;
}

// A family is "private" (local-only, never sourced from the public catalog) when its
// description says so — e.g. arjuna's "Private family — source lives in the Adsbranded
// private template repo". Used to guard against a public refresh clobbering it.
function isPrivateFamily(family) {
  // Prefer the machine-checkable flag; fall back to the description for older
  // catalog entries that predate the flag.
  if (family?.private === true) return true;
  const description = typeof family?.description === "string" ? family.description.toLowerCase() : "";
  return description.includes("private family") || description.includes("private template");
}

function collectSourceFixturePaths(catalog) {
  const paths = new Set();
  for (const family of Object.values(catalog.families || {})) {
    for (const fixture of family.agentContract?.fixtures || []) {
      if (typeof fixture === "string") paths.add(fixture);
    }
  }
  return [...paths].sort();
}

function safeRepoPath(path) {
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel === "") {
    throw new Error(`Refusing to write outside the repo: ${path}`);
  }
  return resolved;
}

function readExistingCatalog(path) {
  const fullPath = safeRepoPath(path);
  if (!existsSync(fullPath)) return null;
  return JSON.parse(readFileSync(fullPath, "utf8"));
}

async function fetchRepoFile({ repo, ref, path, token }) {
  const url = new URL(`https://api.github.com/repos/${repo}/contents/${path}`);
  url.searchParams.set("ref", ref);

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "campaigns-os-catalog-refresh",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch ${repo}:${path}@${ref}: ${response.status} ${body}`);
  }

  const payload = await response.json();
  if (payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error(`Unexpected GitHub contents response for ${repo}:${path}@${ref}`);
  }

  return Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
}

function writeText(path, text) {
  const fullPath = safeRepoPath(path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.STARTER_TEMPLATES_TOKEN || process.env.GITHUB_TOKEN || "";

  const rawCatalog = await fetchRepoFile({
    repo: args.sourceRepo,
    ref: args.sourceRef,
    path: args.sourceCatalog,
    token,
  });
  const sourceCatalog = JSON.parse(rawCatalog);
  const existingCatalog = readExistingCatalog(args.targetCatalog);
  const adaptedCatalog = preserveLocalOnlyFamilies(
    mergeLocalQaStructure(adaptCatalogForCampaignsOs(sourceCatalog), sourceCatalog, existingCatalog),
    existingCatalog,
  );

  if (!args.dryRun) {
    writeText(args.targetCatalog, `${JSON.stringify(adaptedCatalog, null, 2)}\n`);
  }

  if (args.syncFixtures) {
    for (const sourceFixture of collectSourceFixturePaths(sourceCatalog)) {
      const targetFixture = mapTemplateSnapshotPath(sourceFixture);
      const fixtureText = await fetchRepoFile({
        repo: args.sourceRepo,
        ref: args.sourceRef,
        path: sourceFixture,
        token,
      });
      if (!args.dryRun) {
        writeText(targetFixture, fixtureText.endsWith("\n") ? fixtureText : `${fixtureText}\n`);
      }
    }
  }

  const action = args.dryRun ? "Checked" : "Refreshed";
  console.log(`${action} ${args.targetCatalog} from ${args.sourceRepo}:${args.sourceCatalog}@${args.sourceRef}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
