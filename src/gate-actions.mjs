// Gate actions: the vocabulary a checkpoint gate publishes as
// `required_actions[]` and the one rule that turns an action into the text an
// operator reads.
//
// A gate's action is `{ id, kind, command, description }`: a runnable command
// carrying the `--packet <packet>` placeholder, or a manual step with no
// command. Doctor, `next`, the QA runner's resolve printer and its theme-gate
// printer each rendered that shape for themselves — four spellings of the
// placeholder substitution — and the polish checkpoint's actions were declared
// once in polish-node and copied byte for byte into polish-gate, which
// polish-node imports and so could not import from. A leaf: shell-token only.

import { shellToken } from "./shell-token.mjs";
import { invocationPrefixFor } from "./install-mode.mjs";
import { dirname as installModeDirname, resolve as installModeResolve } from "node:path";
import { fileURLToPath as installModeFileUrl } from "node:url";
const PACKAGE_ROOT = installModeResolve(installModeDirname(installModeFileUrl(import.meta.url)), "..");

// The recorded actions of the hidden eager-media checkpoint, keyed by the
// short name each producer reaches for. The gate evaluators publish these
// objects unchanged; renderers never re-spell their text.
export const HIDDEN_EAGER_MEDIA_ACTIONS = Object.freeze({
  capture: Object.freeze({
    id: "polish.hidden_eager_media.capture",
    kind: "command",
    command: "campaigns-os polish capture --packet <packet> --base-url <url>",
    description: "Capture package-owned page-load evidence for every mapped route and fixed viewport.",
  }),
  install_browser: Object.freeze({
    id: "polish.hidden_eager_media.install_browser",
    kind: "command",
    command: "campaigns-os qa install-browser",
    description: "Install the package-owned Playwright Chromium runtime before rerunning polish capture (npm run qa:install-browser from a checkout).",
  }),
  waive: Object.freeze({
    id: "polish.hidden_eager_media.waive",
    kind: "command",
    command: "campaigns-os checkpoint waive --packet <packet> --gate polish.hidden_eager_media --reason \"<why>\" --waived-by \"<named human>\" --review-condition \"<trigger>\"",
    description: "Record an exact named-human waiver for the current hidden eager-media findings.",
  }),
  repair: Object.freeze({
    id: "polish.hidden_eager_media.repair",
    kind: "manual",
    command: null,
    description: "Make each reported hidden media element visible, defer it with exact preload=none/metadata, or reduce its aggregate transferred bytes to at most 1,048,576; then recapture.",
  }),
  repair_authority: Object.freeze({
    id: "polish.hidden_eager_media.repair_authority",
    kind: "manual",
    command: null,
    description: "Repair the packet or Assembly Report campaign identity, build fingerprint, and mapped route plan before capture.",
  }),
});

const PACKET_PLACEHOLDER = "--packet <packet>";

// The placeholder becomes the packet this run read, shell-quoted, so the
// command is copy-pasteable. A function replacement, so `$&`, `$$` or `$1`
// inside the path are inserted literally instead of being read as
// replacement patterns. No packet, or no command: returned as given.
export function substitutePacket(command, packetPath) {
  if (typeof command !== "string" || typeof packetPath !== "string" || !packetPath) return command;
  return command.replace(PACKET_PLACEHOLDER, () => `--packet ${shellToken(packetPath)}`);
}

// Whole-token match against the declared TEMPLATE, never the substituted
// string: a packet path that happens to contain "--report" must not be
// mistaken for an option the action declared, and a flag that merely shares
// the prefix (say --report-format) is not the option itself.
function templateDeclares(template, flag) {
  return typeof template === "string" && template.split(/\s+/).includes(flag);
}

// The text an operator acts on: the runnable command with the packet
// substituted, else the manual description, else nothing. With `reportPath`,
// a packet-scoped command that does not already name a report gains
// `--report <path>`, so a remediation acts on the report the inspection read
// rather than on the default sidecar it would otherwise resolve.
export function requiredActionText(action, { packetPath = null, reportPath = null } = {}) {
  const template = typeof action?.command === "string" ? action.command : null;
  let command = substitutePacket(template, packetPath);
  if (command && reportPath && templateDeclares(template, "--packet") && !templateDeclares(template, "--report")) {
    command = `${command} --report ${shellToken(reportPath)}`;
  }
  // Registry commands are stored bare; the printed text is spelled for the
  // install this package runs from (bare from a checkout, `npx campaigns-os`
  // from a campaign folder), once, here.
  if (command && command.startsWith("campaigns-os ")) {
    return `${invocationPrefixFor(PACKAGE_ROOT)} ${command.slice("campaigns-os ".length)}`;
  }
  if (command) return command;
  return typeof action?.description === "string" && action.description ? action.description : null;
}
