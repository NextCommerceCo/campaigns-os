// Doctor entry points: the doctor command, packet inspection and built-output inspection.
import { resolveCampaignIdentity } from "../spec-source-identity.mjs";
import { applyLocalPreviewToCheckpoint, applyLocalPreviewToPolishGate, carriedForwardMessage, CARRIED_FORWARD } from "../local-preview-policy.mjs";
import { withHtmlScanSnapshot } from "../html-scan.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { shellToken } from "../shell-token.mjs";
import { cmd } from "../install-invocation.mjs";
import { commitAssemblyReport, recordProducerStageOutcome } from "../stage-ledger.mjs";
import { annotateDoctorIssueCauses } from "../finding-cause.mjs";
import { DOCTOR_SIDECAR_SCHEMA } from "../doctor-sidecar.mjs";
import { recordQcResults } from "../qc-results.mjs";
import { resolveCampaignWorkspace } from "../campaign-workspace.mjs";
import { normalizePublicRouteSlug } from "../route-identity.mjs";
import { DEFAULT_PROXY_BASE } from "../spec-fetch.mjs";
import { disabledLiveRead, liveRefsDisabled, readLiveCampaignForPacket } from "../live-campaign-refs.mjs";
import { evaluateThemeGate } from "../theme-gate.mjs";
import { findForbiddenPriceHides } from "../template-brand-contract.mjs";
import { resolveBuiltSiteScope, synthesizeMinimalBuildPacket } from "../built-site-scope.mjs";
import { UPSELL_SELECTOR_SCOPE, builtPageTypeOverRouteGuess } from "../upsell-selector-scope.mjs";
import { CAMPAIGN_IDENTITY } from "../campaign-identity.mjs";
import { SDK_MARKUP } from "../sdk-markup.mjs";
import { SCRIPT_SYNTAX, collectBuiltScriptSyntaxInputs } from "../built-script-syntax.mjs";
import { CART_PLACEHOLDERS } from "../cart-placeholders.mjs";
import { SMOKE_QC } from "../built-smoke-qc.mjs";
import { stageIsTerminal } from "../orchestration-stage-contract.mjs";
import { evaluatePolishGate } from "../polish-gate.mjs";
import { evaluateRecordedHiddenEagerMediaCheckpoint } from "../polish-node.mjs";
import {
  requireArg,
  isObject,
  isNonEmptyString,
  optionalString,
  readJsonIfExists,
  relFromDir,
  isLocalAbsolutePath,
  portableArtifactPaths,
  addIssue,
} from "../cli-helpers.mjs";
import {
  PACKET_SCHEMA,
  runDoctorChecks,
  ARTIFACT_DOCTOR_CHECKS,
  validatePacket,
  recordUpsellSelectorScopeGate,
  collectBuiltPageIdentityInputs,
  recordCampaignIdentityGate,
  recordScriptSyntaxGate,
  recordSdkMarkupGate,
  recordCartPlaceholders,
  collectCartPlaceholderPages,
  recordSmokeQc,
  summarizeCopyMatches,
  resolveBrandContractOnce,
  reportBrandContractDefectOnce,
  validateBuiltPlaceholderTextResidue,
  validateBuiltDemoAssetFidelity,
  collectGenericTemplateResidueMatches,
} from "./checks.mjs";
import {
  gateIssue,
  pushGateIssue,
  nextPrepareBuildBindingIssues,
  prepareBuildGateIssue,
  addPrepareBuildGateErrors,
  checkpointExceptionPresent,
  buildNextStep,
} from "./next-step.mjs";

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

function relativizeDoctorOutput(result, baseDir) {
  const replacements = new Map();
  for (const value of Object.values(result.derived || {})) {
    if (isLocalAbsolutePath(value)) {
      replacements.set(value, relFromDir(baseDir, value));
    }
  }
  const sortedReplacements = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);

  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, visit(entryValue)]));
    }
    if (typeof value !== "string") return value;
    if (isLocalAbsolutePath(value)) return relFromDir(baseDir, value);
    let nextValue = value;
    for (const [absolutePath, relativePath] of sortedReplacements) {
      nextValue = nextValue.split(absolutePath).join(relativePath);
    }
    return nextValue;
  }

  return visit(result);
}
// Sidecar producer name; see the producer comment above NEXT_PRODUCER in src/cli.mjs.
const DOCTOR_PRODUCER = "doctor";

// The live campaign read the `doctor` command makes before it inspects (#533):
// packet mode only, only when the packet's built _site/<route>/ exists (with
// no built page there is nothing to compare, so nothing is sent), and only
// under the public Campaigns API key the packet, its local CampaignSpec or its
// declared campaign-key env var resolves. One GET of {proxy-base}/api/campaign;
// --proxy-base names the proxy, else the canonical one; --no-live-refs sends
// nothing and records not_run with reason `disabled`. `undefined` means no
// read was due, which doctor records as not_run; every other outcome,
// failures included, is a readLiveCampaign result.
export async function readDoctorLiveCampaign(args, { fetchImpl = globalThis.fetch, env = process.env, warn = undefined } = {}) {
  if (((args.built || args.site) && !args.packet) || !isNonEmptyString(args.packet)) return undefined;
  if (liveRefsDisabled(args)) return disabledLiveRead();
  let workspace;
  try {
    workspace = resolveCampaignWorkspace(resolve(args.packet), { followContextPointer: false });
  } catch {
    // An unreadable packet is doctor's own blocker; there is nothing to read for.
    return undefined;
  }
  const slug = normalizePublicRouteSlug(workspace.packet?.campaign?.public_route_slug);
  if (!workspace.targetRepo || !slug || !existsSync(join(workspace.targetRepo, "_site", slug))) return undefined;
  return readLiveCampaignForPacket({
    packet: workspace.packet,
    packetPath: workspace.packetPath,
    env,
    fetchImpl,
    proxyBase: optionalString(args["proxy-base"]) || DEFAULT_PROXY_BASE,
    ...(warn ? { warn } : {}),
  });
}

export function doctorCommand(args, { runDoctor = doctorPacket, liveCampaign = undefined, qcStandIns = undefined } = {}) {
  // Non-packet mode (learnings L7): doctor a `campaign-build`'d page-kit
  // campaign that has only a built _site/ and no full Build Packet. Resolves
  // scope from the built output and runs the built-output residue/text/
  // demo-asset/pricing gates against the chosen family's brand contract.
  const builtArg = args.built || args.site;
  if (builtArg && !args.packet) {
    return doctorBuiltOutput(args);
  }
  const packetPath = resolve(requireArg(args, "packet"));
  const explicitSidecarArgs = Boolean(args.context || args.report);
  const doctorOptions = {
    contextPath: args.context ? resolve(args.context) : explicitSidecarArgs ? null : undefined,
    reportPath: args.report ? resolve(args.report) : explicitSidecarArgs ? null : undefined,
    outputBaseDir: args["strip-paths"] === true ? dirname(packetPath) : null,
    // A live campaign read (live-campaign-refs.mjs) the caller already made;
    // absent, the live ref check is recorded not_run.
    ...(liveCampaign !== undefined ? { liveCampaign } : {}),
    // In-process QC stand-in checks (tests only; see qc-results.mjs).
    ...(qcStandIns !== undefined ? { qcStandIns } : {}),
  };
  const result = runDoctor(packetPath, doctorOptions);
  // Inspection and recording are separate operations. A laptop's untracked
  // built output can be stale while the delivered build's evidence is valid.
  // Only an explicit producer action may replace the retained proof artifacts;
  // --no-write wins if both flags are supplied.
  if (args.write === true && args["no-write"] !== true) {
    // The stage write-back restates the outcome into the report the
    // inspection read: the one --report named, else the one the Build Context
    // binds (`derived.assembly_report_path`, a `prepare-build --report-out`
    // campaign's report), else the default location. Following the binding is
    // what keeps the doctor stage on a bound report current; a report of
    // another campaign is still refused by commitAssemblyReport's identity
    // check, so the outcome never lands in another run's evidence. The
    // sidecar itself goes under the target repo, where prepare-build, next
    // and the QA stage refresh write it — not beside the packet.
    const inspectedReportPath = optionalString(result.derived?.assembly_report_path);
    const workspace = resolveCampaignWorkspace(packetPath, {
      reportPath: args.report
        ? resolve(args.report)
        : inspectedReportPath
          ? resolve(dirname(packetPath), inspectedReportPath)
          : undefined,
      doctorOutPath: args["doctor-out"] ? resolve(args["doctor-out"]) : undefined,
      followContextPointer: false,
    });
    // The sidecar is this inspection's result, written whether or not the
    // report gained a new chapter (a re-run restating the outcome already on
    // disk leaves the report's bytes, and every digest of them, alone). A
    // report this inspection did not read is not opened at all: its state,
    // malformed included, is not this run's concern.
    // This function is the `doctor` command; it states its own name for the
    // stage record and the sidecar's generated_by rather than re-reading
    // argv, which a programmatic caller may not have shifted (#312).
    commitAssemblyReport(workspace, (report) => recordDoctorStageOutcome(report, result, {
      command: `campaigns-os ${DOCTOR_PRODUCER}`,
      doctorOutPath: workspace.doctorOutPath,
      targetRepo: workspace.targetRepo,
    }), { stage: "doctor", command: DOCTOR_PRODUCER, refreshDoctor: () => result });
  }
  return result;
}

function recordDoctorStageOutcome(report, result, { command, doctorOutPath, targetRepo }) {
  return recordProducerStageOutcome(report, {
    stage: "doctor",
    disposition: result.ok ? (result.warnings?.length ? "ready_with_warnings" : "ready") : "blocked",
    timestamp: result.generated_at,
    command,
    outputs: portableArtifactPaths([doctorOutPath], targetRepo),
    blockers: (result.errors || []).map((issue) => issue?.message).filter(isNonEmptyString),
    warnings: (result.warnings || []).map((issue) => issue?.message).filter(isNonEmptyString),
  });
}


// L7 non-packet doctor: resolve scope from a built _site/, run the built-output
// gates the family brand contract drives, and auto-emit a minimal Build Packet
// (optionally written with --emit-packet) so QA can run against the same
// campaign without a hand-authored packet.
export function doctorBuiltOutput(args) {
  const targetRepo = resolve(String(args.built || args.site));
  const errors = [];
  const warnings = [];
  const ready = [];
  if (!existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) {
    addIssue(errors, "built_site.target", `Built campaign directory does not exist: ${targetRepo}`);
    return { ok: false, status: "blocked", mode: "built_site", errors, warnings, ready, derived: { mode: "built_site" }, next: null };
  }

  const scope = resolveBuiltSiteScope(targetRepo, { slug: optionalString(args.slug) });
  if (!scope.ok) {
    addIssue(errors, "built_site.scope", scope.error || "Could not resolve scope from the built _site/.");
    return { ok: false, status: "blocked", mode: "built_site", errors, warnings, ready, derived: { mode: "built_site", scope }, next: null };
  }

  const family = optionalString(args.family) || null;
  const baseUrl = optionalString(args["base-url"]);
  const mapId = optionalString(args["map-id"]);
  const deployTarget = optionalString(args["deploy-target"], "unknown");

  const derived = {
    mode: "built_site",
    map_id: mapId || scope.slug || null,
    public_route_slug: scope.slug || null,
    template_family: family,
    target_repo: targetRepo,
    target_output_dir: scope.campaign_dir,
    site_root: scope.site_root,
    built_pages: scope.pages.map((page) => ({ page_id: page.page_id, type: page.page_type, route: page.route })),
    doctor_checks: [],
    checkpoint_gates: [],
    // QC results: every result a QC check recomputed this run.
    qc_results: [],
  };
  ready.push(`Resolved ${scope.html_count} built page(s) from ${relFromDir(targetRepo, scope.campaign_dir)} (slug "${scope.slug || "(site root)"}")`);
  // #583: --base-url reads like a check of the deployed site, but these checks
  // read only the local built files. Say so wherever the URL is given, and
  // name the command that does load the served pages.
  if (baseUrl) {
    derived.base_url = { value: baseUrl, fetched: false, recorded_as: "deploy.preview_url" };
    // Without --family there is no value to print that the CLI would accept,
    // so the command is printed only when it is runnable as shown.
    const servedCheck = family
      ? `To check the served pages, run ${cmd("qa", `run --site ${shellToken(String(args.built || args.site))} --base-url ${shellToken(baseUrl)} --family ${shellToken(family)} --browser`)}.`
      : `To check the served pages, run ${cmd("qa")} run --site with this --base-url and the campaign's --family, plus --browser.`;
    ready.push(`Checked the local built files only: --base-url ${baseUrl} was not fetched; it only fills deploy.preview_url in the minimal Build Packet. ${servedCheck}`);
  }

  const resolution = resolveBrandContractOnce(derived, family);
  let brandContract = null;
  if (!family) {
    addIssue(warnings, "assembly.template_family", "No --family given; the residue/placeholder-text/demo-asset gates need a family brand contract to run. Pass --family <family> (the family the campaign was built from).");
  } else {
    reportBrandContractDefectOnce(resolution, warnings, family);
    brandContract = resolution.contract;
    if (!brandContract) {
      addIssue(warnings, "template_contract.brand_contract", `No brand/residue/pricing contract found for family "${family}". Built-output residue gates cannot run; confirm the family slug.`);
    } else {
      ready.push(`Template brand/residue/pricing contract loaded for ${family}`);
      validateBuiltPlaceholderTextResidue(brandContract, warnings, ready, derived);
      validateBuiltDemoAssetFidelity(brandContract, warnings, ready, derived);
      // Pricing CSS-hide scan (report omitted -> a missing assets/css dir reads
      // as a skipped ready-line, not a false "scan did not run" warning, since
      // built page-kit output may lay CSS out differently).
      runPricingCssHideCheck({ packet: { assembly: { template_family: family } }, derived, warnings, ready, report: null });
    }
  }

  // Family-agnostic generic placeholder residue (XXCODE / Product Title /
  // next-logo.png ...) always runs against the built output.
  const genericHits = collectGenericTemplateResidueMatches(scope.campaign_dir);
  if (genericHits.length) {
    addIssue(
      warnings,
      "template_contract.literal_residue",
      `Built output contains generic starter/template placeholders: ${summarizeCopyMatches(genericHits)}. Replace these from CampaignSpec/API or remove dead template references.`,
    );
  } else {
    ready.push("Built output has no generic starter placeholder or promo-code residue");
  }

  // Upsell selector scope (#270). Deliberately outside the family/brand-contract
  // branch above: the defect is family-independent, and this mode is reached
  // without --family more often than with it. Page roles come from the built
  // route (resolveBuiltSiteScope infers them) and from each page's own
  // next-page-type meta, so no packet or spec is needed; a `checkout` meta the
  // browser reads, declared unambiguously, replaces an ambiguous route guess
  // such as "/checkout-oto-1/", never an explicit upsell or downsell route (#529). No
  // assembly report exists on this path, so there are no waivers to assess — a
  // blocker here is repaired in the source, or waived through the packet path.
  recordUpsellSelectorScopeGate({
    subject: {
      public_route_slug: scope.slug || null,
      site_root: relFromDir(targetRepo, scope.campaign_dir),
    },
    pages: scope.pages.map((page) => {
      const content = readFileSync(page.built_path, "utf8");
      return {
        page_id: page.page_id,
        page_type: builtPageTypeOverRouteGuess({ route: page.route, route_type: page.page_type, content }),
        file: relFromDir(targetRepo, page.built_path),
        content,
      };
    }),
    waivers: null,
    errors,
    warnings,
    ready,
    derived,
  });
  derived.doctor_checks.push(UPSELL_SELECTOR_SCOPE);

  // Cross-page campaign identity (#301). Same placement and the same reasons:
  // family-independent, needs no packet, and the borrowed-page defect it gates
  // is most often introduced on exactly the page-kit campaigns this path
  // inspects.
  recordCampaignIdentityGate({
    subject: {
      public_route_slug: scope.slug || null,
      site_root: relFromDir(targetRepo, scope.campaign_dir),
    },
    pages: collectBuiltPageIdentityInputs(scope, targetRepo),
    errors,
    ready,
    derived,
  });
  derived.doctor_checks.push(CAMPAIGN_IDENTITY);

  // Static SDK markup checks (#303). Same placement, same reasons.
  recordSdkMarkupGate({
    subject: {
      public_route_slug: scope.slug || null,
      site_root: relFromDir(targetRepo, scope.campaign_dir),
    },
    pages: collectBuiltPageIdentityInputs(scope, targetRepo),
    errors,
    warnings,
    ready,
    derived,
  });
  derived.doctor_checks.push(SDK_MARKUP);

  // Campaign-owned script syntax (#480). Same placement, same reasons: a
  // hand-edited script that no longer parses is invisible to every HTML gate.
  recordScriptSyntaxGate({
    subject: {
      public_route_slug: scope.slug || null,
      site_root: relFromDir(targetRepo, scope.campaign_dir),
    },
    inputs: collectBuiltScriptSyntaxInputs(scope, targetRepo),
    errors,
    warnings,
    ready,
    derived,
  });
  derived.doctor_checks.push(SCRIPT_SYNTAX);

  // Raw cart placeholders. Same placement, same reasons; a QC
  // check whose warnings no blocker above withholds.
  recordCartPlaceholders({
    subject: {
      public_route_slug: scope.slug || null,
      site_root: relFromDir(targetRepo, scope.campaign_dir),
    },
    pages: collectCartPlaceholderPages(targetRepo, optionalString(args.slug)),
    warnings,
    ready,
    derived,
  });
  derived.doctor_checks.push(CART_PLACEHOLDERS);

  // Built-output smoke checks. Same placement, same reasons. This path has
  // no Assembly Report and no deploy URL, so the build environment and the
  // deploy base are unknown: the production-only rules and an absolute
  // og:image read unexercised here.
  recordSmokeQc({
    subject: {
      public_route_slug: scope.slug || null,
      site_root: relFromDir(targetRepo, scope.campaign_dir),
    },
    targetRepo,
    pages: collectCartPlaceholderPages(targetRepo, optionalString(args.slug)),
    environment: "unknown",
    deployBase: null,
    warnings,
    ready,
    derived,
  });
  derived.doctor_checks.push(SMOKE_QC);

  const synthesized = synthesizeMinimalBuildPacket({
    schemaVersion: PACKET_SCHEMA,
    targetRepo,
    scope,
    family,
    mapId,
    baseUrl,
    deployTarget,
  });
  derived.synthesized_packet = synthesized;

  let emittedPacketPath = null;
  if (args["emit-packet"]) {
    emittedPacketPath = args["emit-packet"] === true
      ? join(targetRepo, ".campaign-runtime", "minimal-build-packet.json")
      : resolve(String(args["emit-packet"]));
    mkdirSync(dirname(emittedPacketPath), { recursive: true });
    writeJson(emittedPacketPath, synthesized);
    ready.push(`Emitted minimal Build Packet to ${relFromDir(targetRepo, emittedPacketPath)}`);
  }

  const next = buildNextStep(errors, warnings, derived, null);
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  return {
    ok: errors.length === 0,
    status,
    mode: "built_site",
    errors,
    warnings,
    ready,
    derived,
    scope: { slug: scope.slug, html_count: scope.html_count, pages: derived.built_pages, campaign_dir: scope.campaign_dir },
    synthesized_packet: synthesized,
    emitted_packet_path: emittedPacketPath,
    next,
  };
}

export function doctorPacket(packetPath, options = {}) {
  const result = withHtmlScanSnapshot(() => inspectDoctorPacket(packetPath, options));
  // Per-finding cause classification lives HERE, at the single production
  // boundary, and not in the doctor command. Four producers persist
  // .campaign-runtime/doctor-output.json from a doctorPacket result — `doctor
  // --write`, `next`, `start`/`build` (prepare-build runs no doctor), and the
  // QA stage refresh — and annotating only one of them means running QA after
  // doctor silently strips the labels back out of the retained artifact. Every
  // consumer of a doctor result gets the same shape, whether or not it writes
  // one. Each producer stamps the artifact with its own name on the way out
  // (`generated_by`, #312; writeDoctorSidecar / stampDoctorProducer), so a
  // retained sidecar always says which of the four wrote it. `standardize` is
  // not one of them: it reads the target and writes nothing.
  //
  // The comparison set is the previous Run Record's own doctor observations
  // (error_codes / warning_codes), which every Run Record ever written already
  // carries — so this works against existing history rather than needing a run
  // to go by first. Code granularity, because that is the granularity the
  // record stores. baseDir is the packet directory, the same root the Run
  // Record writes under.
  // An invalid identity cannot select history. In particular, withholding a
  // malformed local ID from derived must not turn it into an unfiltered or
  // Map-only lookup of another campaign's findings.
  const comparableIdentity = resolveCampaignIdentity(result.derived)
    && !result.errors.some(issue => issue.code === "spec.local_identity" || issue.code === "spec.map_id");
  result.cause_summary = annotateDoctorIssueCauses({
    errors: result.errors,
    warnings: result.warnings,
    baseDir: comparableIdentity ? dirname(resolve(packetPath)) : null,
    mapId: result.derived?.map_id || null,
    localSpecId: result.derived?.local_spec_id || null,
  });
  return result;
}

function inspectDoctorPacket(packetPath, { contextPath = undefined, reportPath = undefined, outputBaseDir = null, liveCampaign = undefined, qcStandIns = null } = {}) {
  // The Build Context records where prepare-build wrote the report
  // (--report-out). `next` follows that pointer when no --report is given;
  // doctor reads the same report so its gates and its next block cannot
  // disagree with the ladder over which report is the campaign's.
  const { packet, targetRepo: gateTargetRepo, contextPath: resolvedContextPath, reportPath: resolvedReportPath } = resolveCampaignWorkspace(packetPath, {
    contextPath,
    reportPath,
    followContextPointer: true,
  });
  const context = readJsonIfExists(resolvedContextPath);
  const report = readJsonIfExists(resolvedReportPath);
  const errors = [];
  const warnings = [];
  const ready = [];
  const packetIdentity = resolveCampaignIdentity(packet?.spec);
  const derived = {
    packet_path: packetPath,
    // The report this inspection read (null when the caller switched the
    // report off), so a writer can refuse to restate the outcome into a
    // different file.
    assembly_report_path: typeof resolvedReportPath === "string" ? resolvedReportPath : null,
    map_id: packet?.spec?.map_id || null,
    ...(packetIdentity?.kind === "local_spec" ? { local_spec_id: packetIdentity.id } : {}),
    public_route_slug: packet?.campaign?.public_route_slug || null,
    template_family: packet?.assembly?.template_family || null,
    source_root: null,
    target_repo: null,
    target_output_dir: null,
    spec_path: null,
    doctor_checks: [],
    checkpoint_gates: [],
    // QC results: every result a QC check recomputed this run.
    qc_results: [],
    polish_checkpoint_gate: null,
    // The prepare-build gate `next` acts on, stored like every other gate so
    // the ladder consumes doctor's evaluation instead of computing its own.
    prepare_build_gate: null,
    // The family brand contract, resolved once per run: { state, family } plus
    // { code, detail } for a defect. The `next` advisories read it.
    brand_contract: null,
    page_kit_campaign_config: null,
    scaffold_required: false,
    scaffold_reason: null,
    scope: {
      mode: "unknown",
      built_pages: [],
      out_of_scope_pages: [],
      previewable_routes: [],
      blocked_runtime_pages: [],
    },
  };

  validatePacket(packet, packetPath, errors, warnings, ready, derived, { context, report, liveCampaign });
  runDoctorChecks(ARTIFACT_DOCTOR_CHECKS, { context, report, errors, warnings, ready, derived });

  // Doctor and the stage ladder must agree over one packet (#238): when the
  // recorded assembly report holds prepare_build at "blocked" (or claims a
  // terminal status while retaining blocking evidence), every `next <stage>`
  // command refuses to run — so doctor surfaces the same blockers as errors
  // instead of exiting 0 and naming a stage the ladder then rejects. Doctor
  // exit 0 means the command it names will actually run.
  const prepareBuildLadderGate = prepareBuildGateIssue(report);
  if (prepareBuildLadderGate?.blocked) {
    addPrepareBuildGateErrors(errors, report, prepareBuildLadderGate);
  }

  // Theme gate: evaluated once here so `next`, QA, and run telemetry all read
  // the same decision from derived.theme_gate. The doctor reports a blocked
  // gate as a WARNING (not an error) because the fix happens during the build
  // stage — but `next polish|deploy|qa` and `qa run` treat the same gate
  // result as a hard blocker.
  const themeGate = evaluateThemeGate({
    reportTheme: report?.theme || null,
    contextTheme: context?.theme || null,
    scope: derived.scope,
    packetPath,
  });
  derived.theme_gate = themeGate;
  if (themeGate.status === "blocked") {
    pushGateIssue({ errors, warnings }, gateIssue("theme_gate", themeGate));
  } else if (themeGate.status === "waived") {
    ready.push(`Theme gate waived: ${themeGate.waiver?.reason || "(no reason recorded)"}`);
  } else if (themeGate.status === "pass") {
    // The gate passes on two different facts (a brand layer applied, or no
    // generatable brand theme at all); print the one it found, never the
    // other. An operator reading ready[] on a token-less campaign must not
    // believe brand styling shipped.
    ready.push(`Theme gate passed: ${themeGate.reason}`);
  }
  runPricingCssHideCheck({ packet, derived, warnings, ready, report });

  // The local preview policy (local-preview-policy.mjs) carries missing
  // polish and page-load evidence forward as warnings on a local-serve packet.
  const polishCheckpointGate = applyLocalPreviewToCheckpoint(
    evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report }),
    { packet, report },
  );
  derived.polish_checkpoint_gate = polishCheckpointGate;
  const polishGate = applyLocalPreviewToPolishGate(evaluatePolishGate({
    report,
    hiddenEagerMediaGate: polishCheckpointGate,
    currentOutputFingerprint: derived.build_output_fingerprint?.value || null,
  }), { packet, checkpointGate: polishCheckpointGate });
  derived.polish_gate = polishGate;
  if (polishGate.status === "blocked" && !polishGate.owned_checkpoint_only) {
    pushGateIssue({ errors, warnings }, gateIssue("polish_gate", polishGate));
  } else if (polishGate.status === CARRIED_FORWARD && !polishGate.owned_checkpoint_only) {
    addIssue(warnings, polishGate.code, carriedForwardMessage(polishGate), { polish_gate: polishGate });
  } else if (polishGate.status === "waived" && !polishGate.owned_checkpoint_only) {
    ready.push(`Polish gate passed under waiver: ${polishGate.waiver?.reason || "(no reason recorded)"}`);
  } else if (polishGate.status === "pass") {
    ready.push("Polish gate passed: structured evidence is current for this build.");
  }

  if (polishCheckpointGate.status === "blocked") {
    pushGateIssue({ errors, warnings }, gateIssue("polish_checkpoint_gate", polishCheckpointGate));
  } else if (polishCheckpointGate.status === CARRIED_FORWARD) {
    addIssue(warnings, polishCheckpointGate.code, carriedForwardMessage(polishCheckpointGate), { polish_checkpoint_gate: polishCheckpointGate });
  } else if (polishCheckpointGate.status === "waived") {
    addIssue(
      warnings,
      polishCheckpointGate.code,
      `${polishCheckpointGate.reason} Waived by ${polishCheckpointGate.waiver.waived_by}: ${polishCheckpointGate.waiver.reason}`,
      { polish_checkpoint_gate: polishCheckpointGate },
    );
    ready.push(`Hidden eager-media checkpoint accepted under named-human exception (${polishCheckpointGate.waiver.waived_by}).`);
  } else if (polishCheckpointGate.status === "pass") {
    ready.push("Hidden eager-media checkpoint passed: package-owned page-load evidence is complete and current.");
  } else {
    ready.push("Hidden eager-media checkpoint not applicable before completed assembly.");
  }

  // QC stand-in checks reach doctor only through this in-process option
  // (tests); the shipped checks record through recordQcResults themselves.
  for (const check of Array.isArray(qcStandIns?.doctor) ? qcStandIns.doctor : []) {
    recordQcResults({ derived, warnings, results: check() });
  }

  // The same fully resolved prepare-build gate the `next` command evaluates:
  // DSP-required packets, the recorded report path and the context/report
  // binding checks. A weaker gate here would let doctor name setup or build
  // while `next` still answers prepare-build.
  // With no context on hand (doctor --report alone) the binding checks have
  // nothing to compare and are skipped; the report itself was resolved
  // above the way `next` resolves it.
  // The stage decision runs over exactly the artifacts the checks ran over.
  // A caller that named one sidecar and not the other (doctor --context C)
  // is inspecting, and its report checks are deliberately off; its next
  // block decides without the report too, and says so in `reason`. The
  // binding is evaluated whether or not a Build Context was found: an absent
  // context is itself a binding failure for a packet that declares a Design
  // Source Package, and `next` consumes this gate rather than computing its
  // own, so the two cannot answer differently on the same repo.
  const prepareBuildGate = prepareBuildGateIssue(report, {
    required: isObject(packet?.design_source_package),
    reportPath: resolvedReportPath,
    bindingIssues: isObject(packet)
      ? nextPrepareBuildBindingIssues({
          packet,
          packetPath,
          context,
          contextPath: resolvedContextPath,
          report,
          reportPath: resolvedReportPath,
          targetRepo: gateTargetRepo,
          explicitReport: typeof reportPath === "string",
        })
      : [],
  });
  derived.prepare_build_gate = prepareBuildGate;
  // Portable output (outputBaseDir set: start's generated doctor output,
  // doctor --strip-paths) rebases them onto that base like every other path
  // in the output, so a relocated handoff does not name the original machine.
  const sidecarArg = (path) => shellToken(outputBaseDir ? relFromDir(outputBaseDir, path) : path);
  const sidecarArgs = [
    ...(typeof contextPath === "string" ? [` --context ${sidecarArg(contextPath)}`] : []),
    ...(typeof reportPath === "string" ? [` --report ${sidecarArg(reportPath)}`] : []),
  ].join("");
  const next = buildNextStep(errors, warnings, derived, report, packet, prepareBuildGate, { sidecarArgs });
  // Portable output: a sidecar path the picker's reason names is rebased
  // like every other path in the output.
  if (outputBaseDir && typeof next?.reason === "string") {
    for (const path of [resolvedContextPath, resolvedReportPath]) {
      if (typeof path === "string" && next.reason.includes(path)) {
        next.reason = next.reason.split(path).join(relFromDir(outputBaseDir, path));
      }
    }
  }
  const status = errors.length
    ? "blocked"
    : checkpointExceptionPresent(derived)
      ? "ready_with_waivers"
      : warnings.length
        ? "ready_with_warnings"
        : "ready";
  const result = {
    schema_version: DOCTOR_SIDECAR_SCHEMA,
    generated_at: new Date().toISOString(),
    ok: errors.length === 0,
    status,
    errors,
    warnings,
    ready,
    derived,
    next,
  };
  return outputBaseDir ? relativizeDoctorOutput(result, outputBaseDir) : result;
}

// Pricing surfaces are rendered by mode-driven partials, never hidden with
// campaign CSS — a display:none on a price wrapper is how the recovery-relief
// dogfood run shipped a full-price upsell with NO visible price. Deterministic
// static scan: campaign-owned CSS files (not the family core stylesheet, not
// the generated brand layer) must not display:none any selector the family
// brand contract lists under pricing_surfaces.forbidden_css_hides. Doctor
// reports a warning with the exact rule; browser QA enforces the outcome
// (zero visible price rows) as a blocker.
export function runPricingCssHideCheck({ packet, derived, warnings, ready, report = null }) {
  const family = packet?.assembly?.template_family;
  const resolution = resolveBrandContractOnce(derived, family);
  if (resolution.error) {
    reportBrandContractDefectOnce(resolution, warnings, family);
    return;
  }
  const contract = resolution.contract;
  if (!contract?.pricing_surfaces?.forbidden_css_hides?.length) {
    ready.push(`Pricing CSS scan not applicable for template family "${family || "(none)"}" (no brand contract with forbidden_css_hides)`);
    return;
  }
  // Missing campaign output is normal before setup/build (audit ready-line),
  // but anomalous once the assembly stage is recorded terminal — at that
  // point a missing dir means the scan that should have covered built CSS
  // never ran, which the operator must see as a warning, not a footnote.
  const assemblyDone = stageIsTerminal(report?.stages?.assembly?.status);
  const skipScan = (reason) => {
    if (assemblyDone) {
      addIssue(warnings, "template_contract.price_css_scan_skipped", `Pricing CSS scan did NOT run although assembly is recorded terminal: ${reason}. Check assembly.target_repo / output_dir configuration.`);
    } else {
      ready.push(`Pricing CSS scan skipped: ${reason} (runs after setup/build)`);
    }
  };
  const outputDir = derived.target_output_dir;
  if (!outputDir || !existsSync(outputDir)) {
    skipScan("target output directory does not exist");
    return;
  }
  const cssDir = join(outputDir, "assets/css");
  if (!existsSync(cssDir)) {
    skipScan("campaign assets/css directory does not exist");
    return;
  }
  const coreStylesheet = contract.css_load_order?.core_stylesheet || "next-core.css";
  const campaignCssFiles = readdirSync(cssDir)
    .filter((name) => name.endsWith(".css") && name !== coreStylesheet && name !== "brand-theme.css");
  let hideCount = 0;
  for (const name of campaignCssFiles) {
    const cssPath = join(cssDir, name);
    let cssText = "";
    try {
      cssText = readFileSync(cssPath, "utf8");
    } catch {
      continue;
    }
    for (const hit of findForbiddenPriceHides(contract, cssText)) {
      hideCount += 1;
      addIssue(
        warnings,
        "template_contract.price_css_hide",
        `Campaign CSS ${name} hides a pricing surface: "${hit.selector}" sets display:none on ${hit.target}. Use the template's declared pricing modes instead of hiding price rows; browser QA blocks upsells with zero visible price rows.`,
      );
    }
  }
  if (hideCount === 0 && campaignCssFiles.length) {
    ready.push(`Campaign CSS has no display:none rules on ${family} pricing surfaces`);
  }
}
