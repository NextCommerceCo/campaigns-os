import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createDemo, resolveDemoTarget } from "./demo.mjs";
import { validateDemoArtifact } from "./demo-artifact.mjs";
import { buildRunSession, isRunSessionStale } from "./run-session.mjs";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "bin/campaigns-os.mjs");
const BUNDLE = join(ROOT, "demo/apollo-v0");
const scratch = () => mkdtempSync(join(realpathSync(tmpdir()), "campaigns-os-demo-test-"));
function tree(root) { return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? tree(join(root, entry.name)) : [[join(root, entry.name), readFileSync(join(root, entry.name)).toString("base64")]]); }
function cli(args, cwd, { preload } = {}) { return spawnSync(process.execPath, [...(preload ? ["--import", preload] : []), CLI, "demo", ...args], { cwd, encoding: "utf8", env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "on" } }); }

test("root-parent target resolution preserves the entire basename without accessing the filesystem root", () => {
  const parents = [];
  const resolveParent = parent => { parents.push(parent); return "/simulated-owned-parent"; };
  assert.equal(resolveDemoTarget("/tmp", { resolveParent }), "/simulated-owned-parent/tmp");
  assert.equal(resolveDemoTarget("/sample", { resolveParent }), "/simulated-owned-parent/sample");
  assert.deepEqual(parents, ["/", "/"]);
  assert.throws(() => resolveDemoTarget("/", { resolveParent }), /demo.target_invalid/);
  assert.deepEqual(parents, ["/", "/"], "filesystem root itself must fail before parent resolution");
});

test("demo copies the complete validated inert artifact and never overwrites directories, files or symlinks", () => {
  const root = scratch();
  try {
    const target = join(root, "sample");
    const result = createDemo(target);
    assert.equal(result.index, join(target, "landing/index.html"));
    assert.equal(validateDemoArtifact(target).files.size, 84);
    writeFileSync(join(target, "my-edits.txt"), "keep sample edits");
    const before = tree(target);
    assert.throws(() => createDemo(target), /demo.target_exists/);
    assert.deepEqual(tree(target), before);
    writeFileSync(join(root, "file"), "keep");
    symlinkSync(target, join(root, "link"));
    for (const name of ["file", "link"]) assert.throws(() => createDemo(join(root, name)), /demo.target_exists/);
    assert.equal(readFileSync(join(root, "file"), "utf8"), "keep");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed copy cleans only owned files and preserves foreign files", () => {
  const root = scratch();
  try {
    const target = join(root, "sample");
    assert.throws(() => createDemo(target, { writeBytes(fd, bytes) { writeFileSync(fd, bytes); throw Error("injected failure"); } }), /injected failure/);
    assert.equal(existsSync(target), false);
    assert.throws(() => createDemo(target, { writeBytes() { writeFileSync(join(target, "foreign.txt"), "keep"); throw Error("injected failure"); } }), /injected failure/);
    assert.deepEqual(readdirSync(target), ["foreign.txt"]);
    assert.equal(readFileSync(join(target, "foreign.txt"), "utf8"), "keep");
    const replaced = join(root, "replaced");
    assert.throws(() => createDemo(replaced, { writeBytes() {
      const path = join(replaced, "NOTICE.txt");
      unlinkSync(path); writeFileSync(path, "foreign replacement");
      throw Error("injected replacement");
    } }), /injected replacement/);
    assert.equal(readFileSync(join(replaced, "NOTICE.txt"), "utf8"), "foreign replacement");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("multiple processes creating the same target have exactly one winner", async () => {
  const root = scratch();
  try {
    const target = join(root, "sample");
    const statuses = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, "demo", "--target", target], { cwd: root, stdio: "ignore" });
      child.once("error", reject); child.once("close", resolve);
    })));
    assert.equal(statuses.filter(status => status === 0).length, 1);
    assert.equal(validateDemoArtifact(target).files.size, 84);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsupported or malformed demo arguments fail before target creation", () => {
  const root = scratch();
  try {
    const target = join(root, "sample");
    for (const flag of ["--no-write", "--dry-run", "--force", "--merge", "--overwrite", "--json", "--unknown"]) {
      const result = cli(["--target", target, flag], root);
      assert.equal(result.status, 1, flag); assert.match(result.stderr, /demo.unsupported_arguments/);
      assert.equal(existsSync(target), false);
    }
    assert.equal(cli(["--target"], root).status, 1);
    assert.equal(cli(["--target", target, "--target", target], root).status, 1);
    assert.equal(cli(["--help", "value"], root).status, 1);
    assert.equal(existsSync(target), false);
    assert.equal(cli(["--help"], root).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const stale of [false, true]) test(`demo bypasses valid ${stale ? "stale" : "active"} session recovery and all campaign writes`, () => {
  const root = scratch(), destination = scratch();
  try {
    cpSync(join(ROOT, "contracts/fixtures/sidecar-bundle/production-shaped"), root, { recursive: true });
    const packet = join(root, "campaign-runtime.build.json"), journal = join(root, "journal.jsonl");
    const session = buildRunSession({ runId: "demo-session-secret", packet, lifecycleJournal: journal, now: new Date(stale ? "2000-01-01T00:00:00Z" : Date.now()) });
    assert.equal(isRunSessionStale(session), stale);
    writeFileSync(join(root, ".campaign-runtime/run-session.json"), JSON.stringify(session));
    const requests = join(destination, "unexpected-network.txt"), preload = join(destination, "network-probe.mjs");
    writeFileSync(preload, `import {appendFileSync} from 'node:fs';globalThis.fetch=()=>{appendFileSync(${JSON.stringify(requests)},'request\\n');throw Error('demo must never remit');};`);
    const before = tree(root);
    const result = cli(["--target", join(destination, "sample")], root, { preload });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Offline sample only; no campaign evidence/);
    assert.deepEqual(tree(root), before);
    assert.equal(existsSync(journal), false);
    assert.equal(existsSync(requests), false, "demo must not attempt progress or run-record remit");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true }); }
});

// Recompute the manifest so these controls exercise the artifact validator,
// rather than merely demonstrating that byte digests notice a change.
function altered(mutator) {
  const root = scratch(); cpSync(BUNDLE, root, { recursive: true });
  try {
    mutator(root);
    const provenance = JSON.parse(readFileSync(join(root, "provenance.json")));
    for (const name of Object.keys(provenance.output_hashes)) provenance.output_hashes[name] = `sha256:${createHash("sha256").update(readFileSync(join(root, name))).digest("hex")}`;
    writeFileSync(join(root, "provenance.json"), JSON.stringify(provenance));
    assert.throws(() => validateDemoArtifact(root), /demo\./);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("validator rejects active markup, nested template content and resource attributes even with updated hashes", () => {
  for (const payload of ["<script>alert(1)</script>", "<template><img src='https://secret@example.test'></template>", "<form></form>", "<button>active</button>", "<img srcset='https://example.test/x'>", "<body background='https://example.test/x'>"]) altered(root => {
    const path = join(root, "landing/index.html"); writeFileSync(path, readFileSync(path, "utf8").replace("</body>", `${payload}</body>`));
  });
});
test("validator rejects escaped CSS imports, external resources and traversal", () => {
  for (const payload of ["@\\69mport 'https://example.test/x';", "x{background:url(https://user:secret@example.test/x)}", "x{background:url(../../../../outside.png)}"]) altered(root => {
    const path = join(root, "assets/css/demo.css"); writeFileSync(path, readFileSync(path, "utf8") + payload);
  });
});
test("validator rejects active SVG and unsupported provenance", () => {
  for (const payload of ["<foreignObject><script/></foreignObject>", "<image href='https://example.test/x'/>", "<animate attributeName='href'/>"]) altered(root => {
    const provenance = JSON.parse(readFileSync(join(root, "provenance.json")));
    const name = Object.keys(provenance.output_hashes).find(name => name.endsWith(".svg"));
    const path = join(root, name); writeFileSync(path, readFileSync(path, "utf8").replace("</svg>", `${payload}</svg>`));
  });
  altered(root => { const path = join(root, "provenance.json"), provenance = JSON.parse(readFileSync(path)); provenance.typography = "unsupported"; writeFileSync(path, JSON.stringify(provenance)); });
});
