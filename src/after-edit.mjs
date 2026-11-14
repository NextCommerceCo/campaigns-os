import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { requireArg } from "./cli-helpers.mjs";
import { resolveCampaignWorkspace } from "./campaign-workspace.mjs";
import { computeBuildFingerprint } from "./built-site-scope.mjs";
import { doctorCommand, readDoctorLiveCampaign } from "./doctor/inspect.mjs";
import { ciChangeScope, doctorCiFailure, formatDoctorCi } from "./doctor/ci.mjs";
import { recordCommand } from "./stage-record.mjs";
import { PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND } from "./page-kit-build-summary.mjs";
import { normalizePublicRouteSlug } from "./route-identity.mjs";
import { cmd } from "./install-invocation.mjs";
import { shellToken } from "./shell-token.mjs";
import { refused } from "./lifecycle.mjs";

const FLAGS = ["_", "packet", "yes", "proxy-base", "no-live-refs", "run-qa", "json"];
const STEPS = ["spec", "build_current", "record_build", "spec_derive", "owed", "files"];
const portable = (path) => path.split(sep).join("/");

function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  }).sort();
}

// Only orchestration lives here. The functions supplied by cli.mjs are the
// standalone spec handlers; records and the CI assessment use their handlers
// directly. Only the page QA the assessment names can run here.
export async function afterEditCommand(args, { specFetch, specDerive, specDeriveTextLines, fetchImpl, runQa, recordQaStageOutcome } = {}) {
  if (Object.hasOwn(args, "no-write")) throw refused("after-edit writes records; use doctor --ci as the read-only way to ask what is owed.");
  const unknown = Object.keys(args).filter((key) => !FLAGS.includes(key));
  if (unknown.length) throw refused(`Unknown flag${unknown.length > 1 ? "s" : ""} for after-edit: ${unknown.map((key) => `--${key}`).join(", ")}. Known flags: ${FLAGS.slice(1).map((key) => `--${key}`).join(", ")}.`);
  if (args._?.length > 1) throw refused("after-edit takes no positional arguments; use --packet <campaign-runtime.build.json>.");
  for (const key of ["yes", "no-live-refs", "run-qa", "json"]) {
    if (Object.hasOwn(args, key) && args[key] !== true) throw refused(`--${key} is a boolean flag and takes no value.`);
  }
  if (Object.hasOwn(args, "proxy-base")) requireArg(args, "proxy-base");
  const packetPath = resolve(requireArg(args, "packet"));
  const result = { ok: false, action: "after-edit", packet_path: packetPath, steps: [], stopped_at: null, ci: null, files: [], next: null };
  const base = { packet: packetPath, ...(args["proxy-base"] ? { "proxy-base": args["proxy-base"] } : {}) };
  const live = { ...base, ...(args["no-live-refs"] ? { "no-live-refs": true } : {}) };
  const packetFlag = `--packet ${shellToken(packetPath)}`;
  const rerun = `${cmd("after-edit")} ${packetFlag}${args["proxy-base"] ? ` --proxy-base ${shellToken(args["proxy-base"])}` : ""}${args["no-live-refs"] ? " --no-live-refs" : ""}${args["run-qa"] ? " --run-qa" : ""}`;
  const add = (step, status, detail, command) => result.steps.push({ step, status, detail, ...(command ? { command } : {}) });
  let workspace;
  const written = new Set();
  const remember = (paths) => { for (const path of paths || []) written.add(resolve(path)); };
  // Standalone writers also invalidate a retained doctor snapshot. Include
  // that file and spec fetch's gitignore repair when their bytes change.
  let ancillary = [];
  const finish = () => {
    for (const [path, before] of ancillary) {
      const after = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (before !== after) written.add(path);
    }
    const root = workspace?.targetRepo || dirname(packetPath);
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    result.files = [...new Set([...written].map((path) => portable(relative(realRoot, existsSync(path) ? realpathSync(path) : path))))].sort();
    for (const step of [...STEPS.slice(0, -1), ...(args["run-qa"] ? ["run_qa"] : [])]) {
      if (!result.steps.some((row) => row.step === step)) add(step, "not_run", "An earlier step stopped the command.");
    }
    add("files", result.files.length ? "done" : "not_needed", result.files.length ? `Files to commit:\n${result.files.map((path) => `- ${path}`).join("\n")}` : "Files to commit: none (nothing was written).");
    return result;
  };
  const stop = (step, detail, command) => {
    result.stopped_at = step;
    result.next = command;
    add(step, "stopped", detail, command);
    return finish();
  };
  const reason = (value) => (value.errors || []).map((issue) => issue.message).join(" ") || "The command could not continue.";
  const fetchNext = `${cmd("spec")} fetch ${packetFlag}${args["proxy-base"] ? ` --proxy-base ${shellToken(args["proxy-base"])}` : ""}`;
  try {
    workspace = resolveCampaignWorkspace(packetPath, { followContextPointer: true });
  } catch (error) {
    // Let spec fetch supply its own packet-read refusal, too.
    const fetched = await specFetch({ _: ["spec", "fetch"], ...base }, { fetchImpl });
    return stop("spec", reason(fetched), fetchNext);
  }
  ancillary = [workspace.doctorOutPath, join(workspace.targetRepo, ".gitignore")]
    .map((path) => [path, existsSync(path) ? readFileSync(path, "utf8") : null]);
  const local = workspace.packet.spec?.local_path;
  const specPath = typeof local === "string" && local.trim() ? resolve(dirname(packetPath), local) : null;
  if (specPath && existsSync(specPath)) add("spec", "not_needed", "CampaignSpec copy is present.");
  else {
    const fetched = await specFetch({ _: ["spec", "fetch"], ...base }, { fetchImpl });
    if (fetched.status === "restored") remember([fetched.spec_path]);
    if (!fetched.ok) return stop("spec", reason(fetched), fetchNext);
    add("spec", fetched.status === "restored" ? "done" : "not_needed", fetched.ready.join("\n"));
  }

  const slug = normalizePublicRouteSlug(workspace.packet.campaign?.public_route_slug);
  const output = slug ? join(workspace.targetRepo, "_site", slug) : null;
  const buildCommand = PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND;
  let current;
  try {
    const built = output && existsSync(output) && statSync(output).isDirectory() ? filesUnder(output) : [];
    if (!built.length) return stop("build_current", `Built output ${output ? portable(relative(workspace.targetRepo, output)) : "_site/<slug>/"} is missing or empty; run the Page Kit build.`, buildCommand);
    const newest = Math.max(...built.map((path) => statSync(path).mtimeMs));
    const config = join(workspace.targetRepo, "_data", "campaigns.json");
    // The page tree is the packet's assembly.output_dir when it declares one
    // (as spec derive reads it), else Page Kit's src/<route>/.
    const declared = typeof workspace.packet.assembly?.output_dir === "string" ? workspace.packet.assembly.output_dir.trim() : "";
    const pageTree = declared ? resolve(workspace.targetRepo, declared) : join(workspace.targetRepo, "src", slug);
    const sources = [...filesUnder(pageTree), ...(existsSync(config) ? [config] : [])];
    const newer = sources.find((path) => statSync(path).mtimeMs > newest);
    if (newer) return stop("build_current", `${portable(relative(workspace.targetRepo, newer))} is newer than the newest built file; run the Page Kit build.`, buildCommand);
    current = computeBuildFingerprint(output);
  } catch (error) {
    return stop("build_current", error.message, buildCommand);
  }
  add("build_current", "not_needed", "Built output is current with the source.");
  const recordBuildNext = `${cmd("record")} build ${packetFlag}`;
  try {
    const report = existsSync(workspace.reportPath) ? JSON.parse(readFileSync(workspace.reportPath, "utf8")) : null;
    if (current.ok && report?.stages?.assembly?.build_fingerprint === current.fingerprint) add("record_build", "not_needed", "Build is already recorded.");
    else {
      const recorded = await recordCommand({ _: ["record", "build"], packet: packetPath });
      remember(recorded.written);
      add("record_build", "done", [
        `Recorded the build (${recorded.build_fingerprint.replace(/^sha256:/, "").slice(0, 12)}).`,
        ...recorded.ready.filter((line) => line.startsWith("stages.assembly.build_changes:")),
      ].join("\n"));
    }
  } catch (error) {
    return stop("record_build", error.message, recordBuildNext);
  }

  const assess = async (assessment = result) => {
    let doctor;
    try {
      const doctorArgs = { _: ["doctor"], ...live, ci: true };
      const liveCampaign = await readDoctorLiveCampaign(doctorArgs, { ...(fetchImpl ? { fetchImpl } : {}) });
      doctor = doctorCommand(doctorArgs, { liveCampaign });
    } catch (error) {
      doctor = doctorCiFailure(error);
    }
    assessment.ci = doctor.ci ?? null;
    assessment.next = null;
    const ci = doctor.ci;
    // A failed inspection has no assessment object; retain only its exit code
    // here, with its errors rendered by formatDoctorCi in the owed step.
    if (!ci) assessment.exit_code = doctor.exit_code;
    assessment.ok = Boolean(ci);
    if (ci?.status !== "current") {
      if (ci?.polish.status === "owed" && !ci.polish.advisory) assessment.next = `${cmd("polish")} capture ${packetFlag} --base-url <served-current-build-url>`;
      else if (ci?.qa.status === "owed") assessment.next = `${cmd("qa")} run ${packetFlag}${ci.qa.scope === "pages" ? ci.qa.owed_pages.map((page) => ` --page ${shellToken(page.page_id)}`).join("") : ""}${ci.qa.browser_pages?.length ? " --browser" : ""}`;
      else assessment.next = `${cmd("doctor")} ${packetFlag} --ci --no-live-refs`;
    }
    return doctor;
  };

  const deriveArgs = { _: ["spec", "derive"], ...live };
  const deriveNext = `${cmd("spec")} derive ${packetFlag}${args["no-live-refs"] ? " --no-live-refs" : ""}${args["proxy-base"] ? ` --proxy-base ${shellToken(args["proxy-base"])}` : ""}`;
  let deriveDetail = "";
  let deriveCommand = deriveNext;
  try {
    const plan = await specDerive({ ...deriveArgs, "dry-run": true }, { fetchImpl });
    if (!plan.ok) return stop("spec_derive", specDeriveTextLines(plan).join("\n"), deriveNext);
    if (!plan.changes.length) add("spec_derive", "not_needed", "Spec is current.");
    else {
      deriveDetail = specDeriveTextLines({ ...plan, warnings: plan.warnings.filter((issue) => issue.code !== "spec.derive.build_stale") }).join("\n");
      if (!args.yes) {
        const owed = formatDoctorCi(await assess({}));
        const preview = stop("spec_derive", `${deriveDetail}\nApplying this preview with --yes changes the CampaignSpec and will owe Polish and QA again.\nRe-run with --yes to write the derived spec.`, `${rerun} --yes`);
        // Text-only assessment: the unapplied preview keeps JSON steps unchanged.
        Object.defineProperty(preview, "preview_owed", { value: owed });
        return preview;
      }
      const derived = await specDerive(deriveArgs, { fetchImpl });
      if (derived.written) remember([derived.spec_path]);
      deriveDetail += `\n${specDeriveTextLines(derived).join("\n")}`;
      if (!derived.ok) return stop("spec_derive", deriveDetail, deriveNext);
      if (derived.next?.startsWith(`${cmd("record")} spec `)) {
        deriveCommand = `${cmd("record")} spec ${packetFlag}`;
        const recorded = await recordCommand({ _: ["record", "spec"], packet: packetPath });
        remember(recorded.written);
        deriveDetail += `\nrecord spec: ${recorded.note}${recorded.notices?.length ? `\n${recorded.notices.join("\n")}` : ""}`;
      }
      add("spec_derive", "done", deriveDetail);
    }
  } catch (error) {
    return stop("spec_derive", `${deriveDetail}${deriveDetail ? "\n" : ""}${error.message}`, deriveCommand);
  }

  const doctor = await assess();
  add("owed", result.ci?.status === "current" ? "not_needed" : "done", formatDoctorCi(doctor));
  if (args["run-qa"]) {
    const ci = result.ci;
    if (!ci || ci.status === "unknown") return stop("run_qa", formatDoctorCi(doctor), result.next);
    if (ci.status === "current") {
      add("run_qa", "not_needed", "QA is current.");
      return finish();
    }
    if (ciChangeScope(ci).scope !== "pages" || ci.qa.status !== "owed" || ci.qa.scope !== "pages"
      || !(ci.polish.status === "current" || ci.polish.advisory) || !ci.qa.owed_pages.length) {
      return stop("run_qa", "The change owes the full Polish and QA. The full QA places test orders and needs the project manager's go.", result.next);
    }
    const qaArgs = { _: ["qa", "run"], ...live, page: ci.qa.owed_pages.map((page) => page.page_id), ...(ci.qa.browser_pages?.length ? { browser: true } : {}) };
    const qaCommand = result.next;
    let qa;
    let failure;
    try {
      qa = await runQa(qaArgs);
      result.qa = { status: qa.status, verdict_path: qa.local_path };
      // Raw qa-output is local; the portable verdict and stage records are
      // the committed evidence. The recorder refreshes the doctor sidecar.
      if (qa.qa_sidecar?.path) remember([qa.qa_sidecar.path]);
      if (qa.verdict && recordQaStageOutcome(qaArgs, qa)) remember([workspace.reportPath]);
    } catch (error) {
      failure = error.message;
    }
    const after = await assess();
    const summary = qa ? [
      "QA run complete.",
      `Disposition: ${qa.status}`,
      ...(qa.status === "ready_with_exceptions" ? ["This is a passing proof with exceptions. Report these exceptions to the operator; do not clear or waive them, or change markup just to make them pass."] : []),
      ...(qa.counts ? [`Counts: ${Object.entries(qa.counts).map(([status, count]) => `${count} ${status}`).join(", ")}`] : []),
      ...(qa.verdict?.assertions || []).filter((row) => row.status === "fail").map((row) => `${row.id}: ${row.actual}`),
      ...(qa.local_path ? [`Local copy: ${qa.local_path}`] : []),
    ].join("\n") : failure;
    const detail = `${summary}${failure && qa ? `\n${failure}` : ""}\nOwed after QA:\n${formatDoctorCi(after)}`;
    if (failure || !qa?.ok || result.ci?.status !== "current") return stop("run_qa", detail, qaCommand);
    add("run_qa", "done", detail);
  }
  return finish();
}

export function afterEditExitCode(result) {
  return result.stopped_at ? 2 : result.ci?.exit_code ?? result.exit_code ?? 4;
}

export function afterEditTextLines(result) {
  const labels = { spec: "Spec copy:", build_current: "Build:", record_build: "Record build:", spec_derive: "Spec:", owed: "Owed:", run_qa: "Run QA:" };
  const rows = result.preview_owed ? [...result.steps, { step: "owed", status: "done", detail: result.preview_owed }] : result.steps;
  const lines = rows.filter((row) => row.status !== "not_run").sort((a, b) => Number(b.step === "owed") - Number(a.step === "owed")).map((row) => {
    const detail = row.step === "files" ? row.detail : `${labels[row.step]}${row.step === "owed" ? "\n" : " "}${row.detail}`;
    return `${detail}${row.status === "stopped" && row.command ? `\nNext: ${row.command}` : ""}`;
  });
  if (!result.stopped_at && result.next) lines.push(`Next: ${result.next}`);
  return lines;
}
