// Campaign workspace: where a Build Packet's sidecars live, resolved once.
//
// Two roots matter. The TARGET REPO — `packet.assembly.target_repo` resolved
// against the packet's directory, else that directory — carries the build
// sidecars under `.campaign-runtime/` (Build Context, Assembly Report, doctor
// output) and the local QA verdicts under `qa-output/`. The packet's own
// directory (`baseDir`) carries what is written beside the packet: run
// records, the committed QA verdict sidecar, the run session. The two
// coincide for a packet kept at the target root and diverge for
// `prepare-build --out` elsewhere, which is exactly when a stage spelling the
// rule for itself drifts: one wrote doctor output beside the packet while
// every other stage wrote it to the target, and the QA stage was recorded
// into the default report while `next` read the report the Build Context
// bound. Every stage now derives its paths here.
//
// A leaf: node built-ins and the sidecar leaves only, so cli.mjs and the QA
// runner import it alike.

import { existsSync, readFileSync } from "node:fs";
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

// Best-effort read of the Build Context for the report binding: a missing or
// malformed context binds nothing. Callers that must refuse a malformed
// context read it again strictly; this read exists only to follow the pointer.
function readContextForBinding(contextPath) {
  if (!contextPath || !existsSync(contextPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(contextPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The one resolver. `contextPath` / `reportPath` / `doctorOutPath` are the
// operator's explicit choices, already resolved by the caller from whichever
// flag it owns: a string is used as given, `null` switches that sidecar off
// (`contextPath: null` reads no context and binds nothing; `reportPath: null`
// yields `reportPath: null`), and `undefined` derives the default.
//
// `followContextPointer` is required, and deliberately so. The Build Context
// records where prepare-build wrote the report (`--report-out`), relative to
// the target repo. A stage that follows that pointer reads and writes the
// report the campaign is bound to; a stage that does not acts on the default
// sidecar whatever the context says. Both are legitimate — doctor's stage
// write-back must not restate its outcome into a report it did not inspect —
// but a stage that never said which it does is how the QA stage came to be
// recorded into a report `next` never reads. Say it.
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
  const resolvedReportPath = reportPath !== undefined
    ? reportPath
    : recorded
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
