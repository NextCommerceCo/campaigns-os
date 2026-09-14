import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ASSEMBLY_REPORT_REL_PATH,
  BUILD_CONTEXT_REL_PATH,
  campaignSidecarPaths,
  resolveCampaignWorkspace,
  targetRepoFor,
} from "./campaign-workspace.mjs";
import { DOCTOR_SIDECAR_REL_PATH } from "./doctor-sidecar.mjs";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "campaign-workspace-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("targetRepoFor resolves a declared target against the packet's directory and defaults to that directory", () => {
  assert.equal(targetRepoFor("/w/packets/campaign-runtime.build.json", { assembly: { target_repo: "../site" } }), "/w/site");
  assert.equal(targetRepoFor("/w/packets/campaign-runtime.build.json", { assembly: { target_repo: "/elsewhere/site" } }), "/elsewhere/site");
  assert.equal(targetRepoFor("/w/packets/campaign-runtime.build.json", { assembly: { target_repo: "." } }), "/w/packets");
  for (const packet of [{ assembly: { target_repo: "" } }, { assembly: { target_repo: "   " } }, { assembly: {} }, {}, null]) {
    assert.equal(targetRepoFor("/w/packets/campaign-runtime.build.json", packet), "/w/packets", JSON.stringify(packet));
  }
  // A relative packet path is resolved first, like every caller did.
  assert.equal(targetRepoFor("campaign-runtime.build.json", {}), resolve("."));
});

test("campaignSidecarPaths is the one spelling of the default sidecar locations", () => {
  assert.deepEqual(campaignSidecarPaths("/site"), {
    contextPath: `/site/${BUILD_CONTEXT_REL_PATH}`,
    reportPath: `/site/${ASSEMBLY_REPORT_REL_PATH}`,
    doctorOutPath: `/site/${DOCTOR_SIDECAR_REL_PATH}`,
    qaOutputDir: "/site/qa-output",
  });
  assert.equal(BUILD_CONTEXT_REL_PATH, ".campaign-runtime/build-context.json");
  assert.equal(ASSEMBLY_REPORT_REL_PATH, ".campaign-runtime/assembly-report.json");
});

test("resolveCampaignWorkspace derives every path from the target repo, and baseDir from the packet", () => withDir((dir) => {
  const packetPath = join(dir, "packets", "campaign-runtime.build.json");
  const packet = { assembly: { target_repo: "../site" } };
  const ws = resolveCampaignWorkspace(packetPath, { packet, followContextPointer: false });
  assert.equal(ws.packet, packet);
  assert.equal(ws.packetPath, packetPath);
  assert.equal(ws.baseDir, join(dir, "packets"));
  assert.equal(ws.targetRepo, join(dir, "site"));
  assert.equal(ws.contextPath, join(dir, "site", BUILD_CONTEXT_REL_PATH));
  assert.equal(ws.reportPath, join(dir, "site", ASSEMBLY_REPORT_REL_PATH));
  assert.equal(ws.defaultReportPath, ws.reportPath);
  assert.equal(ws.doctorOutPath, join(dir, "site", DOCTOR_SIDECAR_REL_PATH));
  assert.equal(ws.qaOutputDir, join(dir, "site", "qa-output"));
}));

test("resolveCampaignWorkspace reads the packet when none is passed", () => withDir((dir) => {
  const packetPath = join(dir, "campaign-runtime.build.json");
  mkdirSync(join(dir, "built"));
  writeFileSync(packetPath, JSON.stringify({ assembly: { target_repo: "built" } }));
  const ws = resolveCampaignWorkspace(packetPath, { followContextPointer: false });
  assert.deepEqual(ws.packet, { assembly: { target_repo: "built" } });
  assert.equal(ws.targetRepo, join(dir, "built"));
}));

test("followContextPointer must be stated", () => {
  assert.throws(() => resolveCampaignWorkspace("/w/campaign-runtime.build.json", { packet: {} }), /followContextPointer/);
  assert.throws(() => resolveCampaignWorkspace("/w/campaign-runtime.build.json", { packet: {}, followContextPointer: "yes" }), /followContextPointer/);
});

test("the Build Context's report_path binds the report only for a caller that follows it", () => withDir((dir) => {
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = { assembly: { target_repo: "." } };
  mkdirSync(join(dir, ".campaign-runtime"));
  writeFileSync(join(dir, BUILD_CONTEXT_REL_PATH), JSON.stringify({ report_path: ".campaign-runtime/reports/nested/assembly-report.json" }));

  const bound = resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true });
  assert.equal(bound.reportPath, join(dir, ".campaign-runtime/reports/nested/assembly-report.json"));
  assert.equal(bound.defaultReportPath, join(dir, ASSEMBLY_REPORT_REL_PATH), "the default is still reported beside the bound path");

  const unbound = resolveCampaignWorkspace(packetPath, { packet, followContextPointer: false });
  assert.equal(unbound.reportPath, join(dir, ASSEMBLY_REPORT_REL_PATH));

  // The pointer is relative to the target repo, not the packet.
  const elsewhere = join(dir, "elsewhere", "campaign-runtime.build.json");
  const away = resolveCampaignWorkspace(elsewhere, { packet: { assembly: { target_repo: ".." } }, followContextPointer: true });
  assert.equal(away.targetRepo, dir);
  assert.equal(away.reportPath, join(dir, ".campaign-runtime/reports/nested/assembly-report.json"));
}));

test("explicit paths win, null switches a sidecar off, and a switched-off context binds nothing", () => withDir((dir) => {
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = { assembly: { target_repo: "." } };
  mkdirSync(join(dir, ".campaign-runtime"));
  writeFileSync(join(dir, BUILD_CONTEXT_REL_PATH), JSON.stringify({ report_path: "custom-report.json" }));

  const explicit = resolveCampaignWorkspace(packetPath, {
    packet, followContextPointer: true, contextPath: join(dir, "ctx.json"), reportPath: join(dir, "r.json"), doctorOutPath: join(dir, "d.json"),
  });
  assert.equal(explicit.contextPath, join(dir, "ctx.json"));
  assert.equal(explicit.reportPath, join(dir, "r.json"), "an explicit report is never re-bound");
  assert.equal(explicit.doctorOutPath, join(dir, "d.json"));

  const off = resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true, contextPath: null, reportPath: null });
  assert.equal(off.contextPath, null);
  assert.equal(off.reportPath, null);

  const noContext = resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true, contextPath: null });
  assert.equal(noContext.reportPath, join(dir, ASSEMBLY_REPORT_REL_PATH), "no context, no pointer to follow");

  // An explicit context is the one followed.
  writeFileSync(join(dir, "ctx.json"), JSON.stringify({ report_path: "from-explicit.json" }));
  const viaExplicit = resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true, contextPath: join(dir, "ctx.json") });
  assert.equal(viaExplicit.reportPath, join(dir, "from-explicit.json"));
}));

test("a context naming another packet does not bind; one naming this packet or none does", () => withDir((dir) => {
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = { assembly: { target_repo: "." } };
  mkdirSync(join(dir, ".campaign-runtime"));
  const write = (context) => writeFileSync(join(dir, BUILD_CONTEXT_REL_PATH), JSON.stringify(context));
  const bound = join(dir, "custom-report.json");

  write({ packet_path: "campaign-runtime.build.json", report_path: "custom-report.json" });
  assert.equal(resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true }).reportPath, bound, "names this packet");
  write({ packet_path: "./campaign-runtime.build.json", report_path: "custom-report.json" });
  assert.equal(resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true }).reportPath, bound, "spelled with ./");
  write({ report_path: "custom-report.json" });
  assert.equal(resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true }).reportPath, bound, "names no packet: binds by location");
  write({ packet_path: "other-packet.json", report_path: "custom-report.json" });
  assert.equal(resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true }).reportPath, join(dir, ASSEMBLY_REPORT_REL_PATH), "names another packet: not followed");
  // An explicit report is never second-guessed by the context.
  write({ packet_path: "other-packet.json", report_path: "custom-report.json" });
  assert.equal(resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true, reportPath: join(dir, "r.json") }).reportPath, join(dir, "r.json"));
}));

test("a missing, malformed or pointer-less context leaves the default report bound", () => withDir((dir) => {
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = { assembly: { target_repo: "." } };
  const missing = resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true });
  assert.equal(missing.reportPath, join(dir, ASSEMBLY_REPORT_REL_PATH));

  mkdirSync(join(dir, ".campaign-runtime"));
  writeFileSync(join(dir, BUILD_CONTEXT_REL_PATH), "{ not json");
  const malformed = resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true });
  assert.equal(malformed.reportPath, join(dir, ASSEMBLY_REPORT_REL_PATH));

  for (const context of [{}, { report_path: "" }, { report_path: "   " }, { report_path: 42 }, [], "text"]) {
    writeFileSync(join(dir, BUILD_CONTEXT_REL_PATH), JSON.stringify(context));
    const ws = resolveCampaignWorkspace(packetPath, { packet, followContextPointer: true });
    assert.equal(ws.reportPath, join(dir, ASSEMBLY_REPORT_REL_PATH), JSON.stringify(context));
  }
}));
