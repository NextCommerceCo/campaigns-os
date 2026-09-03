import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { validateVerdict } from "./qa-verdict.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONTRACT_PATH = join(ROOT, "contracts/migration-sidecar-bundle.v0.json");
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const SIDECAR_BUNDLE_CONFORMANCE_SCHEMA = "campaigns-os-sidecar-bundle-conformance/v0";
export const SIDECAR_BUNDLE_CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));

const schemaValidators = new Map();
for (const artifact of SIDECAR_BUNDLE_CONTRACT.artifacts) {
  const schema = JSON.parse(readFileSync(join(ROOT, artifact.schema_path), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  schemaValidators.set(artifact.kind, ajv.compile(schema));
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function removePath(value, dottedPath) {
  const parts = dottedPath.split(".");
  let cursor = value;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!cursor || typeof cursor !== "object") return;
    cursor = cursor[parts[index]];
  }
  if (cursor && typeof cursor === "object") delete cursor[parts.at(-1)];
}

export function materialProjection(value, artifactContract) {
  const projected = structuredClone(value);
  for (const field of artifactContract.volatile_fields || []) removePath(projected, field);
  return canonicalize(projected);
}

function artifactFinding(code, artifact, message, remedy) {
  return { code, artifact, message, remedy };
}

function readJsonArtifact(path) {
  const raw = readFileSync(path);
  return { raw, value: JSON.parse(raw.toString("utf8")) };
}

function timestampOk(value) {
  return typeof value === "string" && RFC3339_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function valueAt(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

function compareIdentity(errors, records, identityField) {
  const label = identityField.name;
  const present = [];
  for (const [kind, path] of Object.entries(identityField.artifact_paths)) {
    if (!records.has(kind)) continue;
    const value = valueAt(records.get(kind).value, path);
    if (value == null || value === "") {
      errors.push(artifactFinding(
        `bundle.identity.${label}_missing`,
        kind,
        `${kind} is missing required bundle identity ${path}.`,
        "Regenerate the sidecars from the same root Build Packet and explicit QA verdict.",
      ));
      continue;
    }
    present.push({ kind, value });
  }
  if (present.length < 2) return;
  const expected = present[0].value;
  const mismatch = present.find((entry) => entry.value !== expected);
  if (!mismatch) return;
  errors.push(artifactFinding(
    `bundle.identity.${label}_mismatch`,
    mismatch.kind,
    `${label} disagrees across bundle artifacts (${present.map((entry) => `${entry.kind}=${entry.value}`).join(", ")}).`,
    "Regenerate the sidecars from the same root Build Packet and explicit QA verdict.",
  ));
}

function bundleRootFor(packetPath) {
  const absolute = resolve(packetPath);
  if (basename(dirname(absolute)) === ".campaign-runtime") return dirname(dirname(absolute));
  return dirname(absolute);
}

export function inspectSidecarBundle({ packetPath, requireQa = false } = {}) {
  if (!packetPath || typeof packetPath !== "string") {
    throw new Error("bundle check requires --packet <campaign-runtime.build.json>.");
  }

  const root = bundleRootFor(packetPath);
  const absolutePacket = resolve(packetPath);
  const canonicalPacket = join(root, SIDECAR_BUNDLE_CONTRACT.packet_discovery.canonical_path);
  const errors = [];
  const warnings = [];
  const records = new Map();
  const artifacts = [];

  if (absolutePacket !== canonicalPacket) {
    const legacy = absolutePacket === join(root, SIDECAR_BUNDLE_CONTRACT.packet_discovery.legacy_path);
    errors.push(artifactFinding(
      legacy ? "bundle.packet.legacy_path" : "bundle.packet.noncanonical_path",
      "build_packet",
      legacy
        ? `Build Packet is at the legacy sidecar path ${SIDECAR_BUNDLE_CONTRACT.packet_discovery.legacy_path}; default discovery reads only the repository root.`
        : `Build Packet must be at repository-root ${SIDECAR_BUNDLE_CONTRACT.packet_discovery.canonical_path}.`,
      legacy
        ? SIDECAR_BUNDLE_CONTRACT.packet_discovery.legacy_remedy
        : SIDECAR_BUNDLE_CONTRACT.packet_discovery.noncanonical_remedy,
    ));
  }

  for (const artifactContract of SIDECAR_BUNDLE_CONTRACT.artifacts) {
    const path = join(root, artifactContract.path);
    const required = artifactContract.requirement === "required" || (artifactContract.kind === "qa_verdict" && requireQa);
    const record = {
      kind: artifactContract.kind,
      path: artifactContract.path,
      requirement: artifactContract.requirement,
      present: existsSync(path),
      schema_version: null,
      generated_at: null,
      sha256: null,
      material_sha256: null,
    };
    artifacts.push(record);

    if (!record.present) {
      const finding = artifactFinding(
        `bundle.${artifactContract.kind}.missing`,
        artifactContract.kind,
        `Missing canonical JSON artifact ${artifactContract.path}.`,
        artifactContract.kind === "qa_verdict"
          ? "Run QA, or explicitly promote one named full verdict with campaigns-os qa promote; never select a verdict by mtime."
          : artifactContract.kind === "doctor_output"
            ? "Run campaigns-os doctor --packet campaign-runtime.build.json --strip-paths to refresh it."
            : "Regenerate the bundle with Campaigns OS while preserving authored packet, context, and assembly inputs.",
      );
      (required ? errors : warnings).push(finding);
      continue;
    }

    try {
      const parsed = readJsonArtifact(path);
      records.set(artifactContract.kind, parsed);
      record.schema_version = parsed.value?.schema_version ?? null;
      record.generated_at = valueAt(parsed.value, artifactContract.freshness_field) ?? null;
      record.sha256 = digest(parsed.raw);
      record.material_sha256 = digest(JSON.stringify(materialProjection(parsed.value, artifactContract)));
    } catch {
      errors.push(artifactFinding(
        `bundle.${artifactContract.kind}.invalid_json`,
        artifactContract.kind,
        `${artifactContract.path} is not valid JSON.`,
        "Regenerate the artifact with its Campaigns OS producer; do not repair generated JSON by hand.",
      ));
      continue;
    }

    if (record.schema_version !== artifactContract.schema_version) {
      errors.push(artifactFinding(
        `bundle.${artifactContract.kind}.schema_version`,
        artifactContract.kind,
        `Expected schema_version ${artifactContract.schema_version}; found ${record.schema_version ?? "missing"}.`,
        `Regenerate ${artifactContract.path} with a compatible Campaigns OS release.`,
      ));
    }
    if (!timestampOk(record.generated_at)) {
      errors.push(artifactFinding(
        `bundle.${artifactContract.kind}.generated_at`,
        artifactContract.kind,
        `${artifactContract.path} needs a strict RFC3339 UTC generated_at timestamp.`,
        `Regenerate ${artifactContract.path}; freshness is never inferred from filesystem mtime.`,
      ));
    }
    const validateSchema = schemaValidators.get(artifactContract.kind);
    if (!validateSchema(records.get(artifactContract.kind).value)) {
      const details = validateSchema.errors
        .slice(0, 5)
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      errors.push(artifactFinding(
        `bundle.${artifactContract.kind}.schema`,
        artifactContract.kind,
        `${artifactContract.path} failed ${artifactContract.schema_path}: ${details}`,
        `Regenerate ${artifactContract.path} with its Campaigns OS producer; do not repair generated JSON by hand.`,
      ));
    }
  }

  const packet = records.get("build_packet")?.value;
  const context = records.get("build_context")?.value;
  const report = records.get("assembly_report")?.value;
  const doctor = records.get("doctor_output")?.value;
  const qaVerdict = records.get("qa_verdict")?.value;

  if (context && context.packet_path !== "campaign-runtime.build.json") {
    errors.push(artifactFinding(
      "bundle.build_context.packet_path",
      "build_context",
      "Build Context packet_path must name repository-root campaign-runtime.build.json.",
      "Regenerate the Build Context with canonical repository-relative output paths.",
    ));
  }
  if (report && report.inputs?.packet_path !== "campaign-runtime.build.json") {
    errors.push(artifactFinding(
      "bundle.assembly_report.packet_path",
      "assembly_report",
      "Assembly Report inputs.packet_path must name repository-root campaign-runtime.build.json.",
      "Regenerate the Assembly Report with canonical repository-relative output paths.",
    ));
  }
  if (doctor?.stale === true) {
    errors.push(artifactFinding(
      "bundle.doctor_output.stale",
      "doctor_output",
      "Doctor output is explicitly marked stale after a later mutation.",
      "Re-run campaigns-os doctor --packet campaign-runtime.build.json --strip-paths.",
    ));
  }
  if (qaVerdict) {
    const qaErrors = validateVerdict(qaVerdict);
    if (qaErrors.length) {
      errors.push(artifactFinding(
        "bundle.qa_verdict.shape",
        "qa_verdict",
        `QA Verdict sidecar failed its public shape: ${qaErrors.join("; ")}`,
        "Re-run QA or explicitly promote a valid named full verdict with campaigns-os qa promote.",
      ));
    }
    for (const field of ["entry_urls", "page_urls", "tested_urls", "test_orders"]) {
      if (!Array.isArray(qaVerdict[field]) || qaVerdict[field].length !== 0) {
        errors.push(artifactFinding(
          `bundle.qa_verdict.${field}`,
          "qa_verdict",
          `Committed QA sidecar field ${field} must be an empty array.`,
          "Regenerate the allowlist projection with campaigns-os qa promote; do not commit a full URL/order-bearing verdict.",
        ));
      }
    }
  }

  for (const identityField of SIDECAR_BUNDLE_CONTRACT.identity_fields) {
    compareIdentity(errors, records, identityField);
  }

  const materialEntries = artifacts
    .filter((artifact) => artifact.present && artifact.material_sha256)
    .map((artifact) => [artifact.kind, artifact.material_sha256]);
  const materialDigest = materialEntries.length
    ? digest(JSON.stringify(materialEntries))
    : null;

  return {
    schema_version: SIDECAR_BUNDLE_CONFORMANCE_SCHEMA,
    bundle_id: SIDECAR_BUNDLE_CONTRACT.bundle_id,
    ok: errors.length === 0,
    status: errors.length === 0 ? "conformant" : "nonconformant",
    root,
    packet_generated_at: packet?.generated_at ?? null,
    material_digest: materialDigest,
    artifacts,
    errors,
    warnings,
  };
}
