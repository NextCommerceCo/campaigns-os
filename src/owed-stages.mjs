import { readJsonIfExists } from "./cli-helpers.mjs";
import { resolveCampaignWorkspace } from "./campaign-workspace.mjs";
import { testOrderCurrenciesForBuild } from "./qc-results.mjs";

// The currencies the CampaignSpec lists that this build has no test order in,
// once the build has a test order at all (`buildCurrencies`, the set qa run's
// currency-coverage row reads). These are next's qa_run_currency runs.
export function owedTestOrderCurrencies(spec, buildCurrencies = () => new Set()) {
  const listed = Array.isArray(spec?.campaign?.available_currencies) ? spec.campaign.available_currencies : [];
  const codes = [...new Set(listed.filter((code) => typeof code === "string" && /^[A-Za-z]{3}$/.test(code)).map((code) => code.toUpperCase()))];
  if (codes.length < 2) return [];
  const covered = buildCurrencies();
  if (!covered.size) return [];
  return codes.filter((code) => !covered.has(code));
}

// What is owed beyond the Polish and QA debt doctor --ci reads: the deploy a
// rebuild made required, and, once doctor's stage picker (`picked`, the
// doctor read's `next`) finds every stage done, the currencies still owed a
// test order, which next reports as stage qa with qa_run_currency actions.
// next, record build and after-edit print their "Owed stages" line from this
// one decision.
export function owedStages({ picked, report, spec, buildCurrencies }) {
  return {
    deploy: report?.stages?.deploy?.status === "required",
    currencies: picked?.stage === "done" ? owedTestOrderCurrencies(spec, buildCurrencies) : [],
  };
}

// Why next reports stage qa when every stage is recorded but currencies are owed.
export function owedCurrencyReason(codes) {
  return `Every stage is recorded, but this build has no test order in ${codes.join(" or ")}, which the CampaignSpec lists, so QA owes those runs.`;
}

// The same decision for a caller holding only the packet and the doctor read
// over it (record build, after-edit); `report` is the composed report when it
// is not the one on disk (a dry run). Best-effort: an unreadable report or
// spec owes nothing extra here, and doctor reports either one itself. An
// unreadable spec drops only the currencies: the deploy reads the report
// alone, as next's does.
export function readOwedStages({ picked, packetPath, specPath = null, report: composed = null }) {
  let workspace;
  let report;
  try {
    workspace = resolveCampaignWorkspace(packetPath, { followContextPointer: true });
    report = composed ?? readJsonIfExists(workspace.reportPath);
  } catch {
    return { deploy: composed?.stages?.deploy?.status === "required", currencies: [] };
  }
  let spec = null;
  try {
    spec = specPath ? readJsonIfExists(specPath) : null;
  } catch {
    spec = null;
  }
  const { targetRepo, reportPath } = workspace;
  try {
    return owedStages({ picked, report, spec, buildCurrencies: () => testOrderCurrenciesForBuild({ report, targetRepo, packetPath, reportPath }) });
  } catch {
    return { deploy: report?.stages?.deploy?.status === "required", currencies: [] };
  }
}
