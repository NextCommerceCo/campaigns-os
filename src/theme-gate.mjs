// Theme gate: turns the advisory "theme inspect found a generatable brand
// theme" signal into a deterministic stage gate.
//
// Doctrine: when theme inspect proves a brand layer CAN be generated and the
// campaign ships commerce pages, polish/deploy/QA must not proceed until the
// brand layer is generated and applied after next-core.css — or an operator
// records an explicit waiver with a reason. Advisory prose is exactly what
// agents skipped in the recovery-relief-stack-v1 dogfood run; this module is
// the single decision point every consumer (next, doctor, qa) shares.
const COMMERCE_PAGE_TYPES = new Set(["checkout", "upsell", "downsell", "receipt", "thankyou"]);

export const THEME_GATE_STATUSES = new Set(["pass", "blocked", "waived", "not_applicable"]);

export function commercePagesFromScope(scope) {
  const pages = Array.isArray(scope?.built_pages) ? scope.built_pages : [];
  return pages.filter(
    (page) => COMMERCE_PAGE_TYPES.has(String(page?.type || "")) || String(page?.role || "") === "runtime",
  );
}

export function themeWaiverFrom(reportTheme, ephemeralWaiver = null) {
  if (typeof ephemeralWaiver === "string" && ephemeralWaiver.trim()) {
    return { reason: ephemeralWaiver.trim(), waived_by: "cli_flag", waived_at: null };
  }
  const waiver = reportTheme?.waiver;
  if (waiver && typeof waiver === "object" && typeof waiver.reason === "string" && waiver.reason.trim()) {
    return waiver;
  }
  return null;
}

/**
 * Evaluate the theme gate for a campaign.
 *
 * @param {object} options
 * @param {object|null} options.reportTheme   Assembly report theme block.
 * @param {object|null} options.contextTheme  Build-context theme block (theme inspect result).
 * @param {object|null} options.scope         Doctor derived scope ({ built_pages: [...] }).
 * @param {string|null} options.packetPath    Build packet path, used to render exact commands.
 * @param {string|null} options.waive         Ephemeral waiver reason from a CLI flag (--theme-waive).
 *
 * @returns {{
 *   status: "pass"|"blocked"|"waived"|"not_applicable",
 *   code: string,
 *   reason: string,
 *   commerce_pages: string[],
 *   waiver: object|null,
 *   required_actions: Array<{ id: string, kind: "command"|"manual", command: string|null, description: string }>,
 * }}
 */
export function evaluateThemeGate({ reportTheme = null, contextTheme = null, scope = null, packetPath = null, waive = null } = {}) {
  const packetArg = packetPath || "<campaign-runtime.build.json>";
  const commercePages = commercePagesFromScope(scope).map((page) => page.page_id || page.route || page.type);
  const result = (status, code, reason, requiredActions = []) => ({
    status,
    code,
    reason,
    commerce_pages: commercePages,
    waiver: null,
    required_actions: requiredActions,
  });

  const policy = contextTheme?.policy || null;
  if (policy === "off") {
    return result("not_applicable", "theme_gate.policy_off", "Theme policy is off; brand layer is explicitly out of scope for this run.");
  }
  if (!commercePages.length) {
    return result("not_applicable", "theme_gate.no_commerce_pages", "Campaign ships no commerce pages; the brand-layer gate does not apply.");
  }

  const waiver = themeWaiverFrom(reportTheme, waive);
  if (waiver) {
    const waived = result("waived", "theme_gate.waived", `Theme gate waived: ${waiver.reason}`);
    waived.waiver = waiver;
    return waived;
  }

  const status = String(reportTheme?.status || "");
  const loadOrder = String(reportTheme?.load_order || "");
  const canGenerate = contextTheme?.generated?.can_generate === true;

  if (status === "applied") {
    if (loadOrder !== "after-next-core") {
      return result(
        "blocked",
        "theme_gate.load_order",
        `Brand theme is recorded as applied but load_order is "${loadOrder || "unknown"}"; commerce pages must load brand-theme.css after next-core.css.`,
        [
          {
            id: "fix_load_order",
            kind: "manual",
            command: null,
            description: "List brand-theme.css after next-core.css in commerce-page frontmatter styles, rebuild, then record report.theme.load_order=after-next-core.",
          },
        ],
      );
    }
    return result("pass", "theme_gate.applied", "Brand theme is applied after next-core.css on commerce pages.");
  }

  if (status === "skipped" && !canGenerate) {
    return result("pass", "theme_gate.nothing_generatable", "No generatable brand theme was found; the gate passes without a brand layer.");
  }

  if (!canGenerate && !status) {
    return result("not_applicable", "theme_gate.no_theme_context", "No theme context exists for this campaign; run prepare-build/theme inspect to populate it.");
  }

  if (!canGenerate) {
    // needs_review/blocked without a generatable artifact: the operator must
    // decide. Treat as blocked so the decision is recorded, not improvised.
    return result(
      "blocked",
      "theme_gate.needs_decision",
      `Assembly report theme status is "${status || "missing"}" and no generatable brand theme exists; record an applied brand layer or waive the gate with a reason.`,
      [
        {
          id: "waive_theme",
          kind: "command",
          command: `campaigns-os theme waive --packet ${packetArg} --reason "<why the starter palette is acceptable>"`,
          description: "Record an explicit operator waiver if shipping without a campaign brand layer is intentional.",
        },
      ],
    );
  }

  return result(
    "blocked",
    "theme_gate.generatable_not_applied",
    "theme inspect proved a brand theme can be generated, but it has not been generated and applied to commerce pages. Demeter-family commerce pages consume --brand--* tokens; without the brand layer they ship the starter palette.",
    [
      {
        id: "theme_generate",
        kind: "command",
        command: `campaigns-os theme generate --packet ${packetArg}`,
        description: "Generate .campaign-runtime/theme/brand-theme.css from the inspected source tokens.",
      },
      {
        id: "apply_brand_layer",
        kind: "manual",
        command: null,
        description: "Copy brand-theme.css into the campaign assets/css folder, list it after next-core.css in checkout/upsell/downsell/receipt frontmatter styles, rebuild, then record report.theme.status=applied, load_order=after-next-core, and commerce_pages.",
      },
      {
        id: "waive_theme",
        kind: "command",
        command: `campaigns-os theme waive --packet ${packetArg} --reason "<why the starter palette is acceptable>"`,
        description: "Or record an explicit operator waiver instead of applying the brand layer.",
      },
    ],
  );
}
