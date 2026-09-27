// How this install spells the commands it prints. ROOT resolves `..` from this
// file, so the module must stay directly under src/ to name the package root.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invocationPrefixFor } from "./install-mode.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Every command this CLI PRODUCES for an operator or agent to copy is spelled
// once, here, for the install it runs from (see install-mode.mjs): bare
// `campaigns-os` from a checkout, `npx --no-install campaigns-os` from a
// campaign folder that pins the toolkit, `npx --yes <spec>` from an npx cache.
// Result payloads are never rewritten after the fact — a path, a quoted
// argument or a data value that happens to contain the words is left exactly
// as it is.
function cmd(verb, rest = "") {
  const prefix = invocationPrefixFor(ROOT);
  return `${prefix} ${verb}${rest ? ` ${rest}` : ""}`;
}

// A registry command (gate actions, checkpoint remediations) is stored in its
// canonical bare form so internal bookkeeping can match on it; this spells
// it for the current install at the moment it is emitted.
function asInvocation(command) {
  if (typeof command !== "string" || !command.startsWith("campaigns-os ")) return command;
  return `${invocationPrefixFor(ROOT)} ${command.slice("campaigns-os ".length)}`;
}

export { ROOT, cmd, asInvocation };
