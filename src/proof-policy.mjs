// Proof policy: the order-path depth a Build Packet declares, the one flag
// that sets it, and the one text that names the drift between the packet and
// the Assembly Report's mirror of it.
//
// `qa.proof_policy.order_path_depth` is seeded by prepare-build/start and
// mirrored into `report.proof_policy` at the same moment. The two are compared
// by `assessPurchaseProofCoverage` (cli.mjs): a disagreement is `unknown`,
// never one side's value. Doctor, `next` and the coverage reason all describe
// that state through the single action below, so the command an operator is
// told to run is spelled once. A leaf: gate-actions only.

import { requiredActionText } from "./gate-actions.mjs";

// The depths the setter accepts. `off` declares an intentional no-order run
// (`--test-order off` is then a diagnostic that owes no purchase proof);
// `common` and `full` match the `--test-order` modes of the same name.
export const ORDER_PATH_DEPTHS = Object.freeze(["off", "common", "full"]);

export const ORDER_PATH_DEPTH_FLAG = "order-path-depth";

export function isOrderPathDepth(value) {
  return typeof value === "string" && ORDER_PATH_DEPTHS.includes(value);
}

// The one spelling of "the packet and the report disagree": both present and
// different once case is ignored. `orderPathDepthDrift` (doctor and the
// coverage assessment) and the `next` action branch both ask this.
export function orderPathDepthsDisagree(packetDepth, reportDepth) {
  return typeof packetDepth === "string" && typeof reportDepth === "string"
    && packetDepth.trim() !== "" && reportDepth.trim() !== ""
    && packetDepth.toLowerCase() !== reportDepth.toLowerCase();
}

// `--order-path-depth <off|common|full>`, validated with the other argv checks
// of whichever command carries it (`command` names it in the error). A bare
// flag parses as `true`; that is an operator's explicit intent with no value,
// so it is refused rather than silently defaulted. Case is ignored on input
// and the lower-case canonical form is what gets stored (`Off` writes `off`),
// matching the case-insensitive drift comparison. Returns null when the flag
// is absent.
export function parseOrderPathDepthFlag(args, { command = "qa policy set" } = {}) {
  const raw = args?.[ORDER_PATH_DEPTH_FLAG];
  if (raw === undefined) return null;
  const accepted = `Accepted values: ${ORDER_PATH_DEPTHS.join(", ")}.`;
  if (raw === true || raw === null || String(raw).trim() === "") {
    throw new Error(`${command}: --${ORDER_PATH_DEPTH_FLAG} needs a value. ${accepted}`);
  }
  const typed = String(raw).trim();
  const value = typed.toLowerCase();
  if (!isOrderPathDepth(value)) {
    throw new Error(`${command}: unsupported --${ORDER_PATH_DEPTH_FLAG} ${JSON.stringify(typed)}. ${accepted}`);
  }
  return value;
}

export const ORDER_PATH_DEPTH_DRIFT_CODE = "qa.proof_policy.order_path_depth_drift";

// The one action that reconciles a packet/report depth disagreement: rewrite
// the depth through the setter, which writes the packet field and refreshes
// the report mirror in the same run. The packet's value is offered when the
// setter accepts it (the packet is author intent); a hand-edited value outside
// the accepted set leaves the choice to the operator.
export function orderPathDepthReconcileAction({ packetDepth = null, reportDepth = null } = {}) {
  const depth = isOrderPathDepth(packetDepth) ? packetDepth : `<${ORDER_PATH_DEPTHS.join("|")}>`;
  return Object.freeze({
    id: ORDER_PATH_DEPTH_DRIFT_CODE,
    kind: "command",
    command: `campaigns-os qa policy set --packet <packet> --${ORDER_PATH_DEPTH_FLAG} ${depth}`,
    description: `The build packet declares an order-path depth of ${JSON.stringify(packetDepth ?? "unspecified")} while the assembly report's mirror of it reads ${JSON.stringify(reportDepth ?? "unspecified")}; neither is trusted until they agree.`,
  });
}

// The text doctor's warning, the coverage reason and the `next` action all
// carry for that state: the description, then the runnable command with the
// packet substituted (or the bare template when no packet path is known). A
// caller that already rendered the command (to publish it as the action's
// `command`) passes it in, so the prose and the action carry one string.
export function orderPathDepthDriftText({ packetDepth = null, reportDepth = null, packetPath = null, command = null } = {}) {
  const action = orderPathDepthReconcileAction({ packetDepth, reportDepth });
  const rendered = typeof command === "string" && command ? command : requiredActionText(action, { packetPath });
  return `${action.description} Reconcile them with \`${rendered}\`, which writes the packet field and refreshes the report mirror together.`;
}
