// `--order-path-depth <off|common|full>`: one accepted-values set for
// prepare-build/start and `qa policy set`, refused before anything is written,
// and one text for the packet/report drift it exists to reconcile.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ORDER_PATH_DEPTHS,
  ORDER_PATH_DEPTH_DRIFT_CODE,
  orderPathDepthDriftText,
  orderPathDepthReconcileAction,
  orderPathDepthsDisagree,
  parseOrderPathDepthFlag,
} from "./proof-policy.mjs";
import { assessPurchaseProofCoverage } from "./cli.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

const PREPARED_PAGES = {
  landing: '---\npage_type: product\n---\n<section>Landing</section>\n<a href="{% campaign_link "checkout" %}">Buy</a>',
  checkout: '<section data-commerce-zone="checkout-form">Checkout</section>',
  upsell: '<section data-commerce-zone="upsell-offer">Upsell</section>',
  receipt: '<section data-commerce-zone="receipt-summary">Receipt</section>',
};

function withIntake(t, run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-order-path-depth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = resolve(dir, "source-html");
  const targetRepo = resolve(dir, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const [page, content] of Object.entries(PREPARED_PAGES)) writeFileSync(resolve(sourceRoot, `${page}.html`), content);
  const specPath = resolve(dir, "campaignspec.json");
  writeFileSync(specPath, readFileSync(resolve(ROOT, "examples/campaignspec.v42.basic.json")));
  const prepare = (extraArgs) => execFileSync(process.execPath, [
    CLI, "prepare-build", "--spec", specPath, "--source", sourceRoot, "--target", targetRepo,
    "--template-family", "olympus", "--no-run-session", ...extraArgs, "--json",
  ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CAMPAIGNS_API_KEY: "" } });
  return run({ dir, targetRepo, prepare });
}

test("the setter accepts exactly off, common and full", () => {
  assert.deepEqual([...ORDER_PATH_DEPTHS], ["off", "common", "full"]);
  for (const depth of ORDER_PATH_DEPTHS) {
    assert.equal(parseOrderPathDepthFlag({ "order-path-depth": depth }), depth);
  }
  assert.equal(parseOrderPathDepthFlag({}), null, "an absent flag is not a value");
  // Case is ignored on input and the canonical lower-case form is stored,
  // matching the case-insensitive drift comparison.
  assert.equal(parseOrderPathDepthFlag({ "order-path-depth": "Off" }), "off");
  assert.equal(parseOrderPathDepthFlag({ "order-path-depth": " FULL " }), "full");
  assert.throws(() => parseOrderPathDepthFlag({ "order-path-depth": "Tiers" }), /unsupported --order-path-depth "Tiers"\. Accepted values: off, common, full\./);
  assert.throws(() => parseOrderPathDepthFlag({ "order-path-depth": true }, { command: "prepare-build" }), /prepare-build: --order-path-depth needs a value\. Accepted values: off, common, full\./);
  assert.throws(() => parseOrderPathDepthFlag({ "order-path-depth": "tiers" }), /qa policy set: unsupported --order-path-depth "tiers"\. Accepted values: off, common, full\./);
});

test("one predicate says whether the packet and the report disagree", () => {
  assert.equal(orderPathDepthsDisagree("off", "common"), true);
  assert.equal(orderPathDepthsDisagree("common", "COMMON"), false, "case is ignored");
  assert.equal(orderPathDepthsDisagree("common", null), false, "an absent side is not a disagreement");
  assert.equal(orderPathDepthsDisagree("", "common"), false);
  assert.equal(orderPathDepthsDisagree(undefined, undefined), false);
});

test("the drift text carries a pre-rendered command verbatim when one is handed in", () => {
  const text = orderPathDepthDriftText({ packetDepth: "off", reportDepth: "common", command: "npx campaigns-os qa policy set --packet p.json --order-path-depth off" });
  assert.match(text, /`npx campaigns-os qa policy set --packet p\.json --order-path-depth off`/);
});

test("the drift text names the reconciling command once, for doctor, next and the coverage reason alike", () => {
  const action = orderPathDepthReconcileAction({ packetDepth: "off", reportDepth: "common" });
  assert.equal(action.id, ORDER_PATH_DEPTH_DRIFT_CODE);
  assert.equal(action.kind, "command");
  assert.equal(action.command, "campaigns-os qa policy set --packet <packet> --order-path-depth off");
  const text = orderPathDepthDriftText({ packetDepth: "off", reportDepth: "common", packetPath: "/tmp/p.json" });
  assert.match(text, /"off" while the assembly report's mirror of it reads "common"/);
  assert.match(text, /qa policy set --packet \/tmp\/p\.json --order-path-depth off/);
  // A packet value the setter would refuse is not offered back as the fix.
  const unknown = orderPathDepthReconcileAction({ packetDepth: "none", reportDepth: "common" });
  assert.match(unknown.command, /--order-path-depth <off\|common\|full>$/);
  // The coverage assessment's reason is that same text.
  const coverage = assessPurchaseProofCoverage({
    packet: { qa: { proof_policy: { order_path_depth: "off" } } },
    report: { proof_policy: { order_path_depth: "common" } },
  });
  assert.equal(coverage.state, "unknown");
  assert.equal(coverage.reason, orderPathDepthDriftText({ packetDepth: "off", reportDepth: "common" }));
  assert.doesNotMatch(coverage.reason, /Reconcile the packet and the report before/);
});

test("prepare-build --order-path-depth off seeds the packet and the report mirror together", (t) => {
  withIntake(t, ({ targetRepo, prepare }) => {
    prepare(["--order-path-depth", "off"]);
    const packet = JSON.parse(readFileSync(resolve(targetRepo, "campaign-runtime.build.json"), "utf8"));
    const report = JSON.parse(readFileSync(resolve(targetRepo, ".campaign-runtime/assembly-report.json"), "utf8"));
    assert.equal(packet.qa.proof_policy.order_path_depth, "off");
    assert.equal(report.proof_policy.order_path_depth, "off");
    assert.equal(packet.qa.proof_policy.typed_card_depth, "common", "only the order-path depth is operator-set");
  });
});

test("prepare-build without the flag still seeds common", (t) => {
  withIntake(t, ({ targetRepo, prepare }) => {
    prepare([]);
    const packet = JSON.parse(readFileSync(resolve(targetRepo, "campaign-runtime.build.json"), "utf8"));
    assert.equal(packet.qa.proof_policy.order_path_depth, "common");
  });
});

test("prepare-build refuses a bad --order-path-depth before writing any build state", (t) => {
  withIntake(t, ({ targetRepo, prepare }) => {
    for (const badFlag of [["--order-path-depth", "tiers"], ["--order-path-depth"]]) {
      assert.throws(() => prepare(badFlag), (error) => {
        assert.match(String(error.stderr), /--order-path-depth/);
        assert.match(String(error.stderr), /Accepted values: off, common, full/);
        return true;
      });
      assert.equal(existsSync(resolve(targetRepo, ".campaign-runtime")), false, `${badFlag.join(" ")} wrote build state`);
      assert.equal(existsSync(resolve(targetRepo, "campaign-runtime.build.json")), false, `${badFlag.join(" ")} wrote a packet`);
    }
  });
});

test("qa policy set refuses a bad --order-path-depth and writes nothing", (t) => {
  withIntake(t, ({ targetRepo, prepare }) => {
    prepare([]);
    const packetPath = resolve(targetRepo, "campaign-runtime.build.json");
    const before = readFileSync(packetPath, "utf8");
    assert.throws(() => execFileSync(process.execPath, [CLI, "qa", "policy", "set", "--packet", packetPath, "--order-path-depth", "all", "--json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), (error) => {
      assert.match(String(error.stderr), /qa policy set: unsupported --order-path-depth "all"\. Accepted values: off, common, full\./);
      return true;
    });
    assert.equal(readFileSync(packetPath, "utf8"), before);
  });
});
