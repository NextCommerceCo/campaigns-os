// Synthetic helpers for the brief and spec row tests (Brief answers
// persist, Spec refresh: the F2.1-* and F2.2-* rows in src/input-*.test.mjs,
// src/stage-record.test.mjs, src/build-brief.test.mjs and
// src/prepare-build-report-guard.test.mjs). Imported only by those tests and
// never shipped (src/.npmignore). Every value here is synthetic. This module
// imports no Campaigns OS module, so importing it loads nothing under test.
//
// No network. withNetworkGuard(run) blocks and records every outbound
// connection while `run` executes, in this process and in every child `node`
// process the test starts:
// - in process, net.Socket.prototype.connect (which http, https, tls and
//   fetch all reach) and globalThis.fetch are replaced by stubs that record
//   the attempt and fail it;
// - child processes inherit the same stubs through NODE_OPTIONS
//   (--import of a data: URL, installed before any Campaigns OS module loads
//   in the child), recording each attempt to a log file this guard reads.
// After `run`, any recorded attempt fails the test. Local IPC pipes are not
// network and pass through.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

const NETWORK_LOG_ENV = "INPUT_TEST_NETWORK_LOG";

// Installs the stubs and returns a function that restores the originals. It
// is serialised into the child preload by toString(), so it closes over
// nothing: `netModule` and `record` are its only inputs.
function installSocketGuard(netModule, record) {
  const originalConnect = netModule.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  const targetOf = (args) => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === "object") {
      if (typeof first.path === "string" && first.path) return null;
      return `${first.host ?? first.hostname ?? "localhost"}:${first.port}`;
    }
    if (typeof first === "string" && !/^\d+$/.test(first)) return null;
    return `${typeof args[1] === "string" ? args[1] : "localhost"}:${first}`;
  };
  netModule.Socket.prototype.connect = function guardedConnect(...args) {
    const target = targetOf(args);
    if (target === null) return originalConnect.apply(this, args);
    record(`connect ${target}`);
    const socket = this;
    process.nextTick(() => socket.destroy(Object.assign(new Error(`network blocked by the test guard (${target})`), { code: "ECONNREFUSED" })));
    return socket;
  };
  globalThis.fetch = async function guardedFetch(input) {
    const target = String(input?.url ?? input);
    record(`fetch ${target}`);
    throw new TypeError(`fetch failed: network blocked by the test guard (${target})`);
  };
  return () => {
    netModule.Socket.prototype.connect = originalConnect;
    globalThis.fetch = originalFetch;
  };
}

const PRELOAD_SOURCE = [
  'import netModule from "node:net";',
  'import { appendFileSync } from "node:fs";',
  `(${installSocketGuard.toString()})(netModule, (line) => {`,
  `  const log = process.env.${NETWORK_LOG_ENV};`,
  '  if (log) appendFileSync(log, `${process.pid} ${line}\\n`);',
  "});",
].join("\n");
export const NETWORK_GUARD_IMPORT = `--import=data:text/javascript,${encodeURIComponent(PRELOAD_SOURCE)}`;

const inProcessAttempts = [];

/**
 * Runs `run` (sync or async) with the guard installed in this process and in
 * every child process, then asserts that no outbound connection was
 * attempted. Restores the environment and the stubs afterwards.
 */
export async function withNetworkGuard(run) {
  const dir = mkdtempSync(join(tmpdir(), "input-network-guard-"));
  const log = join(dir, "attempts.log");
  const keys = ["NODE_OPTIONS", NETWORK_LOG_ENV, "CAMPAIGNS_OS_TELEMETRY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_OPTIONS = [saved.NODE_OPTIONS, NETWORK_GUARD_IMPORT].filter(Boolean).join(" ");
  process.env[NETWORK_LOG_ENV] = log;
  process.env.CAMPAIGNS_OS_TELEMETRY = "off";
  const restore = installSocketGuard(net, (line) => inProcessAttempts.push(`${process.pid} ${line}`));
  let failure = null;
  let value;
  try {
    value = await run();
  } catch (error) {
    failure = error;
  } finally {
    restore();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  const attempts = [
    ...inProcessAttempts.splice(0),
    ...(existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  ];
  rmSync(dir, { recursive: true, force: true });
  if (failure) {
    if (attempts.length) failure.message += `\n(outbound requests were also attempted: ${attempts.join(", ")})`;
    throw failure;
  }
  assert.deepEqual(attempts, [], "no outbound request was attempted, in this process or any child process");
  return value;
}

// Every host a process tried to open a socket to, read from a NODE_DEBUG=net
// trace (the pattern of src/effects.test.mjs connectedHosts): the
// createConnection record names the host before any DNS lookup, and the
// "attempting to connect" line names the address that follows it.
export function connectedHosts(trace) {
  const hosts = new Set();
  for (const match of trace.matchAll(/^NET \d+: .*\bhost: '([^']*)'/gm)) if (match[1]) hosts.add(match[1]);
  for (const match of trace.matchAll(/attempting to connect to (\[[^\]]+\]|[^\s:]+):\d+/g)) hosts.add(match[1]);
  return [...hosts];
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const sha256Text = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

// Every file under `root` (recursively), as {path relative to root: sha256 of
// its bytes}. A missing root reads as no files.
export function treeDigest(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path).split("\\").join("/")] = entry.isFile() ? sha256File(path) : `non-file ${entry.isSymbolicLink() ? "symlink" : "entry"}`;
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}

// Asserts that no file under `root` was added, removed or rewritten since
// `before` (a treeDigest of the same root).
export function assertNothingWritten(root, before, what) {
  const after = treeDigest(root);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .map((path) => `${path} (${before[path] === undefined ? "added" : after[path] === undefined ? "removed" : "rewritten"})`)
    .sort();
  assert.deepEqual(changed, [], `${what} writes nothing: no file under the fixture directory is added, removed or rewritten`);
}

// The closed stage list (src/orchestration-stage-contract.mjs:1-9).
export const STAGE_KEYS = Object.freeze(["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"]);

// The closed refusal lists, in evaluation order (record brief outcomes;
// record spec outcomes).
export const RECORD_BRIEF_REFUSALS = Object.freeze([
  "brief_too_large",
  "brief_source_is_package_artifact",
  "brief_file_missing",
  "brief_path_ambiguous",
  "brief_inputs_unavailable",
  "spec_changed_run_record_spec",
  "page_scope_changed",
]);
export const RECORD_SPEC_REFUSALS = Object.freeze([
  "spec_unreadable",
  "spec_identity_changed",
  "page_scope_changed",
  "brief_too_large",
  "brief_source_is_package_artifact",
  "brief_file_missing",
]);
const ALL_REFUSALS = Object.freeze([...new Set([...RECORD_BRIEF_REFUSALS, ...RECORD_SPEC_REFUSALS])]);

// The doctor input warnings for brief and spec currency.
export const INPUT_WARNING_CODES = Object.freeze([
  "spec.material_stale",
  "spec.binding_unknown",
  "build_brief.material_changed",
  "build_brief.binding_unknown",
  "build_brief.input_unsaved",
  "assembly.output_unchanged_after_input_change",
  "assembly.output_unchanged_by_operator_decision",
]);

const namesWord = (text, word) => new RegExp(`(^|[^A-Za-z0-9_.])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(text);

// API assumption (every `record brief` / `record spec` refusal row): a refusal
// keeps the existing `record` refusal shape (src/stage-record.mjs refuseRecord)
// and exit code 1. The CLI prints
//   "record <brief|spec> refused; nothing was written:\n- <code>: <detail>"
// on stderr, and the refusal code is the first token of the first bullet,
// read by exact equality. No other code from the closed refusal lists
// appears anywhere in the output.
export function assertRecordRefusal(result, subcommand, code) {
  const list = subcommand === "brief" ? RECORD_BRIEF_REFUSALS : RECORD_SPEC_REFUSALS;
  assert.ok(list.includes(code), `test bug: ${code} is a record ${subcommand} refusal code`);
  const output = `${result.stdout}\n${result.stderr}`;
  const shape = new RegExp(`record ${subcommand} refused; nothing was written:\\s*(?:- )?([A-Za-z0-9_]+)`);
  const match = shape.exec(result.stderr);
  assert.ok(match, `record ${subcommand} printed its refusal ("record ${subcommand} refused; nothing was written:"); exit ${result.status}, stderr: ${result.stderr.slice(0, 600)}`);
  assert.equal(match[1], code, `the refusal code is exactly ${code}: ${result.stderr.slice(0, 600)}`);
  assert.equal(result.status, 1, "a refusal exits 1");
  for (const other of ALL_REFUSALS) {
    if (other !== code) assert.equal(namesWord(output, other), false, `no other refusal code is reported (found ${other}): ${output.slice(0, 600)}`);
  }
}

// A brief value whose pretty-printed JSON file is exactly `bytes` long: the
// padding sits in a key the operator added (the material projection keeps
// added keys, so this is a legitimate brief shape).
export function briefJsonOfSize(brief, bytes) {
  const base = `${JSON.stringify({ ...brief, operator_notes: "" }, null, 2)}\n`;
  const padding = bytes - Buffer.byteLength(base);
  assert.ok(padding > 0, "test bug: the base brief is already larger than the target size");
  return `${JSON.stringify({ ...brief, operator_notes: "n".repeat(padding) }, null, 2)}\n`;
}

// A brief with exactly `count` design_authority entries (one per synthetic page id).
export function briefWithDesignAuthorityEntries(brief, count) {
  const design_authority = Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `synthetic-page-${String(index).padStart(3, "0")}`,
    { source: "provided_design_export", reference: `synthetic-page-${index}.html` },
  ]));
  return { ...brief, design_authority };
}

// Reverses the key order of every object, recursively (arrays keep their order).
export function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
}
