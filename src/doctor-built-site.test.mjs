import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { doctorBuiltOutput, doctorPacket } from "./cli.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-doctor-built-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePage(repo, slug, route, html) {
  const dir = route ? join(repo, "_site", slug, route) : join(repo, "_site", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}

const codes = (issues) => issues.map((issue) => issue.code);

test("H3.3 doctor --built: runs residue/text/demo gates against a built _site/ with no packet", () => {
  withTempDir((repo) => {
    writePage(repo, "acme", "", "<h1>Lorem ipsum dolor</h1><img src=\"/c/images/1x1_1.svg\">");
    writePage(repo, "acme", "checkout", "<h1>Checkout</h1><p>Product Name</p>");
    const result = doctorBuiltOutput({ built: repo, family: "arjuna", slug: "acme" });

    assert.equal(result.mode, "built_site");
    assert.equal(result.ok, true, "warnings do not block; built-site doctor is advisory");
    assert.ok(codes(result.warnings).includes("template_contract.placeholder_text_residue"), "Lorem/Product Name flagged");
    assert.ok(codes(result.warnings).includes("template_contract.demo_asset_residue"), "1x1 demo asset flagged");
    assert.equal(result.scope.html_count, 2);
    // Auto-emitted minimal packet points back at the built output + family.
    assert.equal(result.synthesized_packet.assembly.template_family, "arjuna");
    assert.equal(result.synthesized_packet.campaign.public_route_slug, "acme");
  });
});

test("H3.3 doctor --built: a clean built campaign yields ready lines and no residue warnings", () => {
  withTempDir((repo) => {
    writePage(repo, "acme", "", "<h1>Cold Brew Concentrate</h1><img src=\"/c/images/hero.jpg\">");
    writePage(repo, "acme", "checkout", "<h1>Secure checkout</h1>");
    const result = doctorBuiltOutput({ built: repo, family: "arjuna", slug: "acme" });
    assert.equal(codes(result.warnings).includes("template_contract.placeholder_text_residue"), false);
    assert.equal(codes(result.warnings).includes("template_contract.demo_asset_residue"), false);
    assert.ok(result.ready.some((note) => note.includes("no literal template placeholder text")));
  });
});

test("H3.3 doctor --built: warns (does not crash) when no --family is provided", () => {
  withTempDir((repo) => {
    writePage(repo, "acme", "", "<h1>Landing</h1>");
    const result = doctorBuiltOutput({ built: repo, slug: "acme" });
    assert.equal(result.mode, "built_site");
    assert.ok(codes(result.warnings).includes("assembly.template_family"));
  });
});

test("H3.3 doctor --built --emit-packet: writes a consumable minimal packet to disk", () => {
  withTempDir((repo) => {
    writePage(repo, "acme", "", "<h1>Landing</h1>");
    const result = doctorBuiltOutput({ built: repo, family: "arjuna", slug: "acme", "emit-packet": true });
    assert.ok(result.emitted_packet_path);
    const onDisk = JSON.parse(readFileSync(result.emitted_packet_path, "utf8"));
    assert.equal(onDisk._synthesized.from, "built_site");
    assert.equal(onDisk.assembly.template_family, "arjuna");

    const packetDoctor = doctorPacket(result.emitted_packet_path, { contextPath: null, reportPath: null });
    assert.equal(packetDoctor.ok, true);
    assert.equal(packetDoctor.errors.length, 0);
    assert.equal(packetDoctor.derived.scope.mode, "built_site");
    assert.ok(packetDoctor.ready.some((note) => note.includes("source_html provenance is absent by design")));
  });
});

test("H3.3 doctor --built: blocks with a clear error when scope cannot resolve", () => {
  withTempDir((repo) => {
    // _site/ exists but the named slug has no pages
    mkdirSync(join(repo, "_site", "empty"), { recursive: true });
    const result = doctorBuiltOutput({ built: repo, family: "arjuna", slug: "empty" });
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes("built_site.scope"));
  });
});
