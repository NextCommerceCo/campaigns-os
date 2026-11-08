// Campaign workspace: where a Build Packet's sidecars live, resolved once.
//
// Two roots matter. The TARGET REPO (`packet.assembly.target_repo` resolved
// against the packet's directory, else that directory) carries the build
// sidecars under the funnel's runtime directory and the local QA verdicts
// under `qa-output/`; the packet's own directory (`baseDir`) carries what is
// written beside the packet (run records, the committed QA verdict sidecar).
// They coincide for a packet at the target root and diverge for
// `prepare-build --out` elsewhere — exactly when a stage spelling the rule for
// itself drifts.
//
// One Page Kit project can hold several funnels. Each funnel has its own
// packet and its own runtime directory, so setting one up never touches
// another's records (#719). The first funnel set up in a project keeps the
// project-level `.campaign-runtime/`, which is also where every packet that
// records no `assembly.runtime_dir` (all packets before per-funnel records)
// keeps its records. Every later funnel gets `.campaign-runtime/funnels/<public
// route slug>/`, recorded on its packet as `assembly.runtime_dir`, and its
// packet is named `campaign-runtime-<public route slug>.build.json` beside the
// default `campaign-runtime.build.json`.
// A leaf: node built-ins and the sidecar leaves only.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DOCTOR_SIDECAR_REL_PATH } from "./doctor-sidecar.mjs";
import { absentOrMalformed, sameFile } from "./fs-identity.mjs";
import { normalizePublicRouteSlug } from "./route-identity.mjs";

export const RUNTIME_DIR_REL_PATH = ".campaign-runtime";
export const FUNNEL_RUNTIME_PARENT_REL_PATH = ".campaign-runtime/funnels";
export const BUILD_CONTEXT_REL_PATH = ".campaign-runtime/build-context.json";
export const ASSEMBLY_REPORT_REL_PATH = ".campaign-runtime/assembly-report.json";
export const QA_OUTPUT_REL_PATH = "qa-output";
export const DEFAULT_PACKET_FILENAME = "campaign-runtime.build.json";
// A project's other root-level packets, one per additional funnel. The same
// shape readback discovers (src/readback.mjs PACKET_CANDIDATE_PATTERN).
export const FUNNEL_PACKET_PATTERN = /^campaign-runtime-.+\.build\.json$/;

// A route slug that can name a directory and a file: the characters the packet
// schema allows in route_root, not starting with a dot (so never `.` or `..`).
const ROUTE_COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function routeComponent(routeSlug) {
  const slug = normalizePublicRouteSlug(routeSlug);
  if (!ROUTE_COMPONENT.test(slug)) {
    throw new Error(
      `Public route slug ${JSON.stringify(routeSlug)} cannot name a funnel's runtime directory or packet file: `
      + "use letters, digits, dots, underscores and hyphens, not starting with a dot.",
    );
  }
  return slug;
}

// `.campaign-runtime/funnels/<route>`: a funnel's runtime directory when it is
// not the project's first, relative to the target repo.
export function funnelRuntimeRelPath(routeSlug) {
  return `${FUNNEL_RUNTIME_PARENT_REL_PATH}/${routeComponent(routeSlug)}`;
}

// `campaign-runtime-<route>.build.json`: the packet of a funnel that is not
// the project's first.
export function funnelPacketFilename(routeSlug) {
  return `campaign-runtime-${routeComponent(routeSlug)}.build.json`;
}

// The runtime directory a packet's records live under, relative to its target
// repo (and, for the QA verdict sidecar and Run Records, to the packet's own
// directory). A packet that records no `assembly.runtime_dir` uses the
// project-level `.campaign-runtime`, as every packet did before per-funnel
// records, so an existing project reads its records where they already are.
// A recorded value must be one of the two shapes for this packet's route:
// anything else could point one funnel at another's records, so it is refused
// rather than followed.
export function packetRuntimeRelPath(packet) {
  const declared = packet?.assembly?.runtime_dir;
  if (declared === undefined || declared === null || declared === RUNTIME_DIR_REL_PATH) return RUNTIME_DIR_REL_PATH;
  const slug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (typeof declared === "string" && ROUTE_COMPONENT.test(slug) && declared === `${FUNNEL_RUNTIME_PARENT_REL_PATH}/${slug}`) return declared;
  throw new Error(
    `Build Packet assembly.runtime_dir ${JSON.stringify(declared)} is not this funnel's runtime directory: `
    + `it must be "${RUNTIME_DIR_REL_PATH}" or "${FUNNEL_RUNTIME_PARENT_REL_PATH}/<campaign.public_route_slug>"`
    + `${slug ? ` ("${FUNNEL_RUNTIME_PARENT_REL_PATH}/${slug}")` : ""}. Restore the value prepare-build wrote, or re-run prepare-build.`,
  );
}

// The target repo a packet builds into.
export function targetRepoFor(packetPath, packet) {
  const packetDir = dirname(resolve(packetPath));
  const declared = packet?.assembly?.target_repo;
  return typeof declared === "string" && declared.trim() ? resolve(packetDir, declared) : packetDir;
}

// The default location of every build sidecar a funnel carries: under the
// target repo's project-level `.campaign-runtime/` unless the packet records
// its own runtime directory (packetRuntimeRelPath).
export function campaignSidecarPaths(targetRepo, runtimeRelPath = RUNTIME_DIR_REL_PATH) {
  const runtimeDir = join(targetRepo, runtimeRelPath);
  return {
    runtimeDir,
    contextPath: join(runtimeDir, basename(BUILD_CONTEXT_REL_PATH)),
    reportPath: join(runtimeDir, basename(ASSEMBLY_REPORT_REL_PATH)),
    doctorOutPath: join(runtimeDir, basename(DOCTOR_SIDECAR_REL_PATH)),
    qaOutputDir: join(targetRepo, QA_OUTPUT_REL_PATH),
  };
}

// The report a printed remediation must name, or null. `checkpoint waive`,
// `theme waive` and `polish capture` all default to the packet-inferred
// <target repo>/.campaign-runtime/assembly-report.json, so a command printed
// for a report that came from anywhere else (--report, or a Build Context
// binding) has to carry `--report <path>` or it acts on a different report —
// possibly one that does not exist. Quiet in the common case: null when the
// report IS that default, so the printed command stays short; the path when
// it is not, or when the target repo is unknown and the default cannot be
// ruled out. Doctor's report and the QA runner's both print through this.
// `runtimeRelPath` is the packet's runtime directory (packetRuntimeRelPath),
// since that is where those commands infer the report for that packet.
export function explicitReportPath(reportPath, targetRepo, runtimeRelPath = RUNTIME_DIR_REL_PATH) {
  if (typeof reportPath !== "string" || !reportPath) return null;
  const inferred = typeof targetRepo === "string" && targetRepo ? campaignSidecarPaths(targetRepo, runtimeRelPath).reportPath : null;
  return reportPath !== inferred ? reportPath : null;
}

// Best-effort read of the Build Context for the report binding only: a
// missing or malformed context binds nothing. A caller that must refuse a
// malformed context reads it again strictly. Any other read failure (a
// permission error, a directory where the file should be) is not absence:
// binding the default report over it would record a stage outcome into a
// report the campaign is not bound to, so it reaches the caller.
function readContextForBinding(contextPath) {
  if (!contextPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(contextPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (absentOrMalformed(error)) return null;
    throw error;
  }
}

// The one resolver. `contextPath` / `reportPath` / `doctorOutPath` are the
// operator's explicit choices, resolved by the caller from whichever flag it
// owns: a string is used as given, `null` switches that sidecar off (no
// context to bind from; `reportPath: null`), `undefined` derives the default.
//
// `followContextPointer` is required on purpose. The Build Context records
// where prepare-build wrote the report (`--report-out`), relative to the
// target repo. A stage that follows it acts on the report the campaign is
// bound to; one that does not acts on the default sidecar. Both are
// legitimate (doctor's stage write-back must not restate its outcome into a
// report it did not inspect), but a stage that never said which is how the QA
// stage came to be recorded into a report `next` never reads. Say it.
//
// A context binds a report for the packet it names: prepare-build writes
// `packet_path` beside `report_path`, and when two packets of one campaign
// share a target repo the default context belongs to whichever ran last, so
// a pointer from a context naming another packet is not followed. A context
// naming no packet binds by location, as it always did.
export function resolveCampaignWorkspace(packetPath, {
  packet = undefined,
  contextPath = undefined,
  reportPath = undefined,
  doctorOutPath = undefined,
  followContextPointer,
} = {}) {
  if (typeof followContextPointer !== "boolean") {
    throw new TypeError("resolveCampaignWorkspace requires followContextPointer: true (act on the report the Build Context binds) or false (act on the default sidecar).");
  }
  const absolutePacketPath = resolve(packetPath);
  const loadedPacket = packet === undefined ? JSON.parse(readFileSync(absolutePacketPath, "utf8")) : packet;
  const baseDir = dirname(absolutePacketPath);
  const targetRepo = targetRepoFor(absolutePacketPath, loadedPacket);
  const runtimeRelPath = packetRuntimeRelPath(loadedPacket);
  const defaults = campaignSidecarPaths(targetRepo, runtimeRelPath);
  const resolvedContextPath = contextPath === undefined ? defaults.contextPath : contextPath;
  const context = followContextPointer ? readContextForBinding(resolvedContextPath) : null;
  const recorded = typeof context?.report_path === "string" && context.report_path.trim() ? context.report_path.trim() : null;
  const named = typeof context?.packet_path === "string" && context.packet_path.trim() ? context.packet_path.trim() : null;
  // Both sides must be on disk: a pointer naming a packet that is not there
  // cannot be shown to name this one.
  const bound = recorded && (!named || sameFile(resolve(targetRepo, named), absolutePacketPath, { requireExisting: true }));

  const resolvedReportPath = reportPath !== undefined
    ? reportPath
    : bound
      ? resolve(targetRepo, recorded)
      : defaults.reportPath;
  return {
    packet: loadedPacket,
    packetPath: absolutePacketPath,
    baseDir,
    targetRepo,
    // The funnel's runtime directory under the target repo, and the same
    // directory beside the packet (QA verdict sidecar, Run Records).
    runtimeRelPath,
    runtimeDir: defaults.runtimeDir,
    packetRuntimeDir: join(baseDir, runtimeRelPath),
    contextPath: resolvedContextPath,
    reportPath: resolvedReportPath,
    defaultReportPath: defaults.reportPath,
    doctorOutPath: doctorOutPath === undefined ? defaults.doctorOutPath : doctorOutPath,
    qaOutputDir: defaults.qaOutputDir,
  };
}

// ---------------------------------------------------------------------------
// Several funnels in one project.

function readJsonState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { state: "present", value: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent", value: null };
    if (absentOrMalformed(error)) return { state: "present", value: null };
    throw error;
  }
}

function routeOf(packet) {
  return normalizePublicRouteSlug(packet?.campaign?.public_route_slug) || null;
}

// The root-level Build Packets of a project, default name first, then one per
// additional funnel by name, each with the route it names (null when the
// packet names none), its generated_at instant in milliseconds (null when it
// records none it can parse) and whether it could be read at all.
export function projectFunnelPackets(root) {
  const projectRoot = resolve(root);
  let names = [];
  try {
    names = readdirSync(projectRoot);
  } catch {
    names = [];
  }
  const ordered = [
    ...(names.includes(DEFAULT_PACKET_FILENAME) ? [DEFAULT_PACKET_FILENAME] : []),
    ...names.filter((name) => FUNNEL_PACKET_PATTERN.test(name)).sort(),
  ];
  const packets = [];
  for (const name of ordered) {
    const path = join(projectRoot, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const { value } = readJsonState(path);
    const generated = typeof value?.generated_at === "string" ? Date.parse(value.generated_at) : Number.NaN;
    packets.push({ name, path, route: routeOf(value), readable: Boolean(value), generatedAt: Number.isFinite(generated) ? generated : null });
  }
  return packets;
}

// The packet a command acts on when it was given no --packet, chosen the way
// readback discovers one: null when there is none, the only readable packet,
// or among packets that all name one route (later runs of one funnel) the
// newest by generated_at, the default name first on a tie. Packets naming
// different routes are different funnels, and picking one would read or write
// another funnel's records, so that is refused with every packet named.
export function soleProjectPacket(root, { command = "this command" } = {}) {
  const packets = projectFunnelPackets(root);
  const readable = packets.filter((packet) => packet.readable);
  if (!readable.length) return packets[0]?.path || null;
  if (new Set(readable.map((packet) => packet.route)).size > 1) {
    const listed = readable.map((packet) => `${packet.name} (route ${packet.route || "unnamed"})`).join(", ");
    throw Object.assign(new Error(
      `${resolve(root)} holds Build Packets for ${new Set(readable.map((packet) => packet.route)).size} funnels: ${listed}. `
      + `Pass --packet <packet> to ${command} to name the funnel to act on.`,
    ), { code: "MULTIPLE_FUNNEL_PACKETS", packets: readable.map((packet) => packet.path) });
  }
  const newest = readable.reduce((best, packet) => ((packet.generatedAt ?? -Infinity) > (best.generatedAt ?? -Infinity) ? packet : best));
  return newest.path;
}

// The route the project-level records belong to: undefined when there are
// none, the route the Assembly Report (else the Build Context's packet) names,
// or null when records exist but name no route anyone can read.
function projectRecordsRoute(targetRepo) {
  const defaults = campaignSidecarPaths(targetRepo);
  const report = readJsonState(defaults.reportPath);
  const context = readJsonState(defaults.contextPath);
  if (report.state === "absent" && context.state === "absent") return undefined;
  const reported = normalizePublicRouteSlug(report.value?.identity?.public_route_slug);
  if (reported) return reported;
  const named = typeof context.value?.packet_path === "string" && context.value.packet_path.trim()
    ? resolve(targetRepo, context.value.packet_path.trim())
    : null;
  return named ? routeOf(readJsonState(named).value) : null;
}

/**
 * Where prepare-build puts one funnel's packet and records.
 *
 * Packet: an explicit `--out` wins. Otherwise the default
 * `campaign-runtime.build.json` when it is this route's, else the funnel's own
 * `campaign-runtime-<route>.build.json` when it already exists, else the
 * default when it is absent, else the funnel's own name. A Build Packet that
 * exists at the chosen path for another route, or one whose route cannot be
 * read, is replaced only with `force`: that is the operator saying this
 * funnel takes the other's place (renaming a funnel's route), never a side
 * effect of naming a path.
 *
 * Records: a packet already at that path for this route keeps the runtime
 * directory it records (the project-level one when it records none and those
 * records are this route's or absent). A packet replaced with `force` whose records are the
 * project-level ones hands those to this funnel, so renaming a project's first
 * funnel keeps the default layout. Otherwise the funnel's own directory when
 * it already exists, else the project-level `.campaign-runtime` when it holds
 * no records or this route's, else the funnel's own directory. Records another
 * route owns, or records whose route cannot be read, are never replaced.
 *
 * Returns `{ packetPath, runtimeRelPath, scoped, addedBeside }`; `scoped` is
 * true when the packet must record `assembly.runtime_dir`, and `addedBeside`
 * names the default packet and its route when this run sets the funnel up as
 * a new one beside it (null otherwise).
 */
export function planFunnelWorkspace(targetRepo, routeSlug, { packetPath: explicitPacketPath = null, force = false } = {}) {
  const repo = resolve(targetRepo);
  const slug = normalizePublicRouteSlug(routeSlug);
  const nameable = ROUTE_COMPONENT.test(slug);
  const rootPacket = join(repo, DEFAULT_PACKET_FILENAME);
  const ownPacket = nameable ? join(repo, funnelPacketFilename(slug)) : null;
  const rootPacketState = readJsonState(rootPacket);
  const rootPacketRoute = routeOf(rootPacketState.value);

  let packetPath = explicitPacketPath ? resolve(explicitPacketPath) : null;
  if (!packetPath) {
    const rootPacketFree = rootPacketState.state === "absent" || rootPacketRoute === slug;
    packetPath = rootPacketRoute === slug ? rootPacket
      : ownPacket && existsSync(ownPacket) ? ownPacket
        : rootPacketFree || !ownPacket ? rootPacket
          : ownPacket;
    if (!rootPacketFree && packetPath === rootPacket && !force) {
      throw new Error(
        `${rootPacket} belongs to route ${rootPacketRoute || "(unreadable)"}, and route ${JSON.stringify(slug)} cannot name a packet of its own. `
        + "Pass --out <packet> to keep this funnel's packet elsewhere, or set a public route slug of letters, digits, dots, underscores and hyphens.",
      );
    }
  }

  const existingState = readJsonState(packetPath);
  const existing = existingState.value;
  const existingRoute = routeOf(existing);
  const replacing = isBuildPacketAt(packetPath, existingState) && existingRoute !== slug;
  if (replacing && !force) {
    throw new Error(
      `${packetPath} is the Build Packet of route ${existingRoute || "(unreadable)"}, not ${JSON.stringify(slug)}; replacing it would leave that funnel's records with no packet. `
      + "Pass a different --out to set this funnel up beside it, or --force to replace that funnel with this one (renaming its route).",
    );
  }
  const addedBeside = !replacing && existingState.state === "absent" && packetPath !== rootPacket
    && rootPacketState.state === "present" && rootPacketRoute !== slug
    ? { packetPath: rootPacket, route: rootPacketRoute }
    : null;
  const plan = (runtimeRelPath) => ({ packetPath, runtimeRelPath, scoped: runtimeRelPath !== RUNTIME_DIR_REL_PATH, addedBeside });

  const owner = projectRecordsRoute(repo);
  if (existing && existingRoute === slug) {
    if (existing.assembly?.runtime_dir != null) return plan(packetRuntimeRelPath(existing));
    if (owner === undefined || owner === slug) return plan(RUNTIME_DIR_REL_PATH);
  }
  if (replacing && existing && replacedRuntimeRelPath(existing) === RUNTIME_DIR_REL_PATH
    && (owner === undefined || owner === null || owner === existingRoute || owner === slug)) {
    return plan(RUNTIME_DIR_REL_PATH);
  }
  const ownRuntime = nameable ? funnelRuntimeRelPath(slug) : null;
  if (ownRuntime && existsSync(join(repo, ownRuntime))) return plan(ownRuntime);
  if (owner === undefined || owner === slug) return plan(RUNTIME_DIR_REL_PATH);
  if (!ownRuntime) {
    throw new Error(
      `${join(repo, RUNTIME_DIR_REL_PATH)} holds the records of route ${owner || "(unreadable)"}, and route ${JSON.stringify(slug)} cannot name a runtime directory of its own. `
      + "Set a public route slug of letters, digits, dots, underscores and hyphens.",
    );
  }
  return plan(ownRuntime);
}

// Whether the file at `path` is a Build Packet another funnel may own: a
// packet by its contents, or a file at a packet's name that cannot be read.
// Any other file there is left to prepare-build's output collision checks.
function isBuildPacketAt(path, { state, value }) {
  if (state !== "present") return false;
  if (value) {
    return (typeof value.schema_version === "string" && value.schema_version.startsWith("campaign-runtime-build-packet/"))
      || (value.campaign !== null && typeof value.campaign === "object" && !Array.isArray(value.campaign));
  }
  const name = basename(path);
  return name === DEFAULT_PACKET_FILENAME || FUNNEL_PACKET_PATTERN.test(name);
}

// The runtime directory a packet being replaced keeps its records in, or null
// when its recorded value is not one prepare-build writes.
function replacedRuntimeRelPath(packet) {
  try {
    return packetRuntimeRelPath(packet);
  } catch {
    return null;
  }
}
