// Campaign workspace: where a Build Packet's sidecars live, resolved once.
//
// Two roots matter. The TARGET REPO (`packet.assembly.target_repo` resolved
// against the packet's directory, else that directory) carries the build
// sidecars under `.campaign-runtime/` and the local QA verdicts under
// `qa-output/`; the packet's own directory (`baseDir`) carries what is written
// beside the packet (run records, the committed QA verdict sidecar). They
// coincide for a packet at the target root and diverge for `prepare-build
// --out` elsewhere — exactly when a stage spelling the rule for itself drifts.
// A leaf: node built-ins and the sidecar leaves only.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DOCTOR_SIDECAR_REL_PATH } from "./doctor-sidecar.mjs";

export const BUILD_CONTEXT_REL_PATH = ".campaign-runtime/build-context.json";
export const ASSEMBLY_REPORT_REL_PATH = ".campaign-runtime/assembly-report.json";
export const QA_OUTPUT_REL_PATH = "qa-output";

// The target repo a packet builds into.
export function targetRepoFor(packetPath, packet) {
  const packetDir = dirname(resolve(packetPath));
  const declared = packet?.assembly?.target_repo;
  return typeof declared === "string" && declared.trim() ? resolve(packetDir, declared) : packetDir;
}

// The default location of every build sidecar a target repo carries.
export function campaignSidecarPaths(targetRepo) {
  return {
    contextPath: join(targetRepo, BUILD_CONTEXT_REL_PATH),
    reportPath: join(targetRepo, ASSEMBLY_REPORT_REL_PATH),
    doctorOutPath: join(targetRepo, DOCTOR_SIDECAR_REL_PATH),
    qaOutputDir: join(targetRepo, QA_OUTPUT_REL_PATH),
  };
}

// Best-effort read of the Build Context for the report binding only: a
// missing or malformed context binds nothing. A caller that must refuse a
// malformed context reads it again strictly.
function readContextForBinding(contextPath) {
  if (!contextPath || !existsSync(contextPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(contextPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function samePath(left, right) {
  if (resolve(left) === resolve(right)) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
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
  const defaults = campaignSidecarPaths(targetRepo);
  const resolvedContextPath = contextPath === undefined ? defaults.contextPath : contextPath;
  const context = followContextPointer ? readContextForBinding(resolvedContextPath) : null;
  const recorded = typeof context?.report_path === "string" && context.report_path.trim() ? context.report_path.trim() : null;
  const named = typeof context?.packet_path === "string" && context.packet_path.trim() ? context.packet_path.trim() : null;
  const bound = recorded && (!named || samePath(resolve(targetRepo, named), absolutePacketPath));
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
    contextPath: resolvedContextPath,
    reportPath: resolvedReportPath,
    defaultReportPath: defaults.reportPath,
    doctorOutPath: doctorOutPath === undefined ? defaults.doctorOutPath : doctorOutPath,
    qaOutputDir: defaults.qaOutputDir,
  };
}
