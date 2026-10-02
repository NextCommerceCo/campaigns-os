// Invocation policy: which cross-cutting steps run around a command, and in
// what order. One owner for rules that used to be restated at each step — the
// pre-dispatch bypasses, the stale-session sweep and its root, the ambient
// run-session read, the lifecycle wrapper, the journal exemptions, the
// commands that implement --dry-run, and the QA auto-end trigger.
//
// The declaration below is data: a class, a sweep root kind and a few flags
// per command, and per subcommand only where the subcommand differs from its
// command. It describes kernel behaviour and is never a permission
// interpreter: contracts/effects.v1.json is bound to it by a test, never read
// here. The steps themselves (the sweep, the ambient read, the journal append,
// the auto-end, every handler) stay in cli.mjs and are handed to
// runInvocation() as functions; this module decides only whether and when each
// runs. It imports nothing from cli.mjs.

import { runWithRefusalScope, withCommandLifecycle } from "./lifecycle.mjs";

// Frozen all the way down, so a caller handed a subcommand list cannot edit it.
const frozen = (value) => { if (value && typeof value === "object") Object.values(value).forEach(frozen); return Object.freeze(value); };

// The steps each pre-dispatch class runs. `auth` and `inline` commands run
// their handler in place: no sweep, no ambient read, no wrapper, no journal.
// `inspection` still resolves the ambient session and is wrapped, but never
// sweeps or journals. `projection` (`readback`) is wrapped only: its --packet
// is an override naming the Build Packet to project, not a session locator.
// Read as one, the named file was loaded whole past readback's own size bound,
// and a valid override exited 1 whenever some active session was bound to a
// different packet; neither belongs to a command declared read-only.
const CLASS_STEPS = frozen({
  auth: [], inline: [],
  inspection: ["wrapper", "ambient"],
  projection: ["wrapper"],
  standard: ["wrapper", "ambient", "sweep", "journal"],
});

// Every top-level command, in the order did-you-mean breaks ties. Fields:
// `class` (default "standard"); `sweepRoot` ("target": the --target directory,
// "session": the run-session root; default none); `dryRun` (the command
// implements --dry-run); `journalExempt`; `journalExemptWhen` (exempt when the
// `given` flag is set and the `unlessBare` flag is not bare: an inspection must
// not append to a delivered campaign's active run);
// `subcommands` (the only subcommand names that resolve; others inherit the
// command's entry and are refused by the handler).
//
// `dryRun` marks only the commands that IMPLEMENT the flag. It reaches every
// handler through a permissive parseArgs, and an exemption scoped to the flag
// alone once fired on commands that ignore it: `qa run --dry-run` placed orders
// while writing no journal entry, and carried the flag into its own auto-end,
// which assembled no Run Record and left the session open. A command without
// `dryRun` given --dry-run journals if it otherwise would, and is not refused.
const COMMANDS = frozen({
  help: { journalExempt: true },
  login: { class: "auth" },
  logout: { class: "auth" },
  demo: { class: "inline" },
  tooling: { subcommands: ["diagnose", "setup", "status"] },
  sdk: { subcommands: ["storage-check"] },
  readback: { class: "projection" },
  start: { sweepRoot: "target" },
  "prepare-build": { sweepRoot: "target" },
  build: { sweepRoot: "target" },
  doctor: { journalExemptWhen: { given: "packet", unlessBare: "write" } },
  bundle: { subcommands: ["check"] },
  standardize: {},
  theme: { subcommands: ["generate", "inspect", "waive"] },
  checkpoint: { subcommands: ["waive"] },
  polish: { subcommands: ["capture"] },
  record: { subcommands: ["build", "deploy", "polish", "setup", "theme"] },
  "validate-assembly-report": {},
  "install-agent-context": { dryRun: true },
  "install-skills": { dryRun: true },
  "page-kit": { subcommands: ["parity", "sync"] },
  spec: { subcommands: ["derive"] },
  next: { subcommands: ["build", "deploy", "polish", "qa", "setup"] },
  qa: { subcommands: ["install-browser", "parity", "policy", "promote", "publish", "resolve", "run", "waive"] },
  findings: { subcommands: ["add", "export", "harvest", "list"] },
  "run-record": { dryRun: true },
  telemetry: { subcommands: ["list", "off", "on", "status"] },
  run: { subcommands: ["end", "start", "status"] },
});

// Where a subcommand's policy differs from its command's entry. Matched on the
// explicit subcommand token only: bare `run` defaults to `status` inside its
// handler, but is not `run status` here, so it journals.
const SUBCOMMAND_OVERRIDES = frozen({
  "tooling diagnose": { class: "inline" },
  "tooling setup": { class: "inline" },
  "sdk storage-check": { class: "inspection" },
  "theme waive": { dryRun: true },
  "checkpoint waive": { dryRun: true },
  "page-kit sync": { dryRun: true },
  "spec derive": { dryRun: true },
  "qa publish": { dryRun: true },
  "record build": { dryRun: true },
  "record deploy": { dryRun: true },
  "record polish": { dryRun: true },
  "record setup": { dryRun: true },
  "record theme": { dryRun: true },
  "qa run": { autoEnd: true },
  "run start": { sweepRoot: "session" },
  "run end": { sweepRoot: "session", dryRun: true },
  "run status": { journalExempt: true },
});

export const commandNames = () => Object.keys(COMMANDS);

export const subcommandNames = (command) => (Object.hasOwn(COMMANDS, command) && COMMANDS[command].subcommands) || frozen([]);

// A run opted out of sessions altogether: no stale sweep, and no intake
// auto-start (which reads this predicate from here).
export const optsOutOfRunSession = (args) => args["no-run-session"] === true;

// The policy for one invocation. Two --dry-run predicates are deliberate and
// differ: on a command implementing the flag, its PRESENCE suppresses the
// sweep (a valued flag the handler will refuse still does nothing first), while
// only a bare `--dry-run` exempts the journal (the install commands accept a
// valued flag as a dry run and still journal it). The sweep writes a Run
// Record, deletes the session file and (under consent) remits — every effect
// --dry-run promises not to have — so the stale session stays stale until a
// real invocation closes it. --no-write suppresses both too: inheriting it
// into the closeout suppressed the Run Record but still deleted the session
// file. A refused invocation never journals either; that rule is per outcome,
// not per argv, and stays with the journal append.
export function resolveInvocationPolicy(command, args) {
  const subcommand = subcommandNames(command).includes(args._[1]) ? args._[1] : null;
  const rule = { class: "standard", ...(Object.hasOwn(COMMANDS, command) && COMMANDS[command]), ...(subcommand && SUBCOMMAND_OVERRIDES[`${command} ${subcommand}`]) };
  const steps = CLASS_STEPS[rule.class];
  const noWrite = args["no-write"] === true;
  const implementsDryRun = rule.dryRun === true;
  const sweepSuppressed = optsOutOfRunSession(args) || noWrite || (Object.hasOwn(args, "dry-run") && implementsDryRun);
  const inspection = Boolean(rule.journalExemptWhen && args[rule.journalExemptWhen.given] && args[rule.journalExemptWhen.unlessBare] !== true);
  return Object.freeze({
    class: rule.class,
    wrapper: steps.includes("wrapper"), ambient: steps.includes("ambient"),
    sweepRoot: steps.includes("sweep") && !sweepSuppressed ? rule.sweepRoot || null : null,
    journalExempt: !steps.includes("journal") || rule.journalExempt === true || noWrite || (args["dry-run"] === true && implementsDryRun) || inspection,
    implementsDryRun, autoEnd: rule.autoEnd === true,
  });
}

// The sequence main() delegates to. `steps` are cli.mjs mechanisms:
//   dispatch(command, args, { recorder?, ambient?, sessionHolder? }?)
//   closeOutStaleRunSessions(rootKind, args) -> the closed-out stale sessions
//   ambientRunSession(args) -> the active session, or null
//   lifecycleIdentity(args, ambient) -> { argvShape, runId }
//   persistLifecycle(args, command, lifecycle, sessionHolder, thrown)
//   autoEndAfterQa(args, sessionHolder, thrown, implementsDryRun)
// Order: normalise argv, open the refusal scope, run an unwrapped class in
// place, else sweep, read the ambient session, and wrap dispatch; on finish
// (success or error) journal unless exempt, then run the QA auto-end. The
// sweep precedes the ambient read so a stale session at the root is closed out
// (findRunSession ignores it) rather than abandoned with no Run Record. The
// wrapper re-throws unchanged, so the exit code is the command's own; a
// command that throws is recorded too. Persistence stays opt-in: with no
// --lifecycle-journal, CAMPAIGNS_OS_LIFECYCLE_LOG or active session nothing is
// written.
export async function runInvocation(args, steps) {
  // `npx … campaigns-os <command>` hands the bin its own name as the first
  // positional: it is the program name, not a command.
  if (args._[0] === "campaigns-os") args._.shift();
  const command = args._[0] || "help";
  const policy = resolveInvocationPolicy(command, args);
  // One refusal scope per invocation, so a refusal is visible only to this
  // invocation's persistence step.
  return runWithRefusalScope(async () => {
    if (!policy.wrapper) return steps.dispatch(command, args);
    const sweptStale = policy.sweepRoot ? await steps.closeOutStaleRunSessions(policy.sweepRoot, args) : [];
    const ambient = policy.ambient ? steps.ambientRunSession(args) : null;
    // Per invocation, never module state: an intake that opens or joins a run
    // session mid-command publishes it here, so this command's own entry is
    // persisted into it.
    const sessionHolder = { current: ambient, autoStarted: false, adopted: false, qaResult: null, sweptStale };
    await withCommandLifecycle(
      {
        command,
        ...steps.lifecycleIdentity(args, ambient),
        onFinish: async (lifecycle, thrown) => {
          if (!policy.journalExempt) steps.persistLifecycle(args, command, lifecycle, sessionHolder, thrown);
          if (policy.autoEnd) await steps.autoEndAfterQa(args, sessionHolder, thrown, policy.implementsDryRun);
        },
      },
      (recorder) => steps.dispatch(command, args, { recorder, ambient, sessionHolder }),
    );
  });
}
