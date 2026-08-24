import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";

import {
  computeDesignSourcePackageMaterialFingerprint,
  evaluateDesignSourcePackageReadiness,
  generateDesignSourcePackageReadback,
  validateDesignSourcePackage,
} from "./design-source-package.mjs";
import { evaluatePolishGate, POLISH_PRODUCER } from "./polish-gate.mjs";
import {
  capturePolishPageLoad,
  evaluateRecordedHiddenEagerMediaCheckpoint,
} from "./polish-node.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const DSP_REL_PATH = ".campaign-runtime/input/design-source-package.json";
const RUNTIME_NOW = Date.parse("2026-08-23T12:00:00.000Z");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateDspSchema = ajv.compile(readSchema("campaign-design-source-package.v0.schema.json"));
const validatePacketSchema = ajv.compile(readSchema("campaign-runtime-build-packet.v0.schema.json"));
const validateContextSchema = ajv.compile(readSchema("campaign-runtime-build-context.v0.schema.json"));
const validateReportSchema = ajv.compile(readSchema("campaign-runtime-assembly-report.v0.schema.json"));

function readSchema(name) {
  return JSON.parse(readFileSync(resolve(ROOT, "schemas", name), "utf8"));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function prefixedSha256(bytes) {
  return `sha256:${sha256Hex(bytes)}`;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function createRgbaPng(width, height, [red, green, blue, alpha = 255]) {
  assert.ok(Number.isInteger(width) && width > 0);
  assert.ok(Number.isInteger(height) && height > 0);
  for (const channel of [red, green, blue, alpha]) {
    assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (stride + 1);
    scanlines[offset] = 0;
    for (let column = 0; column < width; column += 1) {
      const pixel = offset + 1 + column * 4;
      scanlines[pixel] = red;
      scanlines[pixel + 1] = green;
      scanlines[pixel + 2] = blue;
      scanlines[pixel + 3] = alpha;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ]);
}

function decodePngFile(path) {
  assert.equal(existsSync(path), true, `PNG evidence does not exist: ${path}`);
  const bytes = readFileSync(path);
  assert.ok(bytes.length >= PNG_SIGNATURE.length, `PNG evidence is truncated: ${path}`);
  assert.ok(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `PNG signature is invalid: ${path}`);

  let offset = PNG_SIGNATURE.length;
  let header = null;
  let sawEnd = false;
  const compressedParts = [];
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, `PNG chunk header is truncated: ${path}`);
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    assert.ok(chunkEnd <= bytes.length, `PNG chunk data is truncated: ${path}`);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const recordedChecksum = bytes.readUInt32BE(offset + 8 + length);
    assert.equal(
      recordedChecksum,
      crc32(Buffer.concat([typeBytes, data])),
      `PNG ${type} checksum is invalid: ${path}`,
    );
    if (type === "IHDR") {
      assert.equal(header, null, `PNG has duplicate IHDR chunks: ${path}`);
      assert.equal(data.length, 13, `PNG IHDR has the wrong length: ${path}`);
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      compressedParts.push(data);
    } else if (type === "IEND") {
      assert.equal(data.length, 0, `PNG IEND has the wrong length: ${path}`);
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  assert.ok(header, `PNG has no IHDR chunk: ${path}`);
  assert.equal(sawEnd, true, `PNG has no IEND chunk: ${path}`);
  assert.equal(offset, bytes.length, `PNG has trailing bytes after IEND: ${path}`);
  assert.ok(header.width > 0 && header.height > 0, `PNG dimensions are invalid: ${path}`);
  assert.deepEqual(
    [header.bitDepth, header.colorType, header.compression, header.filter, header.interlace],
    [8, 6, 0, 0, 0],
    `PNG must be non-interlaced 8-bit RGBA: ${path}`,
  );
  assert.ok(compressedParts.length > 0, `PNG has no IDAT data: ${path}`);
  let scanlines;
  try {
    scanlines = inflateSync(Buffer.concat(compressedParts));
  } catch (error) {
    throw new Error(`PNG IDAT is not decodable: ${path}: ${error.message}`);
  }
  const stride = header.width * 4;
  assert.equal(scanlines.length, (stride + 1) * header.height, `PNG decoded byte length is invalid: ${path}`);
  for (let row = 0; row < header.height; row += 1) {
    assert.equal(scanlines[row * (stride + 1)], 0, `PNG row filter is unsupported: ${path}`);
  }
  return { path, bytes, width: header.width, height: header.height, scanlines };
}

function assertDistinctValidPngPair(sourcePath, builtPath) {
  const source = decodePngFile(sourcePath);
  const built = decodePngFile(builtPath);
  assert.notEqual(
    prefixedSha256(built.bytes),
    prefixedSha256(source.bytes),
    `Built Polish capture must differ from source capture: ${builtPath}`,
  );
  return { source, built };
}

function naiveWholeSerializedJsonFingerprint(bytes) {
  return prefixedSha256(bytes);
}

function naiveContributionIdentityFingerprint(value) {
  const identities = (value.contributions || [])
    .map((contribution) => ({ id: contribution.id, kind: contribution.kind }))
    .sort((left, right) => `${left.id}:${left.kind}`.localeCompare(`${right.id}:${right.kind}`));
  return prefixedSha256(JSON.stringify(identities));
}

function writeJson(path, value, spaces = 2) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, spaces)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]),
  );
}

function assertSchema(validate, value, label) {
  assert.equal(validate(value), true, `${label}: ${JSON.stringify(validate.errors, null, 2)}`);
}

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-dsp-polish-proof-"));
  const source = join(dir, "source");
  const target = join(dir, "target");
  const specPath = join(dir, "campaignspec.json");
  const manifestPath = join(source, ".campaigns-os/source-html-manifest.json");
  const landingPath = join(source, "landing.html");
  const desktopCapturePath = join(source, "captures/landing-desktop.png");
  const mobileCapturePath = join(source, "captures/landing-mobile.png");

  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(dirname(desktopCapturePath), { recursive: true });
  mkdirSync(target, { recursive: true });

  const landing = "<main><h1>Fingerprint proof landing</h1></main>\n";
  const desktopCapture = createRgbaPng(4, 3, [190, 40, 55, 255]);
  const mobileCapture = createRgbaPng(2, 4, [35, 150, 80, 255]);
  writeFileSync(landingPath, landing);
  writeFileSync(desktopCapturePath, desktopCapture);
  writeFileSync(mobileCapturePath, mobileCapture);

  writeJson(manifestPath, {
    schema_version: "source-html-manifest/v0",
    generated_at: "2026-08-23T08:00:00.000Z",
    generator: "dsp-polish-proof@1.0.0",
    campaign_slug: "dsp-polish-proof",
    producer_provenance: {
      source_type: "agency_html_export",
      generator_version: "1.0.0",
      material_fingerprint: sha256Hex("fixture producer handoff"),
    },
    files: [
      { path: "landing.html", role: "page", sha256: sha256Hex(landing) },
      { path: "captures/landing-desktop.png", role: "asset", sha256: sha256Hex(desktopCapture) },
      { path: "captures/landing-mobile.png", role: "asset", sha256: sha256Hex(mobileCapture) },
    ],
    pages: [{
      page_id: "landing",
      page_type: "landing",
      page_url: "landing/",
      path: "landing.html",
      source_hash: sha256Hex(landing),
      screenshot_refs: [
        {
          id: "landing-source-desktop",
          viewport: "desktop",
          path: "captures/landing-desktop.png",
          sha256: sha256Hex(desktopCapture),
          width: 4,
          height: 3,
          captured_at: "2026-08-23T08:01:00.000Z",
        },
        {
          id: "landing-source-mobile",
          viewport: "mobile",
          path: "captures/landing-mobile.png",
          sha256: sha256Hex(mobileCapture),
          width: 2,
          height: 4,
          captured_at: "2026-08-23T08:02:00.000Z",
        },
      ],
    }],
  });
  writeJson(specPath, {
    spec_identity: {
      map_id: "map-dsp-polish-proof",
      public_route_slug: "dsp-polish-proof",
    },
    campaign: { id: "dsp-polish-proof", slug: "dsp-polish-proof" },
    funnels: [{
      id: "default",
      weight: 100,
      pages: [{ id: "landing", type: "landing", label: "Landing", page_url: "landing/" }],
    }],
  });
  writeJson(join(target, "package.json"), { private: true });

  return {
    dir,
    source,
    target,
    specPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runPrepare(fixture) {
  const result = spawnSync(process.execPath, [
    CLI,
    "prepare-build",
    "--spec", fixture.specPath,
    "--source", fixture.source,
    "--target", fixture.target,
    "--template-family", "olympus",
    "--no-run-session",
    "--json",
  ], {
    cwd: fixture.dir,
    encoding: "utf8",
  });
  const stdout = String(result.stdout || "");
  return {
    status: result.status,
    stdout,
    stderr: String(result.stderr || ""),
    json: result.status === 0 ? JSON.parse(stdout) : null,
  };
}

function artifactPaths(target) {
  return {
    dsp: join(target, DSP_REL_PATH),
    packet: join(target, "campaign-runtime.build.json"),
    context: join(target, ".campaign-runtime/build-context.json"),
    report: join(target, ".campaign-runtime/assembly-report.json"),
  };
}

function assertExactDesignSourceReferences({ paths, packet, context, report, bytes, materialFingerprint }) {
  const exactHash = prefixedSha256(bytes);
  for (const [ownerPath, reference] of [
    [paths.packet, packet.design_source_package],
    [paths.context, context.design_source_package],
    [paths.report, report.design_source_package],
  ]) {
    assert.equal(resolve(dirname(ownerPath), reference.path), paths.dsp);
    assert.equal(reference.schema_version, "campaign-design-source-package/v0");
    assert.equal(reference.sha256, exactHash);
    assert.equal(reference.material_fingerprint, materialFingerprint);
  }
}

function refreshDesignSourceReferences({ packet, context, report }, bytes, materialFingerprint) {
  const exactHash = prefixedSha256(bytes);
  for (const reference of [
    packet.design_source_package,
    context.design_source_package,
    report.design_source_package,
  ]) {
    reference.sha256 = exactHash;
    reference.material_fingerprint = materialFingerprint;
  }
  return exactHash;
}

function persistReferencedArtifacts(paths, { packet, context, report }) {
  writeJson(paths.packet, packet);
  writeJson(paths.context, context);
  writeJson(paths.report, report);
}

function validPolishEvidence(captureArtifacts) {
  return {
    visual_review: {
      screenshots: captureArtifacts.map((artifact) => artifact.path),
      capture_artifacts: captureArtifacts,
    },
    brand_review: {
      logo_checked: true,
      favicon: { status: "confirmed_non_template", byte_match: true },
      colors: ["#123456"],
      brand_bleed: { cleared: true },
    },
    checkout_review: {
      field_labels: "Visible labels and initial hints reviewed.",
      payment_display: "Reviewed.",
      bump_compare_price_rule: "No equal compare price found.",
    },
    template_residue_review: {
      starter_favicon: { status: "confirmed_non_template" },
      starter_copy: "none found",
    },
    commerce_flow_review: { landing: "Built route reviewed independently from Build." },
    issues: [],
    commands: ["next-campaigns-polish"],
  };
}

async function attachOwnedPageLoadEvidence({ packet, report }) {
  const captured = await capturePolishPageLoad({
    packet,
    report,
    baseUrl: "https://polish-proof.invalid",
    createBrowserAdapter: async () => ({
      async captureRoute({ url, viewport }) {
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 12 },
          mediaElements: [],
          responses: [{
            request_id: `main-document-${viewport.key}`,
            url,
            resource_type: "Document",
            status: 200,
            mime_type: "text/html",
            encoded_data_length: 1_024,
            is_final_main_document: true,
            document_context_fingerprint: prefixedSha256(`document:${url}:${viewport.key}`),
          }],
        };
      },
      async close() {},
    }),
  });
  assert.equal(captured.page_load.schema_version, "campaigns-os-polish-page-load/v0");
  assert.equal(captured.page_load.performed_by, "campaigns-os polish capture");
  assert.equal(captured.page_load.measurement.status, "complete");
  assert.deepEqual(captured.page_load.findings, []);
  assert.equal(
    captured.page_load.captures.length,
    captured.plan.routes.length * captured.plan.viewports.length,
  );
  for (const capture of captured.page_load.captures) {
    assert.equal(capture.schema_version, "campaigns-os-polish-route-capture/v0");
    assert.equal(capture.performed_by, "campaigns-os polish capture");
    assert.equal(capture.subject.build_fingerprint, report.stages.assembly.build_fingerprint);
    assert.equal(capture.measurement_status, "complete");
    assert.equal(capture.producer_status, "complete");
    assert.equal(capture.response_collection.status, "complete");
    assert.match(capture.integrity.association_fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.match(capture.integrity.projection_fingerprint, /^sha256:[a-f0-9]{64}$/);
  }
  report.stages.polish.evidence.visual_review.page_load = captured.page_load;
  const checkpoint = evaluateRecordedHiddenEagerMediaCheckpoint({
    packet,
    report,
    now: RUNTIME_NOW,
  });
  assert.equal(checkpoint.status, "pass");
  assert.equal(checkpoint.code, "polish.hidden_eager_media.pass");
  assert.deepEqual(checkpoint.required_actions, []);
  return checkpoint;
}

test("real prepare-build emission drives Assembly and Polish freshness across both naive-fingerprint controls", async () => {
  const fixture = createFixture();
  try {
    const prepared = runPrepare(fixture);
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    assert.equal(prepared.json.designSourcePackageMode, "emitted");
    assert.equal(prepared.json.context.source_adapter, "html_funnel");

    const paths = artifactPaths(fixture.target);
    const emittedBytes = readFileSync(paths.dsp);
    const emittedDsp = JSON.parse(emittedBytes.toString("utf8"));
    const packet = readJson(paths.packet);
    const context = readJson(paths.context);
    const report = readJson(paths.report);

    assertSchema(validateDspSchema, emittedDsp, "emitted Design Source Package");
    assertSchema(validatePacketSchema, packet, "emitted Build Packet");
    assertSchema(validateContextSchema, context, "emitted Build Context");
    assertSchema(validateReportSchema, report, "emitted Assembly Report");
    const emittedRuntimeValidation = validateDesignSourcePackage(emittedDsp, { now: RUNTIME_NOW });
    assert.equal(emittedRuntimeValidation.ok, true, JSON.stringify(emittedRuntimeValidation.errors, null, 2));
    assert.equal(emittedDsp.source_kind, "html_funnel");
    assert.equal(emittedDsp.readiness.status, "ready");
    assert.equal(report.stages.prepare_build.status, "completed");
    assert.equal(computeDesignSourcePackageMaterialFingerprint(emittedDsp), emittedDsp.material_fingerprint);
    assertExactDesignSourceReferences({
      paths,
      packet,
      context,
      report,
      bytes: emittedBytes,
      materialFingerprint: emittedDsp.material_fingerprint,
    });
    assert.deepEqual(
      new Set([
        packet.design_source_package.material_fingerprint,
        context.design_source_package.material_fingerprint,
        report.design_source_package.material_fingerprint,
      ]),
      new Set([emittedDsp.material_fingerprint]),
    );
    const emittedHtmlContribution = emittedDsp.contributions
      .find((contribution) => contribution.id === "html-funnel");
    const sourceCaptureRefsByViewport = new Map(
      emittedHtmlContribution.screenshot_refs.map((reference) => [reference.viewport, reference]),
    );
    for (const [viewport, expectedDimensions] of [
      ["desktop", { width: 4, height: 3 }],
      ["mobile", { width: 2, height: 4 }],
    ]) {
      const reference = sourceCaptureRefsByViewport.get(viewport);
      assert.ok(reference, `emitted DSP must retain the ${viewport} source capture`);
      const decoded = decodePngFile(join(fixture.source, reference.path));
      assert.deepEqual(
        { width: decoded.width, height: decoded.height },
        expectedDimensions,
      );
      assert.equal(reference.sha256, prefixedSha256(decoded.bytes));
    }

    const forgedReady = structuredClone(emittedDsp);
    const activePageSurface = forgedReady.surface_identity.find((surface) => surface.kind === "page");
    assert.ok(activePageSurface);
    for (const contribution of forgedReady.contributions) {
      contribution.mappings = contribution.mappings
        .filter((mapping) => mapping.surface_id !== activePageSurface.id);
    }
    forgedReady.source_gaps = [];
    forgedReady.source_todos = [];
    forgedReady.waivers = [];
    forgedReady.readiness = {
      status: "ready",
      blocking_reasons: [],
      gap_count: 0,
      todo_count: 0,
      waiver_count: 0,
      generated_at: "2026-08-23T09:00:00.000Z",
    };
    forgedReady.readback = generateDesignSourcePackageReadback(forgedReady);
    forgedReady.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(forgedReady);
    assertSchema(validateDspSchema, forgedReady, "valid-shaped forged-ready Design Source Package");
    assert.match(forgedReady.readback.summary, /is ready;/);
    assert.equal(
      forgedReady.contributions.some((contribution) => contribution.mappings.some((mapping) =>
        mapping.surface_id === activePageSurface.id
        && ["primary_design", "template_baseline"].includes(mapping.coverage_role))),
      false,
    );
    const authoritativeForgedReadiness = evaluateDesignSourcePackageReadiness(forgedReady, {
      generatedAt: forgedReady.readiness.generated_at,
      now: RUNTIME_NOW,
    });
    assert.equal(authoritativeForgedReadiness.status, "blocked");
    assert.ok(authoritativeForgedReadiness.blocking_reasons.some((reason) => /lacks non-low primary_design/.test(reason)));
    const forgedRuntimeValidation = validateDesignSourcePackage(forgedReady, { now: RUNTIME_NOW });
    assert.equal(forgedRuntimeValidation.ok, false);
    assert.ok(forgedRuntimeValidation.errors.some((error) =>
      error.code === "design_source_package.readiness_contradiction"
      && error.path === "$.readiness.status"));
    assert.ok(forgedRuntimeValidation.errors.some((error) =>
      error.code === "design_source_package.readiness_blockers"));

    const builtOutputPath = join(fixture.target, "src/dsp-polish-proof/index.html");
    const builtDesktopPath = join(fixture.target, ".campaign-runtime/polish/landing-built-desktop.png");
    const builtMobilePath = join(fixture.target, ".campaign-runtime/polish/landing-built-mobile.png");
    mkdirSync(dirname(builtOutputPath), { recursive: true });
    mkdirSync(dirname(builtDesktopPath), { recursive: true });
    writeFileSync(builtOutputPath, "<main><h1>Built fingerprint proof</h1></main>\n");
    writeFileSync(builtDesktopPath, createRgbaPng(4, 3, [35, 90, 210, 255]));
    writeFileSync(builtMobilePath, createRgbaPng(2, 4, [235, 170, 25, 255]));

    const builtCaptureArtifacts = [
      {
        viewport: "desktop",
        path: ".campaign-runtime/polish/landing-built-desktop.png",
        media_type: "image/png",
        width: 4,
        height: 3,
        sha256: prefixedSha256(readFileSync(builtDesktopPath)),
      },
      {
        viewport: "mobile",
        path: ".campaign-runtime/polish/landing-built-mobile.png",
        media_type: "image/png",
        width: 2,
        height: 4,
        sha256: prefixedSha256(readFileSync(builtMobilePath)),
      },
    ];
    for (const artifact of builtCaptureArtifacts) {
      const builtPath = resolve(fixture.target, artifact.path);
      const sourceReference = sourceCaptureRefsByViewport.get(artifact.viewport);
      const pair = assertDistinctValidPngPair(
        join(fixture.source, sourceReference.path),
        builtPath,
      );
      assert.deepEqual(
        { width: pair.built.width, height: pair.built.height },
        { width: artifact.width, height: artifact.height },
      );
      assert.equal(artifact.sha256, prefixedSha256(pair.built.bytes));
      assert.equal(sourceReference.sha256, prefixedSha256(pair.source.bytes));
    }
    const malformedCapturePath = join(fixture.dir, "malformed-polish-capture.png");
    writeFileSync(malformedCapturePath, "not a PNG");
    assert.throws(
      () => assertDistinctValidPngPair(
        join(fixture.source, sourceCaptureRefsByViewport.get("desktop").path),
        join(fixture.dir, "missing-polish-capture.png"),
      ),
      /PNG evidence does not exist/,
    );
    assert.throws(
      () => assertDistinctValidPngPair(
        join(fixture.source, sourceCaptureRefsByViewport.get("desktop").path),
        malformedCapturePath,
      ),
      /PNG signature is invalid/,
    );
    assert.throws(
      () => assertDistinctValidPngPair(builtDesktopPath, builtDesktopPath),
      /Built Polish capture must differ from source capture/,
    );

    const consumedMaterialFingerprint = report.design_source_package.material_fingerprint;
    const buildFingerprint = prefixedSha256(readFileSync(builtOutputPath));
    report.stages.assembly = {
      ...report.stages.assembly,
      status: "completed",
      build_fingerprint: buildFingerprint,
      source_package_material_fingerprint: consumedMaterialFingerprint,
      outputs: ["src/dsp-polish-proof/index.html"],
      commands: ["npm run build"],
      blockers: [],
    };
    report.stages.polish = {
      ...report.stages.polish,
      status: "completed",
      performed_by: POLISH_PRODUCER,
      source_build_fingerprint: report.stages.assembly.build_fingerprint,
      source_package_material_fingerprint: consumedMaterialFingerprint,
      completed_at: "2026-08-23T10:00:00.000Z",
      commands: ["next-campaigns-polish"],
      evidence: validPolishEvidence(builtCaptureArtifacts),
      blockers: [],
    };
    const currentHiddenEagerMediaGate = await attachOwnedPageLoadEvidence({ packet, report });
    writeJson(paths.report, report);
    assertSchema(validateReportSchema, readJson(paths.report), "Assembly and Polish-owned report");
    const currentGate = evaluatePolishGate({
      report: readJson(paths.report),
      required: true,
      hiddenEagerMediaGate: currentHiddenEagerMediaGate,
    });
    assert.equal(currentGate.status, "pass");
    assert.equal(currentGate.code, "polish.evidence_current");
    assert.equal(currentGate.owned_checkpoint_status, "pass");
    assert.equal(currentGate.build_fingerprint, buildFingerprint);
    assert.equal(currentGate.current_source_package_material_fingerprint, consumedMaterialFingerprint);
    assert.equal(currentGate.assembly_source_package_material_fingerprint, consumedMaterialFingerprint);
    assert.equal(currentGate.source_package_material_fingerprint, consumedMaterialFingerprint);
    assert.deepEqual(currentGate.warnings, []);

    const naiveWholeJsonBefore = naiveWholeSerializedJsonFingerprint(emittedBytes);
    assert.equal(naiveWholeJsonBefore, report.design_source_package.sha256);
    const administrativeDsp = reverseKeys(structuredClone(emittedDsp));
    administrativeDsp.generated_at = "2030-01-01T00:00:00.000Z";
    administrativeDsp.notes = [
      ...administrativeDsp.notes,
      "Administrative review note that must not invalidate Build or Polish.",
    ];
    const administrativeBytes = Buffer.from(`${JSON.stringify(administrativeDsp, null, 4)}\n`);
    const naiveWholeJsonAfter = naiveWholeSerializedJsonFingerprint(administrativeBytes);
    assert.notEqual(
      naiveWholeJsonAfter,
      naiveWholeJsonBefore,
      "whole-serialized-JSON hashing falsely treats timestamps, notes, and formatting as material",
    );
    assert.equal(
      computeDesignSourcePackageMaterialFingerprint(administrativeDsp),
      consumedMaterialFingerprint,
      "the real material projection excludes administrative-only changes",
    );
    assert.equal(administrativeDsp.material_fingerprint, consumedMaterialFingerprint);
    assertSchema(validateDspSchema, administrativeDsp, "administratively changed Design Source Package");
    const administrativeRuntimeValidation = validateDesignSourcePackage(administrativeDsp, { now: RUNTIME_NOW });
    assert.equal(
      administrativeRuntimeValidation.ok,
      true,
      JSON.stringify(administrativeRuntimeValidation.errors, null, 2),
    );

    writeFileSync(paths.dsp, administrativeBytes);
    const refreshedAdministrativeHash = refreshDesignSourceReferences(
      { packet, context, report },
      administrativeBytes,
      consumedMaterialFingerprint,
    );
    assert.equal(refreshedAdministrativeHash, naiveWholeJsonAfter);
    persistReferencedArtifacts(paths, { packet, context, report });
    assertExactDesignSourceReferences({
      paths,
      packet: readJson(paths.packet),
      context: readJson(paths.context),
      report: readJson(paths.report),
      bytes: readFileSync(paths.dsp),
      materialFingerprint: consumedMaterialFingerprint,
    });
    const administrativePacket = readJson(paths.packet);
    const administrativeReport = readJson(paths.report);
    const administrativeHiddenEagerMediaGate = evaluateRecordedHiddenEagerMediaCheckpoint({
      packet: administrativePacket,
      report: administrativeReport,
      now: RUNTIME_NOW,
    });
    assert.equal(administrativeHiddenEagerMediaGate.status, "pass");
    const administrativeGate = evaluatePolishGate({
      report: administrativeReport,
      required: true,
      hiddenEagerMediaGate: administrativeHiddenEagerMediaGate,
    });
    assert.equal(administrativeGate.status, "pass");
    assert.equal(administrativeGate.code, "polish.evidence_current");
    assert.equal(administrativeGate.owned_checkpoint_status, "pass");
    assert.equal(administrativeGate.current_source_package_material_fingerprint, consumedMaterialFingerprint);
    assert.equal(administrativeGate.assembly_source_package_material_fingerprint, consumedMaterialFingerprint);

    const materialDsp = structuredClone(administrativeDsp);
    const underScopedBefore = naiveContributionIdentityFingerprint(materialDsp);
    const htmlContribution = materialDsp.contributions.find((contribution) => contribution.id === "html-funnel");
    const landingCoverage = htmlContribution.mappings.find((mapping) =>
      mapping.surface_id === activePageSurface.id && mapping.coverage_role === "primary_design");
    assert.ok(landingCoverage);
    assert.equal(landingCoverage.confidence, "high");
    landingCoverage.confidence = "medium";
    materialDsp.readiness = evaluateDesignSourcePackageReadiness(materialDsp, {
      generatedAt: materialDsp.readiness.generated_at,
      now: RUNTIME_NOW,
    });
    materialDsp.readback = generateDesignSourcePackageReadback(materialDsp);
    materialDsp.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(materialDsp);

    assert.notEqual(
      materialDsp.material_fingerprint,
      consumedMaterialFingerprint,
      "the real material fingerprint must notice the coverage confidence change",
    );
    assert.equal(
      naiveContributionIdentityFingerprint(materialDsp),
      underScopedBefore,
      "a contribution-identity-only fingerprint misses the coverage mapping change",
    );
    assert.equal(materialDsp.readiness.status, "ready");
    assertSchema(validateDspSchema, materialDsp, "materially changed Design Source Package");
    const materialRuntimeValidation = validateDesignSourcePackage(materialDsp, { now: RUNTIME_NOW });
    assert.equal(materialRuntimeValidation.ok, true, JSON.stringify(materialRuntimeValidation.errors, null, 2));

    const materialBytes = Buffer.from(`${JSON.stringify(materialDsp, null, 2)}\n`);
    writeFileSync(paths.dsp, materialBytes);
    refreshDesignSourceReferences(
      { packet, context, report },
      materialBytes,
      materialDsp.material_fingerprint,
    );
    assert.equal(report.stages.assembly.source_package_material_fingerprint, consumedMaterialFingerprint);
    assert.equal(report.stages.polish.source_package_material_fingerprint, consumedMaterialFingerprint);
    persistReferencedArtifacts(paths, { packet, context, report });
    assertExactDesignSourceReferences({
      paths,
      packet: readJson(paths.packet),
      context: readJson(paths.context),
      report: readJson(paths.report),
      bytes: readFileSync(paths.dsp),
      materialFingerprint: materialDsp.material_fingerprint,
    });

    const materiallyChangedPacket = readJson(paths.packet);
    const materiallyChangedReport = readJson(paths.report);
    const materiallyChangedHiddenEagerMediaGate = evaluateRecordedHiddenEagerMediaCheckpoint({
      packet: materiallyChangedPacket,
      report: materiallyChangedReport,
      now: RUNTIME_NOW,
    });
    assert.equal(materiallyChangedHiddenEagerMediaGate.status, "pass");
    const staleGate = evaluatePolishGate({
      report: materiallyChangedReport,
      required: true,
      hiddenEagerMediaGate: materiallyChangedHiddenEagerMediaGate,
    });
    assert.equal(staleGate.status, "blocked");
    assert.equal(staleGate.code, "polish.assembly_source_package_stale");
    assert.equal(staleGate.owned_checkpoint_status, "pass");
    assert.equal(staleGate.source_package_material_fingerprint, materialDsp.material_fingerprint);
    assert.equal(staleGate.assembly_source_package_material_fingerprint, consumedMaterialFingerprint);
    assert.deepEqual(staleGate.required_actions.map((action) => action.id), ["rerun_build"]);
  } finally {
    fixture.cleanup();
  }
});
