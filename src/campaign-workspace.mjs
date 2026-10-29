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

export function routeNamesFunnelDirectory(routeSlug) {
  return ROUTE_COMPONENT.test(normalizePublicRouteSlug(routeSlug));
}

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

// Every default location of one packet's records: the build sidecars under
// its target repo, and `packetRuntimeDir`, the same runtime directory beside
// the packet, where the QA verdict sidecar and Run Records go.
export function packetSidecarPaths(packetPath, packet) {
  const runtimeRelPath = packetRuntimeRelPath(packet);
  return {
    ...campaignSidecarPaths(targetRepoFor(packetPath, packet), runtimeRelPath),
    runtimeRelPath,
    packetRuntimeDir: join(dirname(resolve(packetPath)), runtimeRelPath),
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
// packet cannot be read or names none).
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
    packets.push({ name, path, route: routeOf(value) });
  }
  return packets;
}

// The packet a command acts on when it was given no --packet: the project's
// only packet, null when there is none, and a refusal naming every packet
// when the project holds more than one funnel. Picking one of several would
// read or write another funnel's records.
export function soleProjectPacket(root, { command = "this command" } = {}) {
  const packets = projectFunnelPackets(root);
  if (packets.length <= 1) return packets[0]?.path || null;
  const listed = packets.map((packet) => `${packet.name}${packet.route ? ` (route ${packet.route})` : ""}`).join(", ");
  throw Object.assign(new Error(
    `${resolve(root)} holds ${packets.length} Build Packets, one per funnel: ${listed}. `
    + `Pass --packet <packet> to ${command} to name the funnel to act on.`,
  ), { code: "MULTIPLE_FUNNEL_PACKETS", packets: packets.map((packet) => packet.path) });
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
 * Packet: an explicit `--out` wins. Otherwise the funnel's own
 * `campaign-runtime-<route>.build.json` when it already exists, else the
 * default `campaign-runtime.build.json` when it is absent or already this
 * route's, else the funnel's own name. A default packet for another route is
 * never replaced.
 *
 * Records: a packet already at that path for this route keeps the runtime
 * directory it records. Otherwise the funnel's own directory when it already
 * exists, else the project-level `.campaign-runtime` when it holds no records
 * or this route's, else the funnel's own directory. Records another route owns,
 * or records whose route cannot be read, are never replaced.
 *
 * Returns `{ packetPath, runtimeRelPath, scoped }`; `scoped` is true when the
 * packet must record `assembly.runtime_dir`.
 */
export function planFunnelWorkspace(targetRepo, routeSlug, { packetPath: explicitPacketPath = null } = {}) {
  const repo = resolve(targetRepo);
  const slug = normalizePublicRouteSlug(routeSlug);
  const nameable = ROUTE_COMPONENT.test(slug);
  const rootPacket = join(repo, DEFAULT_PACKET_FILENAME);
  const ownPacket = nameable ? join(repo, funnelPacketFilename(slug)) : null;

  let packetPath = explicitPacketPath ? resolve(explicitPacketPath) : null;
  if (!packetPath) {
    const rootPacketState = readJsonState(rootPacket);
    const rootPacketFree = rootPacketState.state === "absent" || routeOf(rootPacketState.value) === slug;
    packetPath = ownPacket && existsSync(ownPacket) ? ownPacket
      : rootPacketFree || !ownPacket ? rootPacket
        : ownPacket;
    if (!rootPacketFree && packetPath === rootPacket) {
      throw new Error(
        `${rootPacket} belongs to route ${routeOf(rootPacketState.value) || "(unreadable)"}, and route ${JSON.stringify(slug)} cannot name a packet of its own. `
        + "Pass --out <packet> to keep this funnel's packet elsewhere, or set a public route slug of letters, digits, dots, underscores and hyphens.",
      );
    }
  }

  const existing = readJsonState(packetPath).value;
  if (existing && routeOf(existing) === slug && existing.assembly?.runtime_dir != null) {
    const runtimeRelPath = packetRuntimeRelPath(existing);
    return { packetPath, runtimeRelPath, scoped: runtimeRelPath !== RUNTIME_DIR_REL_PATH };
  }
  const ownRuntime = nameable ? funnelRuntimeRelPath(slug) : null;
  if (ownRuntime && existsSync(join(repo, ownRuntime))) return { packetPath, runtimeRelPath: ownRuntime, scoped: true };
  const owner = projectRecordsRoute(repo);
  if (owner === undefined || owner === slug) return { packetPath, runtimeRelPath: RUNTIME_DIR_REL_PATH, scoped: false };
  if (!ownRuntime) {
    throw new Error(
      `${join(repo, RUNTIME_DIR_REL_PATH)} holds the records of route ${owner || "(unreadable)"}, and route ${JSON.stringify(slug)} cannot name a runtime directory of its own. `
      + "Set a public route slug of letters, digits, dots, underscores and hyphens.",
    );
  }
  return { packetPath, runtimeRelPath: ownRuntime, scoped: true };
}
