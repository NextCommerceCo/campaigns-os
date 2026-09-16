import test from "node:test";
import assert from "node:assert/strict";

import { HIDDEN_EAGER_MEDIA_ACTIONS, requiredActionText, substitutePacket } from "./gate-actions.mjs";

test("the hidden eager-media action table is frozen and carries the six recorded actions", () => {
  assert.deepEqual(Object.keys(HIDDEN_EAGER_MEDIA_ACTIONS), ["capture", "install_browser", "waive", "repair", "repair_authority", "local_proof_rebuild"]);
  for (const [key, action] of Object.entries(HIDDEN_EAGER_MEDIA_ACTIONS)) {
    assert.equal(action.id, `polish.hidden_eager_media.${key}`);
    assert.ok(Object.isFrozen(action), key);
    assert.ok(["command", "manual"].includes(action.kind), key);
    assert.equal(action.kind === "command", typeof action.command === "string", `${key}: a command action carries a command, a manual one carries null`);
    assert.equal(typeof action.description, "string");
  }
  assert.ok(Object.isFrozen(HIDDEN_EAGER_MEDIA_ACTIONS));
  assert.match(HIDDEN_EAGER_MEDIA_ACTIONS.capture.command, /--packet <packet>/);
  assert.match(HIDDEN_EAGER_MEDIA_ACTIONS.waive.command, /--gate polish\.hidden_eager_media/);
});

test("substitutePacket replaces the placeholder once, shell-quoted, and inserts $ sequences literally", () => {
  assert.equal(substitutePacket("campaigns-os polish capture --packet <packet> --base-url <url>", "/w/campaign-runtime.build.json"),
    "campaigns-os polish capture --packet /w/campaign-runtime.build.json --base-url <url>");
  assert.equal(substitutePacket("x --packet <packet>", "/w/my packet.json"), "x --packet '/w/my packet.json'");
  assert.equal(substitutePacket("x --packet <packet>", "/w/$&/$1/$$.json"), "x --packet '/w/$&/$1/$$.json'");
  // No packet, no command, or no placeholder: returned as given.
  assert.equal(substitutePacket("x --packet <packet>", null), "x --packet <packet>");
  assert.equal(substitutePacket("x --packet <packet>", ""), "x --packet <packet>");
  assert.equal(substitutePacket("npm run qa:install-browser", "/w/p.json"), "npm run qa:install-browser");
  assert.equal(substitutePacket(null, "/w/p.json"), null);
  assert.equal(substitutePacket(undefined, "/w/p.json"), undefined);
});

test("requiredActionText is the substituted command, else the description, else nothing", () => {
  const command = { id: "a", kind: "command", command: "campaigns-os checkpoint waive --packet <packet> --gate g", description: "Waive it." };
  const manual = { id: "b", kind: "manual", command: null, description: "Fix it by hand." };
  assert.equal(requiredActionText(command, { packetPath: "/w/p.json" }), "campaigns-os checkpoint waive --packet /w/p.json --gate g");
  assert.equal(requiredActionText(command), "campaigns-os checkpoint waive --packet <packet> --gate g", "no packet: the template is the text");
  assert.equal(requiredActionText(manual, { packetPath: "/w/p.json" }), "Fix it by hand.");
  assert.equal(requiredActionText({ id: "c", command: "", description: "Fallback." }), "Fallback.", "an empty command is no command");
  for (const empty of [{ id: "d" }, { id: "e", command: null, description: "" }, null, undefined, "text"]) {
    assert.equal(requiredActionText(empty), null, JSON.stringify(empty));
  }
});

test("requiredActionText carries a report only into packet-scoped commands that do not already name one", () => {
  const scoped = { command: "campaigns-os checkpoint waive --packet <packet> --gate g" };
  const naming = { command: "campaigns-os polish capture --packet <packet> --report <report>" };
  const bare = { command: "npm run qa:install-browser" };
  const prefixed = { command: "campaigns-os x --packet <packet> --report-format json" };
  const opts = { packetPath: "/w/p.json", reportPath: "/w/custom report.json" };
  assert.equal(requiredActionText(scoped, opts), "campaigns-os checkpoint waive --packet /w/p.json --gate g --report '/w/custom report.json'");
  assert.equal(requiredActionText(naming, opts), "campaigns-os polish capture --packet /w/p.json --report <report>");
  assert.equal(requiredActionText(bare, opts), "npm run qa:install-browser");
  assert.equal(requiredActionText(prefixed, opts), "campaigns-os x --packet /w/p.json --report-format json --report '/w/custom report.json'", "--report-format is not --report");
  // The decision reads the template, not the substituted path.
  assert.equal(requiredActionText(scoped, { packetPath: "/w/--report/p.json", reportPath: "/w/r.json" }), "campaigns-os checkpoint waive --packet /w/--report/p.json --gate g --report /w/r.json");
  // A manual action never gains a report.
  assert.equal(requiredActionText({ command: null, description: "By hand." }, opts), "By hand.");
});
