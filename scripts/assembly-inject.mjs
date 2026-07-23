#!/usr/bin/env node

/**
 * Assembly write path (prototype): inject a producer slot-fill JSON + brief
 * payload into a Build Packet-prepared campaign repo.
 *
 * This is the sanctioned successor to the lab copy-gen injector — the
 * "ai-generated entry" plug point. Manifest-driven instead of hardcoded:
 * the template-slot-manifest decides which slots are copy (replaced), which
 * are urgency/proof surfaces (blanked when the producer omits them, so no
 * demo chrome ships), and which are never touched (images, meta, commerce).
 *
 * Usage:
 *   node scripts/assembly-inject.mjs \
 *     --packet <target>/campaign-runtime.build.json \
 *     --page presell \
 *     --slots <slot-fill.json> \
 *     --brief <brief-payload.json> \
 *     [--date "July 22, 2026"]
 *
 * Semantics (mirrors the lab prototype, generalized via the manifest):
 * - slot in the producer output              -> replace the frontmatter value
 * - manifest urgency/proof slot NOT in output-> blank ("") so no demo chrome ships
 * - needs_merchant_input entries             -> loud NEEDS-MERCHANT-INPUT marker
 *   (the doctor hard-fails on the marker; the attestation UX resolves it)
 * - reason blocks beyond the filled count    -> blanked (images kept)
 * - harness tokens {{PUBLISH_DATE}}/{{YEAR}} -> resolved here (they are ours)
 * - the brief payload is copied to .campaign-runtime/input/brief-payload.json
 *   where the doctor's urgency + attestation gates read it
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadTemplateSlotManifest, manifestPageSlots } from "../src/template-slot-manifest.mjs";
import { BRIEF_PAYLOAD_REL_PATH } from "../src/content-residue.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function fail(message) {
  console.error(`assembly-inject: ${message}`);
  process.exit(1);
}

const packetPath = arg("packet") || fail("--packet <campaign-runtime.build.json> is required");
const page = arg("page", "presell");
const slotsPath = arg("slots") || fail("--slots <slot-fill.json> is required");
const briefPath = arg("brief");
const dateArg = arg("date", new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));

const packet = JSON.parse(readFileSync(resolve(packetPath), "utf8"));
const targetRepo = resolve(dirname(resolve(packetPath)), packet.assembly?.target_repo || ".");
const family = packet.assembly?.template_family || fail("packet has no assembly.template_family");
const slug = packet.campaign?.public_route_slug || fail("packet has no campaign.public_route_slug");

const manifest = loadTemplateSlotManifest(family);
if (!manifest) fail(`no template slot manifest for family "${family}" — the write path only serves manifest-covered families`);
const declared = manifestPageSlots(manifest, page);
if (!declared.length) fail(`slot manifest declares no content slots for page "${page}"`);

const output = JSON.parse(readFileSync(resolve(slotsPath), "utf8"));
const slots = { ...(output.slots || {}) };
const needsInput = new Set((output.needs_merchant_input || []).map((n) => n.slot).filter(Boolean));

// Resolve harness tokens (ours, never the producer's to invent).
const year = String(new Date().getFullYear());
for (const [key, value] of Object.entries(slots)) {
  if (typeof value === "string") {
    slots[key] = value.replaceAll("{{PUBLISH_DATE}}", dateArg).replaceAll("{{YEAR}}", year);
  }
}
for (const key of needsInput) {
  slots[key] = `⚠ NEEDS MERCHANT INPUT: ${key} ⚠`;
}

const pagePath = join(targetRepo, "src", slug, `${page}.html`);
if (!existsSync(pagePath)) fail(`target page not found: ${pagePath}`);
const text = readFileSync(pagePath, "utf8");
const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
if (!match) fail(`no frontmatter block in ${pagePath}`);
let fm = match[1];

const replaced = [];
const blanked = [];
const missing = [];

function setLine(key, value) {
  const rx = new RegExp(`^(${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}):[ \\t]*.*$`, "m");
  if (!rx.test(fm)) {
    missing.push(key);
    return false;
  }
  // Replacer FUNCTION, not a replacement string: producer copy legitimately
  // contains "$1"-style sequences ("$130") that a string replacement would
  // interpret as capture-group references and corrupt.
  fm = fm.replace(rx, (_, matchedKey) => `${matchedKey}: ${JSON.stringify(value)}`);
  return true;
}

// 1. Producer-filled slots (copy layer only — images/meta/commerce untouched).
const declaredByKey = new Map(declared.map((slot) => [slot.key, slot]));
for (const [key, value] of Object.entries(slots)) {
  const slot = declaredByKey.get(key);
  if (!slot) {
    missing.push(key);
    continue;
  }
  if (slot.kind === "image" || slot.kind === "commerce" || slot.role === "page_meta") continue;
  if (setLine(key, value)) replaced.push(key);
}

// 2. Manifest-declared urgency and proof slots the producer omitted -> blank.
//    An omitted urgency slot means "no verified urgency"; an omitted proof
//    slot means "no real proof supplied". Either way the guarded chrome must
//    not ship demo values.
for (const slot of declared) {
  if (slot.kind !== "copy") continue;
  const conditional = slot.enabled_by_verified_urgency === true || slot.proof_surface === true;
  if (!conditional) continue;
  if (!(slot.key in slots)) {
    if (setLine(slot.key, "")) blanked.push(slot.key);
  }
}

// 3. Trailing repeat blocks (reason_N_*) beyond the producer's filled count.
const filledReasons = [...new Set(
  Object.keys(slots).map((key) => /^reason_(\d+)_/.exec(key)?.[1]).filter(Boolean).map(Number),
)].sort((a, b) => a - b);
const maxReason = filledReasons.length ? Math.max(...filledReasons) : 0;
for (let i = maxReason + 1; i <= 12; i += 1) {
  for (const part of ["tag", "heading", "body", "link_text"]) {
    const key = `reason_${i}_${part}`;
    if (new RegExp(`^${key}:`, "m").test(fm) && setLine(key, "")) blanked.push(key);
  }
}
for (const i of filledReasons) {
  const key = `reason_${i}_link_text`;
  if (!(key in slots) && new RegExp(`^${key}:`, "m").test(fm) && setLine(key, "")) blanked.push(key);
}

writeFileSync(pagePath, `---\n${fm}\n---\n${text.slice(match[0].length)}`);

// 4. Brief payload sidecar — the doctor's urgency + attestation gates read it.
if (briefPath) {
  const briefTarget = join(targetRepo, BRIEF_PAYLOAD_REL_PATH);
  mkdirSync(dirname(briefTarget), { recursive: true });
  copyFileSync(resolve(briefPath), briefTarget);
}

console.log(
  `assembly-inject: ${page} @ ${family}/${slug} — replaced=${replaced.length} blanked=${blanked.length} reasons=1..${maxReason}` +
    (briefPath ? `; brief payload -> ${BRIEF_PAYLOAD_REL_PATH}` : ""),
);
if (missing.length) {
  console.warn(`assembly-inject: keys in producer output but not in the template/manifest: ${missing.join(", ")}`);
}
