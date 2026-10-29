import { worseChangeKind } from "../change-scope.mjs";
import { assessEvidenceDebt } from "../evidence-debt.mjs";

export const DOCTOR_CI_EXIT_CODES = Object.freeze({ current: 0, owed: 3, unknown: 4, usage: 2 });

export function assessDoctorCi(inputs) {
  const debt = assessEvidenceDebt(inputs);
  // Advisory Polish (a page-only change) is reported, never required.
  const stages = [debt.polish, debt.qa].filter((stage) => !stage.advisory);
  // Any known debt is owed; otherwise incomplete evidence remains unknown.
  const status = stages.some((stage) => stage.status === "owed") ? "owed"
    : stages.some((stage) => stage.status === "unknown") ? "unknown" : "current";
  return { status, exit_code: DOCTOR_CI_EXIT_CODES[status], ...debt };
}

// What the change owes, from the stages it left owed: "pages" when the only
// required stage is QA on the changed pages (Polish advisory or current),
// "full" when a full stage is owed, null when nothing is owed. `kind` is the
// worst change kind among the owed stages.
export function ciChangeScope(ci) {
  const owed = ["polish", "qa"].filter((stage) => ci[stage]?.status === "owed");
  if (!owed.length) return { scope: null, kind: null };
  const kind = owed.map((stage) => ci[stage].change?.kind || "unknown").reduce(worseChangeKind, "none");
  const required = owed.filter((stage) => !ci[stage].advisory);
  const scope = required.every((stage) => stage === "qa" && ci.qa.scope === "pages") ? "pages" : "full";
  return { scope, kind };
}

// Page ids come from built routes ([A-Za-z0-9_-]); anything else is encoded.
const pageArg = (id) => (/^[A-Za-z0-9_-]+$/.test(String(id)) ? String(id) : text(id));

const commerceReasonText = new Map([
  ["unmapped_file", "a file outside any page changed"],
  ["page_added", "a page was added"],
  ["page_removed", "a page was removed"],
  ["checkout_page", "a checkout page changed"],
  ["commerce_markup_changed", "package, offer, shipping, upsell, route or script markup changed"],
  ["commerce_signature_unavailable", "the recorded build has no commerce signature to compare against"],
  ["campaign_config_changed", "the campaign's Page Kit config (SDK pin, analytics ids, store fields) changed"],
  ["campaign_config_unavailable", "the campaign's Page Kit config entry could not be read"],
  ["change_history_unavailable", "the rebuilds since the reviewed build were not kept"],
]);

// Values can come from campaign files and will be rendered in a PR comment.
// Encode punctuation as well as HTML: diagnostics are plain text, and may
// contain Markdown, autolinks, code fences or line breaks from campaign files.
const text = (value) => String(value).replace(/\s/g, " ")
  .replace(/[!-/:-@\[-`{-~]/g, (char) => `&#${char.charCodeAt(0)};`);
// Inline code already protects ordinary path punctuation; preserve those
// bytes for readable page paths and issue codes, while preventing breakouts.
const code = (value) => `\`${String(value).replace(/\s/g, " ")
  .replace(/[!-/:-@\[-`{-~]/g, (char) => "./_-".includes(char) ? char : `&#${char.charCodeAt(0)};`)}\``;

const unavailablePageChanges = new Map([
  ["packet_unavailable", "the build packet or its path is unavailable."],
  ["build_output_location_unknown", "the built output location cannot be determined."],
  ["build_output_missing", "the built output is missing."],
  ["build_output_unreadable", "the built output could not be read."],
  ["assembly_build_fingerprint_missing", "the assembly build fingerprint is missing."],
  ["build_output_pages_unresolved", "the built output could not be mapped to pages."],
  ["build_manifest_unavailable", "no usable assembly manifest is available."],
]);

const requiredStageReasons = new Map([
  ["stage_required_by_build", "the build requires this stage again"],
  ["stage_required_by_brief", "the brief requires this stage again"],
  ["stage_required_by_spec", "the spec requires this stage again"],
  ["stage_required", "the lifecycle requires this stage again"],
]);

export function doctorCiFailure(error, { usage = false } = {}) {
  return {
    ok: false, status: "blocked",
    errors: [{ code: usage ? "doctor.ci.packet" : "doctor.ci.failed", message: String(error?.message ?? error) }],
    warnings: [], exit_code: usage ? DOCTOR_CI_EXIT_CODES.usage : DOCTOR_CI_EXIT_CODES.unknown,
  };
}

// Presentation boundary only: invocation policy still decides session and
// lifecycle behavior. Setup can throw before doctor's dispatch branch runs.
export async function withDoctorCiReport(args, invoke) {
  const command = args._[0] === "campaigns-os" ? args._[1] : args._[0];
  try {
    return await invoke(args);
  } catch (error) {
    if (command !== "doctor" || args.ci !== true) throw error;
    const result = doctorCiFailure(error);
    console.log(args.json ? JSON.stringify(result, null, 2) : formatDoctorCi(result));
    process.exitCode = result.exit_code;
  }
}

export function formatDoctorCi(result) {
  const ci = result.ci;
  if (!ci) {
    return [
      `## Campaign evidence: could not evaluate (exit ${result.exit_code ?? DOCTOR_CI_EXIT_CODES.usage})`, "",
      ...(result.errors || []).map((issue) => `- ${code(issue.code)}: ${text(issue.message)}`), "",
      "Remedy: correct the packet or inspection failure and re-run `campaigns-os doctor --packet <packet> --ci --no-live-refs`.",
    ].join("\n");
  }
  const lines = [`## Campaign evidence: ${text(ci.status)} (exit ${ci.exit_code})`, ""];
  const advisory = ["polish", "qa"].filter((stage) => ci[stage].status === "owed" && ci[stage].advisory);
  const owed = ["polish", "qa"].filter((stage) => ci[stage].status === "owed" && !ci[stage].advisory);
  const change = ciChangeScope(ci);
  const pageScoped = change.scope === "pages";
  if (pageScoped) {
    lines.push(`Change found: page-only. ${owed.length ? `It owes QA on ${ci.qa.owed_pages.map((page) => code(page.page_id)).join(", ")}` : "QA is current"}; Polish is advisory.`);
  } else if (change.scope === "full") {
    const reasons = [...new Set((ci.polish.change?.reasons || []).concat(ci.qa.change?.reasons || [])
      .map((reason) => commerceReasonText.get(reason.code)).filter(Boolean))];
    const found = change.kind === "commerce_affecting" ? "commerce-affecting"
      : change.kind === "page_only" ? "page-only, but an input change or a Polish or QA that did not complete requires the full stages" : "not classified";
    // Name only the stages that count, each at the scope it is owed: an
    // advisory Polish is not owed, and QA can still be owed on pages only.
    const qaPages = ci.qa.scope === "pages" ? `QA on ${ci.qa.owed_pages.map((page) => code(page.page_id)).join(", ")}` : null;
    const owes = owed.length === 2 ? (qaPages ? `the full Polish, and ${qaPages}` : "the full Polish and QA")
      : owed[0] === "polish" ? "the full Polish" : qaPages || "a full QA run";
    lines.push(`Change found: ${found}${reasons.length ? ` (${reasons.join("; ")})` : ""}. It owes ${owes}${advisory.includes("polish") ? "; Polish is advisory" : ""}.`);
  }
  lines.push(`Owed stages: ${owed.length ? owed.map((stage) => stage === "qa" && ci.qa.scope === "pages" ? "qa (changed pages only)" : stage).join(", ") : "none"}.`);
  for (const stage of owed) {
    const reason = ci[stage].reason === "build_fingerprint_changed"
      ? "the recorded build fingerprint differs from the current build"
      : requiredStageReasons.get(ci[stage].reason) ?? "the recorded stage evidence is owed";
    lines.push(`- Owed ${stage}: ${reason}.`);
  }
  for (const stage of advisory) {
    lines.push(`- Advisory ${stage}: the change since its last review is page-only, so it is reported and not required.`);
  }
  // The pages changed since the builds the owed stages reviewed, which
  // record build keeps; without them, the drift from the assembly manifest.
  const sincePages = new Map();
  for (const stage of [...owed, ...advisory]) {
    for (const page of ci[stage].change?.changed_pages || []) sincePages.set(page.built_path, page);
  }
  const changedPages = sincePages.size ? [...sincePages.values()] : ci.changes.changed_pages;
  for (const page of changedPages) {
    lines.push(`- Changed page: ${code(page.page_id)} (${code(page.built_path)})`);
  }
  if (!changedPages.length && (owed.length || ci.changes.status === "unknown")) {
    lines.push(ci.changes.status === "unknown"
      ? `Changed pages unavailable: ${unavailablePageChanges.get(ci.changes.reason) ?? "the page-change reason is unrecognized."}`
      : "Changed page ids unavailable: the retained assembly manifest may already describe the rebuilt output.");
  }
  for (const stage of ["polish", "qa"]) {
    if (ci[stage].status === "unknown") lines.push(`- Unknown ${stage}: ${code(ci[stage].reason)}`);
  }
  if (ci.changes.status === "unknown") lines.push(`- Unknown page changes: ${code(ci.changes.reason)}`);
  if (ci.status === "owed" && pageScoped && owed.length) {
    const pages = ci.qa.owed_pages.map((page) => ` --page ${pageArg(page.page_id)}`).join("");
    const recorded = ci.changes.recorded_build_fingerprint && ci.changes.recorded_build_fingerprint === ci.changes.current_build_fingerprint;
    lines.push("", `Remedy: ${recorded ? "" : "run `campaigns-os record build --packet <packet>` for the rebuilt output, then "}run \`campaigns-os qa run --packet <packet>${pages}\` against that build. Polish capture is optional for a page-only change.`);
  } else if (ci.status === "owed" || ci.status === "unknown") {
    const matchingRequired = owed.length > 0
      && owed.every((stage) => requiredStageReasons.has(ci[stage].reason) && ci[stage].matches_current_build === true)
      && ["polish", "qa"].every((stage) => ci[stage].status !== "unknown");
    if (matchingRequired) {
      const commands = [];
      if (owed.includes("polish")) commands.push("`campaigns-os polish capture --packet <packet> --base-url <served-current-build-url>` for the whole route", "`campaigns-os record polish --packet <packet> --evidence <polish-evidence.json>`");
      if (owed.includes("qa")) commands.push("`campaigns-os qa run --packet <packet>`");
      lines.push("", `Remedy: re-run the required stages against the existing build: ${commands.join(", then ")}.`);
    } else {
      lines.push("", "Remedy: rebuild, then run `campaigns-os record build --packet <packet>`, `campaigns-os polish capture --packet <packet> --base-url <served-current-build-url>` for the whole route, and `campaigns-os record polish --packet <packet> --evidence <polish-evidence.json>`, in that order. When QA is owed, run `campaigns-os qa run --packet <packet>` against that build.");
    }
  }
  lines.push("", `Doctor inspection: ${(result.errors || []).length} error(s), ${(result.warnings || []).length} warning(s); CI exit status depends only on evidence debt.`);
  if (result.errors?.length) {
    lines.push(`Doctor errors: ${[...new Set(result.errors.map((issue) => issue.code))].map(code).join(", ")}.`);
  }
  lines.push("Use ordinary `doctor` or `--ci --json` for full inspection details.");
  return lines.join("\n");
}
