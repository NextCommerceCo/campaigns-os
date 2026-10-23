import { assessEvidenceDebt } from "../evidence-debt.mjs";

export const DOCTOR_CI_EXIT_CODES = Object.freeze({ current: 0, owed: 3, unknown: 4, usage: 2 });

export function assessDoctorCi(inputs) {
  const debt = assessEvidenceDebt(inputs);
  const stages = [debt.polish, debt.qa];
  // Any known debt is owed; otherwise incomplete evidence remains unknown.
  const status = stages.some((stage) => stage.status === "owed") ? "owed"
    : stages.some((stage) => stage.status === "unknown") ? "unknown" : "current";
  return { status, exit_code: DOCTOR_CI_EXIT_CODES[status], ...debt };
}

// Values can come from campaign files and will be rendered in a PR comment.
// Encode punctuation as well as HTML: diagnostics are plain text, and may
// contain Markdown, autolinks, code fences or line breaks from campaign files.
const text = (value) => String(value).replace(/\s/g, " ")
  .replace(/[!-/:-@\[-`{-~]/g, (char) => `&#${char.charCodeAt(0)};`);
// Inline code already protects ordinary path punctuation; preserve those
// bytes for readable page paths and issue codes, while preventing breakouts.
const code = (value) => `\`${String(value).replace(/\s/g, " ")
  .replace(/[!-/:-@\[-`{-~]/g, (char) => "./_-".includes(char) ? char : `&#${char.charCodeAt(0)};`)}\``;

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
  const owed = ["polish", "qa"].filter((stage) => ci[stage].status === "owed");
  lines.push(`Owed stages: ${owed.length ? owed.join(", ") : "none"}.`);
  for (const page of ci.changes.changed_pages) {
    lines.push(`- Changed page: ${code(page.page_id)} (${code(page.built_path)})`);
  }
  if (!ci.changes.changed_pages.length && owed.length) {
    lines.push("Changed page ids unavailable: the retained assembly manifest may already describe the rebuilt output.");
  }
  for (const stage of ["polish", "qa"]) {
    if (ci[stage].status === "unknown") lines.push(`- Unknown ${stage}: ${code(ci[stage].reason)}`);
  }
  if (ci.changes.status === "unknown") lines.push(`- Unknown page changes: ${code(ci.changes.reason)}`);
  if (ci.status === "owed" || ci.status === "unknown") {
    lines.push("", "Remedy: build and record the current output; re-run `campaigns-os polish capture --packet <packet> --base-url <served-current-build-url>` and record it with `campaigns-os record polish --packet <packet> --evidence <polish-evidence.json>`. Re-run `campaigns-os qa run --packet <packet>` to record QA for this build.");
  }
  lines.push("", `Doctor inspection: ${(result.errors || []).length} error(s), ${(result.warnings || []).length} warning(s); CI exit status depends only on evidence debt.`);
  if (result.errors?.length) {
    lines.push(`Doctor errors: ${[...new Set(result.errors.map((issue) => issue.code))].map(code).join(", ")}.`);
  }
  lines.push("Use ordinary `doctor` or `--ci --json` for full inspection details.");
  return lines.join("\n");
}
