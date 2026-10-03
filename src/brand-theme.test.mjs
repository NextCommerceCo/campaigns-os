import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  inspectBrandTheme,
  validateAssemblyReportThemeBlock,
  validateGeneratedCss,
  validateThemeContextBlock,
  writeThemeArtifacts,
} from "./brand-theme.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(root, "bin/campaigns-os.mjs");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-brand-theme-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function makePacket(dir, pages = [{ page_id: "landing", path: "landing.html" }]) {
  const source = join(dir, "source");
  const target = join(dir, "target");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  const packetPath = join(target, "campaign-runtime.build.json");
  const packet = {
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: {
      public_route_slug: "brand-demo",
      campaign_directory: "brand-demo",
      live_url_path: "/brand-demo/",
      allowed_domains_confirmed: true,
    },
    spec: {
      map_id: "brand-demo-k9x2",
      local_path: "../spec.json",
    },
    source_html: {
      root: "../source",
      pages,
    },
    assembly: {
      target_repo: ".",
      output_dir: "src/brand-demo",
      template_family: "olympus",
      template_lock: { locked: true },
    },
    deploy: { target: "unknown" },
    qa: {},
  };
  writeJson(packetPath, packet);
  return { source, target, packet, packetPath };
}

function highConfidenceTokens() {
  return `
:root {
  --brand-primary: #2c3d43;
  --brand-accent: #2dc20b;
  --brand-cta: #2dc20b;
  --surface-bg: #ffffff;
  --surface-card: #f3f7f4;
  --text-primary: #132025;
  --text-secondary: #55676f;
  --border-default: #d7e1dc;
}
`;
}

test("brand theme discovers linked CSS from mapped HTML and maps root-only next-core tokens", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "styles"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<link rel="stylesheet" href="styles/brand.css"><main>Landing</main>`);
    writeFileSync(join(source, "styles/brand.css"), highConfidenceTokens());

    const result = inspectBrandTheme({ packet, packetPath });

    assert.equal(result.status, "ready");
    assert.equal(result.confidence, "high");
    assert.equal(result.context_theme.selected_source.source, "mapped_html_reference");
    assert.ok(result.context_theme.mappings.some((mapping) => mapping.target === "--brand--color--primary"));
    assert.ok(result.context_theme.mappings.some((mapping) => mapping.target === "--brand--color--cta-primary"));
    assert.equal(validateGeneratedCss(result.css).ok, true);
    assert.match(result.css, /:root \{/);
    assert.doesNotMatch(result.css, /\.checkout|data-next|button\s*\{/);
  });
});

test("brand theme infers safe CTA tokens from linked button CSS when root tokens are absent", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "styles"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<link rel="stylesheet" href="styles/marketing.css"><main>Landing</main>`);
    writeFileSync(join(source, "styles/marketing.css"), `
.muted-card { background-color: #f6f6f6; }
.cta-button {
  background-color: #e4572e;
  color: #ffffff;
}
`);

    const result = inspectBrandTheme({ packet, packetPath });

    // The declared white label (3.68:1 on #e4572e) is kept (#535) and flagged
    // for being under 4.5:1.
    assert.equal(result.status, "ready_with_warnings");
    assert.deepEqual([...new Set(result.warnings.map((warning) => warning.code))], ["theme.foreground.low_contrast"]);
    assert.equal(result.confidence, "medium");
    assert.equal(result.context_theme.selected_source.source, "mapped_html_reference");
    assert.ok(result.context_theme.mappings.some((mapping) => (
      mapping.source === "--button-primary-bg"
      && mapping.target === "--brand--color--cta-primary"
      && mapping.value === "#e4572e"
    )));
    assert.match(result.css, /--brand--color--cta-primary: #e4572e;/);
    assert.equal(result.context_theme.generated.can_generate, true);
    assert.equal(result.context_theme.generated.can_auto_generate, false);
  });
});

test("brand theme normalizes role-like source tokens into a complete commerce token family", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir, [{ page_id: "checkout", path: "checkout.html" }]);
    mkdirSync(join(source, "styles"), { recursive: true });
    writeFileSync(join(source, "checkout.html"), `<link rel="stylesheet" href="styles/roadside.css"><main>Checkout</main>`);
    writeFileSync(join(source, "styles/roadside.css"), `
:root {
  --pt-teal: #125161;
  --pt-green: #1aae2d;
}
.checkout-header { background: var(--pt-teal); border-bottom: 4px solid var(--pt-green); }
.accept-btn { background: linear-gradient(to bottom, #1aae2d 0%, #148c24 100%); color: #ffffff; }
.panel { background: #ffffff; border: 1px solid #eee; }
.input-flds { border: 1px solid #ccd; color: #101010; }
.stars { color: #ffb400; }
`);

    const result = inspectBrandTheme({ packet, packetPath });
    const targets = new Set(result.context_theme.mappings.map((mapping) => mapping.target));

    assert.equal(result.status, "ready");
    assert.equal(result.confidence, "medium");
    for (const target of [
      "--brand--color--primary",
      "--brand--color--primary-dark",
      "--brand--color--primary-light",
      "--brand--color--cta-primary",
      "--brand--color--surface",
      "--brand--color--border",
      "--component--color--outline",
      "--brand--color--foreground",
      "--brand--color--rating-star",
    ]) {
      assert.ok(targets.has(target), `expected generated mapping for ${target}`);
    }
    assert.match(result.css, /--brand--color--primary: #125161;/);
    assert.match(result.css, /--brand--color--cta-primary: #1aae2d;/);
    assert.match(result.css, /--brand--color--rating-star: #ffb400;/);
  });
});

test("brand theme treats a stylesheet linked from pages of several roles as shared, ahead of one page's vendor CSS", () => {
  withTempDir((dir) => {
    const pages = ["landing", "presell", "checkout", "upsell"].map((page_id) => ({ page_id, path: `${page_id}.html` }));
    const { source, packet, packetPath } = makePacket(dir, pages);
    mkdirSync(join(source, "assets/landing/css"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<link rel="stylesheet" href="assets/landing/css/lightbox.css"><main>Landing</main>`);
    writeFileSync(join(source, "assets/landing/css/lightbox.css"), `.lightbox-caption { color: #444; }\n`);
    for (const page of ["presell", "checkout", "upsell"]) {
      writeFileSync(join(source, `${page}.html`), `<link rel="stylesheet" href="assets/brand.css"><main>${page}</main>`);
    }
    writeFileSync(join(source, "assets/brand.css"), highConfidenceTokens());

    const result = inspectBrandTheme({ packet, packetPath });
    const selected = result.context_theme.selected_source;

    assert.match(selected.path, /assets\/brand\.css$/);
    assert.equal(selected.role, "shared");
    assert.deepEqual(selected.referenced_by.map((ref) => ref.page_id), ["presell", "checkout", "upsell"]);
    assert.match(result.css, /--brand--color--primary: #2c3d43;/);
  });
});

test("brand theme detects inline :root tokens from mapped HTML without workflow-order assumptions", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    writeFileSync(join(source, "landing.html"), `
<style>${highConfidenceTokens()}</style>
<script type="application/ld+json">{":root { --brand-primary: #ff0000; }": true}</script>
<main>Landing</main>
`);

    const result = inspectBrandTheme({ packet, packetPath });

    assert.equal(result.context_theme.selected_source.source, "html_inline_root");
    assert.equal(result.context_theme.selected_source.inline_block_index, 0);
    assert.equal(result.confidence, "high");
    assert.match(result.css, /--brand--color--primary: #2c3d43;/);
    assert.doesNotMatch(result.css, /#ff0000/);
  });
});

test("brand theme avoids broad root-token role inference for layout and foreground utility names", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "styles"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<link rel="stylesheet" href="styles/utilities.css"><main>Landing</main>`);
    writeFileSync(join(source, "styles/utilities.css"), `
:root {
  --nav-bg: #125161;
  --header-divider: #1aae2d;
  --card-shadow: #eeeeee;
  --panel-border: #dddddd;
  --brand--color--foreground: #101010;
  --white-smoke: #f8f8f8;
  --success-message-bg: #dff5e8;
  --text-bg: #fafafa;
  --section-bg: #f2f2f2;
  --background-inverse: #222222;
  --cta-primary: #e4572e;
  --text-primary: #111111;
  --surface-bg: #ffffff;
}
`);

    const result = inspectBrandTheme({ packet, packetPath });
    const mappings = result.context_theme.mappings;
    const mappedTargets = new Set(result.context_theme.mappings.map((mapping) => mapping.target));

    assert.equal(mappedTargets.has("--brand--color--primary"), false);
    assert.equal(mappings.some((mapping) => mapping.source === "--surface-card"), false);
    // text-inverse is no longer name-inferred from --background-inverse (#222222);
    // it is now a luminance-derived foreground paired with the mapped CTA bg.
    const textInverse = mappings.find((mapping) => mapping.target === "--brand--color--text-inverse");
    assert.ok(textInverse, "expected a derived text-inverse foreground");
    assert.equal(textInverse.derivation?.method, "foreground-from-luminance");
    assert.equal(textInverse.derivation?.background, "--brand--color--cta-primary");
    assert.notEqual(textInverse.value, "#222222");
    assert.equal(result.context_theme.selected_source.tokens?.["--state-success"], undefined);
    assert.equal(mappings.find((mapping) => mapping.target === "--brand--color--background")?.source, "--surface-bg");
    assert.ok(mappedTargets.has("--brand--color--cta-primary"));
    assert.ok(mappedTargets.has("--brand--color--background"));
    assert.ok(mappedTargets.has("--brand--color--text-primary"));
  });
});

test("brand theme derives dark foregrounds for a light brand (no white-on-yellow CTAs)", () => {
  withTempDir((dir) => {
    // Regression for a yellow-brand build: a brand (#ffe100) whose
    // generated foregrounds were all white, so next-core .button text
    // (color: var(--brand--color--text-inverse)) was illegible on the CTA.
    const { source, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "styles"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<link rel="stylesheet" href="styles/brand.css"><main>Landing</main>`);
    writeFileSync(join(source, "styles/brand.css"), `
:root {
  --brand-primary: #ffe100;
  --brand-cta: #ffe100;
  --brand-accent: #ffe100;
  --surface-bg: #ffffff;
  --text-primary: #1a1a1a;
  --text-secondary: #555555;
  --border-default: #e6e6e6;
}
`);

    const result = inspectBrandTheme({ packet, packetPath });
    const byTarget = new Map(result.context_theme.mappings.map((mapping) => [mapping.target, mapping]));

    // Assert the contract being tested (dark, not white) rather than the exact
    // hex, so changing foreground_choices.dark doesn't break these.
    for (const target of [
      "--brand--color--text-inverse",
      "--brand--color--cta-foreground",
      "--brand--color--primary-foreground",
      "--brand--color--accent-foreground",
    ]) {
      const mapping = byTarget.get(target);
      assert.ok(mapping, `expected derived ${target}`);
      assert.equal(mapping.derivation?.on, "dark", `${target} on a yellow brand must resolve to a dark foreground`);
      assert.notEqual(mapping.value, "#ffffff", `${target} on a yellow brand must not be white`);
      assert.equal(mapping.derivation?.method, "foreground-from-luminance");
    }
    // The CTA-text variable that next-core actually renders is text-inverse:
    // it must not be white on a light brand.
    assert.doesNotMatch(result.css, /--brand--color--text-inverse: #ffffff;/);
  });
});

test("brand theme keeps white foregrounds on a dark brand", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "styles"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<link rel="stylesheet" href="styles/brand.css"><main>Landing</main>`);
    writeFileSync(join(source, "styles/brand.css"), `
:root {
  --brand-primary: #0b1f3a;
  --brand-cta: #0b1f3a;
  --surface-bg: #ffffff;
  --text-primary: #111111;
}
`);

    const result = inspectBrandTheme({ packet, packetPath });
    const textInverse = result.context_theme.mappings.find((mapping) => mapping.target === "--brand--color--text-inverse");
    assert.ok(textInverse);
    assert.equal(textInverse.value, "#ffffff");
    assert.equal(textInverse.derivation?.on, "light");
  });
});

// #535 item 8: on a red CTA (#dd4249) black scores 4.67:1 and white 4.24:1, so
// the luminance pick is black. A declared white label clears 3:1 (AA large)
// and is the design's intent.
function inspectCtaSource(dir, css) {
  const { source, packet, packetPath } = makePacket(dir);
  mkdirSync(join(source, "styles"), { recursive: true });
  writeFileSync(join(source, "landing.html"), `<link rel="stylesheet" href="styles/brand.css"><main>Landing</main>`);
  writeFileSync(join(source, "styles/brand.css"), css);
  const result = inspectBrandTheme({ packet, packetPath });
  return { result, byTarget: new Map(result.context_theme.mappings.map((mapping) => [mapping.target, mapping])) };
}

const RED_CTA_ROOT = `
  --brand-primary: #dd4249;
  --brand-cta: #dd4249;
  --surface-bg: #ffffff;
  --text-primary: #111111;`;

test("brand theme uses the CTA foreground the source declares when it clears 3:1, and the luminance pick otherwise", () => {
  withTempDir((dir) => {
    const { result, byTarget } = inspectCtaSource(join(dir, "declared"), `:root {${RED_CTA_ROOT}\n  --text-inverse: #ffffff;\n}\n`);
    for (const target of ["--brand--color--text-inverse", "--brand--color--cta-foreground"]) {
      assert.equal(byTarget.get(target).value, "#ffffff", `${target} keeps the declared white label`);
      assert.equal(byTarget.get(target).derivation.method, "declared-cta-foreground");
      assert.equal(byTarget.get(target).derivation.contrast, 4.24);
    }
    assert.match(result.css, /--brand--color--text-inverse: #ffffff;/);
    // Under 4.5:1 it is still reported, now as a declared colour.
    assert.ok(result.warnings.some((warning) => warning.code === "theme.foreground.low_contrast" && /Declared CTA foreground #ffffff/.test(warning.message)));
    // Only CTA-paired foregrounds take the declared colour.
    assert.equal(byTarget.get("--brand--color--primary-foreground").derivation.method, "foreground-from-luminance");
  });
  withTempDir((dir) => {
    // A declared label under 3:1 on the CTA is not used.
    const { byTarget } = inspectCtaSource(join(dir, "unreadable"), `:root {${RED_CTA_ROOT}\n  --text-inverse: #f4b6b8;\n}\n`);
    assert.equal(byTarget.get("--brand--color--text-inverse").value, "#0a0a0a");
    assert.equal(byTarget.get("--brand--color--text-inverse").derivation.method, "foreground-from-luminance");
  });
  withTempDir((dir) => {
    // Nothing declared: the pre-#535 output, byte for byte.
    const { result } = inspectCtaSource(join(dir, "none"), `:root {${RED_CTA_ROOT}\n}\n`);
    assert.equal(result.css.split("\n").slice(6).join("\n"), [
      ":root {",
      "  --brand--color--accent: #dd4249;",
      "  --brand--color--accent-foreground: #0a0a0a;",
      "  --brand--color--background: #ffffff;",
      "  --brand--color--cta-foreground: #0a0a0a;",
      "  --brand--color--cta-primary: #dd4249;",
      "  --brand--color--foreground: #111111;",
      "  --brand--color--primary: #dd4249;",
      "  --brand--color--primary-dark: #b5363c;",
      "  --brand--color--primary-foreground: #0a0a0a;",
      "  --brand--color--primary-light: #e4686d;",
      "  --brand--color--primary-lighter: #fae5e6;",
      "  --brand--color--rating-star: #dd4249;",
      "  --brand--color--surface: #ffffff;",
      "  --brand--color--text-inverse: #0a0a0a;",
      "  --brand--color--text-primary: #111111;",
      "}",
      "",
    ].join("\n"));
  });
});

test("brand theme takes the darkest declared text token that passes AA on the body background for body text", () => {
  withTempDir((dir) => {
    const { byTarget } = inspectCtaSource(join(dir, "declared"), `:root {
  --brand-cta: #0b1f3a;
  --surface-bg: #ffffff;
  --text-primary: #6b6b6b;
  --text-body: #333333;
  --text-heading: #1a1a1a;
  --text-muted: #000000;
  --text-inverse: #000000;
  --text-shadow: #000000;
}
`);
    for (const target of ["--brand--color--text-primary", "--brand--color--foreground"]) {
      const mapping = byTarget.get(target);
      assert.equal(mapping.value, "#1a1a1a", `${target} takes the darkest declared text token`);
      assert.equal(mapping.source, "--text-heading");
      assert.equal(mapping.derivation.method, "darkest-declared-text-token");
      assert.equal(mapping.derivation.replaced_value, "#6b6b6b");
    }
  });
  withTempDir((dir) => {
    // No --text-primary in the source: the declared tokens still set body text.
    const { byTarget } = inspectCtaSource(join(dir, "no-primary"), `:root {\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n  --text-body: #333333;\n  --text-heading: #1a1a1a;\n}\n`);
    for (const target of ["--brand--color--text-primary", "--brand--color--foreground"]) {
      assert.equal(byTarget.get(target)?.value, "#1a1a1a", `${target} takes the darkest declared text token`);
      assert.equal(byTarget.get(target).source, "--text-heading");
      assert.equal(byTarget.get(target).derivation.replaced_value, null);
    }
  });
  withTempDir((dir) => {
    // Declared text tokens that all fail AA on the background leave the pick alone.
    const { byTarget } = inspectCtaSource(join(dir, "failing"), `:root {\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n  --text-primary: #9a9a9a;\n  --text-caption: #b0b0b0;\n}\n`);
    assert.equal(byTarget.get("--brand--color--text-primary").value, "#9a9a9a");
    assert.equal(byTarget.get("--brand--color--text-primary").source, "--text-primary");
  });
  withTempDir((dir) => {
    // No declared text token: body text still comes from the rule-inferred
    // colour, and the CSS is the pre-#535 output byte for byte.
    const { result, byTarget } = inspectCtaSource(join(dir, "none"), `:root {\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n}\np { color: #6b6b6b; }\n`);
    assert.equal(byTarget.get("--brand--color--text-primary").value, "#6b6b6b");
    assert.equal(byTarget.get("--brand--color--text-primary").derivation, null);
    assert.equal(result.css.split("\n").slice(6).join("\n"), [
      ":root {",
      "  --brand--color--accent: #0b1f3a;",
      "  --brand--color--accent-foreground: #ffffff;",
      "  --brand--color--background: #ffffff;",
      "  --brand--color--cta-foreground: #ffffff;",
      "  --brand--color--cta-primary: #0b1f3a;",
      "  --brand--color--foreground: #6b6b6b;",
      "  --brand--color--rating-star: #0b1f3a;",
      "  --brand--color--surface: #ffffff;",
      "  --brand--color--text-inverse: #ffffff;",
      "  --brand--color--text-primary: #6b6b6b;",
      "}",
      "",
    ].join("\n"));
  });
});

const themeBody = (result) => result.css.split("\n").slice(6).join("\n");

test("brand theme ignores commented-out declarations for body text and the CTA foreground", () => {
  withTempDir((dir) => {
    // Body text: a commented :root token and a commented rule colour.
    const plain = `:root {\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n}\np { color: #6b6b6b; }\n`;
    const commented = `/* p { color: #000000; } */\n:root {\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n  /* --text-heading:#000000; */\n}\np { color: #6b6b6b; }\n`;
    const { result: expected } = inspectCtaSource(join(dir, "plain"), plain);
    const { result, byTarget } = inspectCtaSource(join(dir, "commented"), commented);
    for (const target of ["--brand--color--text-primary", "--brand--color--foreground"]) {
      assert.equal(byTarget.get(target).value, "#6b6b6b", `${target} ignores commented colours`);
    }
    assert.equal(themeBody(result), themeBody(expected));
  });
  withTempDir((dir) => {
    // CTA foreground: a commented :root label and a commented CTA rule label.
    const { result: expected } = inspectCtaSource(join(dir, "plain"), `:root {${RED_CTA_ROOT}\n}\n`);
    const { result, byTarget } = inspectCtaSource(join(dir, "commented"), `/* .cta-button { color: #ffffff; } */\n:root {${RED_CTA_ROOT}\n  /* --text-inverse: #ffffff; */\n}\n`);
    assert.equal(byTarget.get("--brand--color--text-inverse").value, "#0a0a0a");
    assert.equal(byTarget.get("--brand--color--text-inverse").derivation.method, "foreground-from-luminance");
    assert.equal(themeBody(result), themeBody(expected));
  });
  withTempDir((dir) => {
    // Inline <style>: a commented-out :root block is not a token source.
    const { source, packet, packetPath } = makePacket(dir);
    writeFileSync(join(source, "landing.html"), `<style>\n/* :root { --text-inverse: #ffffff; --text-heading: #000000; } */\n:root {${RED_CTA_ROOT}\n}\n</style><main>Landing</main>`);
    const result = inspectBrandTheme({ packet, packetPath });
    const byTarget = new Map(result.context_theme.mappings.map((mapping) => [mapping.target, mapping]));
    assert.equal(result.context_theme.selected_source.source, "html_inline_root");
    assert.equal(byTarget.get("--brand--color--text-inverse").value, "#0a0a0a");
    assert.equal(byTarget.get("--brand--color--text-primary").value, "#111111");
  });
});

test("brand theme treats inverse and on-colour text tokens as labels, whatever the word order", () => {
  // Each name is declared black beside a mid-grey --text-primary. An inverse or
  // on-colour label must not become body text.
  const inverseNames = [
    "--text-inverse",
    "--inverse-text",
    "--text-color-inverse",
    "--inverse-text-color",
    "--color-text-inverse",
    "--foreground-inverse",
    "--on-primary-text",
    "--text-on-primary",
    "--text-on-dark",
    "--text-on-cta",
  ];
  withTempDir((dir) => {
    for (const name of inverseNames) {
      const { byTarget } = inspectCtaSource(join(dir, name.slice(2)), `:root {\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n  --text-primary: #6b6b6b;\n  ${name}: #000000;\n}\n`);
      assert.equal(byTarget.get("--brand--color--text-primary").value, "#6b6b6b", `${name} is not body text`);
    }
    // Text for light backgrounds is ordinary copy and stays a candidate.
    const { byTarget } = inspectCtaSource(join(dir, "on-light"), `:root {\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n  --text-primary: #6b6b6b;\n  --text-on-light: #000000;\n}\n`);
    assert.equal(byTarget.get("--brand--color--text-primary").value, "#000000");
  });
  withTempDir((dir) => {
    // The same names feed the declared CTA foreground.
    const { byTarget } = inspectCtaSource(dir, `:root {${RED_CTA_ROOT}\n  --text-color-inverse: #ffffff;\n}\n`);
    assert.equal(byTarget.get("--brand--color--text-inverse").value, "#ffffff");
    assert.equal(byTarget.get("--brand--color--text-inverse").derivation.method, "declared-cta-foreground");
  });
});

test("brand theme infers --text-inverse from the same inverse / on-colour names it treats as labels", () => {
  withTempDir((dir) => {
    // The inferred source tokens surface in the producer-defaults comparison.
    const inferred = (result) => result.context_theme.producer_defaults.present_core_tokens.includes("--text-inverse");
    const navy = `:root {\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n`;
    const { result } = inspectCtaSource(join(dir, "on-dark"), `${navy}  --text-on-dark: #ffffff;\n}\n`);
    assert.equal(inferred(result), true, "--text-on-dark is inverse text");
    assert.ok(result.context_theme.producer_defaults.matched_tokens.includes("--text-inverse"));
    // A border on the primary colour is not text.
    const { result: border } = inspectCtaSource(join(dir, "border"), `${navy}  --border-on-primary: #93c5fd;\n}\n`);
    assert.equal(inferred(border), false, "--border-on-primary is not text");
  });
});

test("brand theme pairs a CTA rule whose background shorthand carries a data: URL", () => {
  withTempDir((dir) => {
    // The `;` inside the URL does not end the declaration, so the rule is on
    // the CTA background and outranks the root label token.
    const { byTarget } = inspectCtaSource(dir, `:root {${RED_CTA_ROOT}\n  --text-on-primary: #fdf2f2;\n}\n.cta-button { background: url("data:image/svg+xml;base64,PHN2Zy8+") no-repeat right center #dd4249; color: #ffffff; }\n`);
    assert.equal(byTarget.get("--brand--color--cta-foreground").value, "#ffffff");
  });
});

test("brand theme does not trust button rules on the CTA background that disagree on the label", () => {
  withTempDir((dir) => {
    const { result: expected } = inspectCtaSource(join(dir, "plain"), `:root {${RED_CTA_ROOT}\n}\n`);
    const { result, byTarget } = inspectCtaSource(join(dir, "disagree"), `:root {${RED_CTA_ROOT}\n}\n.cta-button { background: var(--brand-cta); color: #ffffff; }\n.btn-primary { background: #dd4249; color: #f0f0f0; }\n`);
    assert.equal(byTarget.get("--brand--color--cta-foreground").value, "#0a0a0a");
    assert.equal(byTarget.get("--brand--color--cta-foreground").derivation.method, "foreground-from-luminance");
    assert.equal(themeBody(result), themeBody(expected));
    // Rules on the CTA background that agree still pair.
    const { byTarget: agree } = inspectCtaSource(join(dir, "agree"), `:root {${RED_CTA_ROOT}\n}\n.cta-button { background: var(--brand-cta); color: #ffffff; }\n.btn-primary { background: #dd4249; color: #ffffff; }\n`);
    assert.equal(agree.get("--brand--color--cta-foreground").value, "#ffffff");
  });
});

test("brand theme reads the declared CTA label only from button rules, preferring the one on the CTA background", () => {
  const blueRoot = `:root {\n  --brand-cta: #2563eb;\n  --surface-bg: #ffffff;\n  --text-primary: #111111;\n}\n`;
  withTempDir((dir) => {
    // .order-summary is not a button, so its dark colour is not the label.
    const { result, byTarget } = inspectCtaSource(join(dir, "probe"), `${blueRoot}.order-summary { color: #111827; }\n.btn-primary { color: #ffffff; }\n`);
    const cta = byTarget.get("--brand--color--cta-foreground");
    assert.equal(cta.value, "#ffffff");
    assert.equal(cta.derivation.method, "declared-cta-foreground");
    assert.equal(cta.derivation.contrast, 5.17);
    assert.equal(result.status, "ready");
  });
  withTempDir((dir) => {
    // Non-button rules and button rules that disagree declare nothing.
    const { result: expected } = inspectCtaSource(join(dir, "plain"), `:root {${RED_CTA_ROOT}\n}\n`);
    for (const [name, rules] of [
      ["summary", ".order-summary { color: #ffffff; }\n.cart-count { color: #ffffff; }\n"],
      ["disagree", ".btn { color: #ffffff; }\n.btn-primary { color: #f0f0f0; }\n"],
      ["state", ".btn:hover { color: #ffffff; }\n.btn .icon { color: #ffffff; }\n"],
    ]) {
      const { result, byTarget } = inspectCtaSource(join(dir, name), `:root {${RED_CTA_ROOT}\n}\n${rules}`);
      assert.equal(byTarget.get("--brand--color--cta-foreground").value, "#0a0a0a", name);
      assert.equal(themeBody(result), themeBody(expected), name);
    }
  });
  withTempDir((dir) => {
    // The rule that sets the CTA background outranks a root label token.
    const { byTarget } = inspectCtaSource(dir, `:root {${RED_CTA_ROOT}\n  --text-on-primary: #fdf2f2;\n}\n.cta-button { background: var(--brand-cta); color: #ffffff; }\n`);
    assert.equal(byTarget.get("--brand--color--cta-foreground").value, "#ffffff");
  });
});

test("brand theme judges a button rule on its selector's own parts, not on attribute values or pseudo-class arguments", () => {
  withTempDir((dir) => {
    const { result: expected } = inspectCtaSource(join(dir, "plain"), `:root {${RED_CTA_ROOT}\n}\n`);
    for (const [name, selector] of [
      ["attr-btn", `.order-summary[data-target=".btn-primary"]`],
      ["attr-button", `.cart-count[data-target=".button"]`],
      ["not-btn", ".order-summary:not(.btn)"],
      ["has-button", ".cart:has(.button)"],
    ]) {
      const { result, byTarget } = inspectCtaSource(join(dir, name), `:root {${RED_CTA_ROOT}\n}\n${selector} { color: #ffffff; }\n`);
      assert.equal(byTarget.get("--brand--color--cta-foreground").value, "#0a0a0a", selector);
      assert.equal(themeBody(result), themeBody(expected), selector);
    }
    // An attribute alone is not a button; only input/button carry [type=submit].
    for (const [name, selector] of [
      ["summary-submit", ".order-summary[type=submit]"],
      ["div-submit", `div[type="submit"]`],
      ["bare-submit", "[type=submit]"],
    ]) {
      const { byTarget } = inspectCtaSource(join(dir, name), `:root {${RED_CTA_ROOT}\n}\n${selector} { color: #ffffff; }\n`);
      for (const target of ["--brand--color--cta-foreground", "--brand--color--text-inverse"]) {
        assert.equal(byTarget.get(target).value, "#0a0a0a", `${selector} ${target}`);
        assert.equal(byTarget.get(target).derivation.method, "foreground-from-luminance", `${selector} ${target}`);
      }
    }
    for (const [name, selector] of [
      ["btn-attr", ".btn-primary[data-x]"],
      ["button-not", "button:not(.order-summary)"],
      ["input-submit", "input[type=submit]"],
      ["button-submit", "button[type=submit]"],
    ]) {
      const { byTarget } = inspectCtaSource(join(dir, name), `:root {${RED_CTA_ROOT}\n}\n${selector} { color: #ffffff; }\n`);
      const cta = byTarget.get("--brand--color--cta-foreground");
      assert.equal(cta.value, "#ffffff", selector);
      assert.equal(cta.derivation.method, "declared-cta-foreground", selector);
    }
  });
});

test("brand theme on-colour label tokens need a text or foreground part", () => {
  withTempDir((dir) => {
    const blue = `:root {\n  --brand-cta: #1d4ed8;\n  --surface-bg: #ffffff;\n  --text-primary: #111111;\n`;
    const { byTarget } = inspectCtaSource(join(dir, "border"), `${blue}  --border-on-primary: #93c5fd;\n  --text-on-primary: #ffffff;\n}\n`);
    assert.equal(byTarget.get("--brand--color--cta-foreground").value, "#ffffff");
    for (const name of ["--overlay-on-dark", "--border-on-primary"]) {
      const { byTarget: alone } = inspectCtaSource(join(dir, name.slice(2)), `${blue}  ${name}: #93c5fd;\n}\n`);
      assert.equal(alone.get("--brand--color--cta-foreground").derivation.method, "foreground-from-luminance", name);
      assert.equal(alone.get("--brand--color--cta-foreground").value, "#ffffff", name);
    }
    for (const name of ["--on-primary-text", "--foreground-on-dark"]) {
      const { byTarget: label } = inspectCtaSource(join(dir, name.slice(2)), `:root {${RED_CTA_ROOT}\n  ${name}: #ffffff;\n}\n`);
      assert.equal(label.get("--brand--color--cta-foreground").value, "#ffffff", name);
    }
  });
});

test("brand theme does not take body text from link or status colour tokens", () => {
  withTempDir((dir) => {
    for (const name of ["--text-link", "--text-error"]) {
      const { byTarget } = inspectCtaSource(join(dir, name.slice(2)), `:root {\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n  --text-primary: #4b5563;\n  ${name}: #1e3a8a;\n}\n`);
      assert.equal(byTarget.get("--brand--color--text-primary").value, "#4b5563", name);
      assert.equal(byTarget.get("--brand--color--text-primary").source, "--text-primary", name);
    }
  });
});

test("brand theme hashes an inline :root with a comment as earlier releases did, so an existing theme is not stale", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    const body = `\n  /* brand colours */\n  --brand-cta: #0b1f3a;\n  --surface-bg: #ffffff;\n  --text-primary: #111111;\n`;
    const htmlPath = join(source, "landing.html");
    writeFileSync(htmlPath, `<style>:root {${body}}</style><main>Landing</main>`);
    const result = inspectBrandTheme({ packet, packetPath });
    assert.equal(result.context_theme.selected_source.source, "html_inline_root");
    assert.equal(result.context_theme.selected_source.hash, createHash("sha256").update(`${htmlPath}:0:0:${body}`).digest("hex"));
  });
});

test("brand theme lowers confidence when source tokens match figma exporter defaults after normalization", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "assets/css"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<main>Landing</main>`);
    writeFileSync(join(source, "assets/css/tokens.css"), `
:root {
  --brand-primary: #0F75FF;
  --surface-bg: rgb(255, 255, 255);
  --text-primary: #020b1e;
}
`);

    const result = inspectBrandTheme({ packet, packetPath });

    assert.equal(result.confidence, "low");
    assert.equal(result.context_theme.producer_defaults.matched, true);
    assert.ok(result.warnings.some((warning) => warning.code === "theme.source_tokens.defaults"));
    assert.equal(result.context_theme.generated.can_generate, false);
  });
});

test("generated CSS safety rejects selectors and protected runtime surfaces", () => {
  const result = validateGeneratedCss(`
:root { --brand--color--primary: #123456; }
[data-next-package-id] { display: none; }
`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "theme.css.selector"));
});

test("theme generate writes artifacts and treats identical reruns as current", () => {
  withTempDir((dir) => {
    const { source, target, packet } = makePacket(dir);
    const packetPath = join(target, "campaign runtime.build.json");
    writeJson(packetPath, packet);
    mkdirSync(join(source, "assets/css"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<main>Landing</main>`);
    writeFileSync(join(source, "assets/css/tokens.css"), highConfidenceTokens());

    const inspection = inspectBrandTheme({ packet, packetPath });
    const first = writeThemeArtifacts(inspection, { writeCss: true, writeReport: true });
    assert.equal(first.ok, true);
    assert.equal(first.wrote.css, true);
    assert.equal(existsSync(join(target, ".campaign-runtime/theme/brand-theme.css")), true);
    assert.equal(existsSync(join(target, ".campaign-runtime/theme/theme-report.json")), true);

    const second = writeThemeArtifacts(inspection, { writeCss: true, writeReport: true });
    assert.equal(second.ok, true);
    assert.equal(second.wrote.css, false);
    assert.equal(second.already_current.css, true);
  });
});

test("theme artifact publication replaces report and CSS aliases without mutating their referents", async (t) => {
  for (const aliases of [
    { report: "hard link", css: "symlink" },
    { report: "symlink", css: "hard link" },
  ]) {
    await t.test(`report ${aliases.report}, CSS ${aliases.css}`, () => withTempDir((dir) => {
      const { source, target, packet, packetPath } = makePacket(dir);
      mkdirSync(join(source, "assets/css"), { recursive: true });
      writeFileSync(join(source, "landing.html"), `<main>Landing</main>`);
      writeFileSync(join(source, "assets/css/tokens.css"), highConfidenceTokens());
      const inspection = inspectBrandTheme({ packet, packetPath });
      const themeDir = join(target, ".campaign-runtime/theme");
      const reportPath = join(themeDir, "theme-report.json");
      const cssPath = join(themeDir, "brand-theme.css");
      const reportReferent = join(target, "protected-design-source-package.json");
      const cssReferent = join(target, "protected-output.css");
      const reportReferentBytes = Buffer.from('{"protected":"dsp"}\n');
      const cssReferentBytes = Buffer.from("/* protected output */\n");
      mkdirSync(themeDir, { recursive: true });
      writeFileSync(reportReferent, reportReferentBytes);
      writeFileSync(cssReferent, cssReferentBytes);
      if (aliases.report === "hard link") linkSync(reportReferent, reportPath);
      else symlinkSync(reportReferent, reportPath);
      if (aliases.css === "hard link") linkSync(cssReferent, cssPath);
      else symlinkSync(cssReferent, cssPath);

      const written = writeThemeArtifacts(inspection, {
        writeCss: true,
        writeReport: true,
        force: true,
      });

      assert.equal(written.ok, true);
      assert.deepEqual(written.wrote, { report: true, css: true });
      assert.ok(readFileSync(reportReferent).equals(reportReferentBytes));
      assert.ok(readFileSync(cssReferent).equals(cssReferentBytes));
      assert.equal(lstatSync(reportPath).isFile(), true);
      assert.equal(lstatSync(cssPath).isFile(), true);
      assert.notEqual(statSync(reportPath).ino, statSync(reportReferent).ino);
      assert.notEqual(statSync(cssPath).ino, statSync(cssReferent).ino);
      assert.equal(readFileSync(reportPath, "utf8"), `${JSON.stringify(inspection.report, null, 2)}\n`);
      assert.equal(readFileSync(cssPath, "utf8"), inspection.css);
      assert.deepEqual(readdirSync(themeDir).filter((name) => name.includes(".tmp")), []);
    }));
  }
});

test("theme artifact publication atomically replaces read-only regular targets", (t) => {
  withTempDir((dir) => {
    if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
      t.skip("portable chmod-based direct-write control is unavailable on this platform/user");
      return;
    }
    const { source, target, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "assets/css"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<main>Landing</main>`);
    writeFileSync(join(source, "assets/css/tokens.css"), highConfidenceTokens());
    const inspection = inspectBrandTheme({ packet, packetPath });
    const themeDir = join(target, ".campaign-runtime/theme");
    const reportPath = join(themeDir, "theme-report.json");
    const cssPath = join(themeDir, "brand-theme.css");
    const permissionProbe = join(themeDir, ".permission-probe");
    mkdirSync(themeDir, { recursive: true });
    writeFileSync(reportPath, "old report\n");
    writeFileSync(cssPath, "old css\n");
    writeFileSync(permissionProbe, "before\n");
    chmodSync(permissionProbe, 0o444);
    let permissionEnforced = false;
    try {
      writeFileSync(permissionProbe, "after\n");
    } catch (error) {
      if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) permissionEnforced = true;
      else throw error;
    } finally {
      chmodSync(permissionProbe, 0o600);
      rmSync(permissionProbe, { force: true });
    }
    if (!permissionEnforced) {
      t.skip("current platform/user demonstrably ignores existing-file permission bits");
      return;
    }
    chmodSync(reportPath, 0o444);
    chmodSync(cssPath, 0o444);

    let written;
    try {
      written = writeThemeArtifacts(inspection, {
        writeCss: true,
        writeReport: true,
        force: true,
      });
    } finally {
      chmodSync(reportPath, 0o600);
      chmodSync(cssPath, 0o600);
    }

    assert.equal(written.ok, true);
    assert.deepEqual(written.wrote, { report: true, css: true });
    assert.equal(readFileSync(reportPath, "utf8"), `${JSON.stringify(inspection.report, null, 2)}\n`);
    assert.equal(readFileSync(cssPath, "utf8"), inspection.css);
    assert.deepEqual(readdirSync(themeDir).filter((name) => name.includes(".tmp")), []);
  });
});

test("failed atomic theme replacement cleans its same-directory staging file", async (t) => {
  for (const targetKind of ["report", "css"]) {
    await t.test(targetKind, () => withTempDir((dir) => {
      const themeDir = join(dir, "theme");
      const reportPath = join(themeDir, "theme-report.json");
      const cssPath = join(themeDir, "brand-theme.css");
      mkdirSync(themeDir, { recursive: true });
      mkdirSync(targetKind === "report" ? reportPath : cssPath);
      const inspection = {
        errors: [],
        status: "ready",
        context_theme: { generated: { can_generate: true } },
        report: { schema_version: "campaign-runtime-brand-theme/v0" },
        css: ":root { --brand--color--primary: #123456; }\n",
        absolute_paths: {
          report_path: reportPath,
          css_path: cssPath,
        },
      };

      assert.throws(() => writeThemeArtifacts(inspection, {
        writeReport: targetKind === "report",
        writeCss: targetKind === "css",
        force: true,
      }));
      assert.deepEqual(readdirSync(themeDir).filter((name) => name.includes(".tmp")), []);
    }));
  }
});

test("theme generate refuses different existing CSS without force and prints a safe command", () => {
  withTempDir((dir) => {
    const { source, target, packet } = makePacket(dir);
    const packetPath = join(target, "campaign runtime.build.json");
    writeJson(packetPath, packet);
    mkdirSync(join(source, "assets/css"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<main>Landing</main>`);
    writeFileSync(join(source, "assets/css/tokens.css"), highConfidenceTokens());
    mkdirSync(join(target, ".campaign-runtime/theme"), { recursive: true });
    writeFileSync(join(target, ".campaign-runtime/theme/brand-theme.css"), ":root { --brand--color--primary: #000000; }\n");

    const inspection = inspectBrandTheme({ packet, packetPath, force: true });
    const result = writeThemeArtifacts(inspection, { writeCss: true, writeReport: true, packetPath });

    assert.equal(result.ok, false);
    const error = result.errors.find((issue) => issue.code === "theme.generate.exists");
    assert.ok(error);
    assert.deepEqual(error.detail.safe_commands, [`campaigns-os theme generate --packet '${packetPath}' --force`]);
    assert.match(error.message, /theme generate --packet '/);
  });
});

test("theme generate reports empty CSS before checking existing artifact overwrite", () => {
  withTempDir((dir) => {
    const { target, packetPath } = makePacket(dir);
    mkdirSync(join(target, ".campaign-runtime/theme"), { recursive: true });
    writeFileSync(join(target, ".campaign-runtime/theme/brand-theme.css"), ":root { --brand--color--primary: #000000; }\n");
    const inspection = {
      errors: [],
      status: "ready",
      context_theme: { generated: { can_generate: true } },
      report: { status: "ready" },
      css: "",
      absolute_paths: {
        report_path: join(target, ".campaign-runtime/theme/theme-report.json"),
        css_path: join(target, ".campaign-runtime/theme/brand-theme.css"),
      },
    };

    const result = writeThemeArtifacts(inspection, { writeCss: true, writeReport: true, packetPath });

    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.code === "theme.generate.empty"), true);
    assert.equal(result.errors.some((error) => error.code === "theme.generate.exists"), false);
  });
});

test("theme validators reject malformed context and applied report load order", () => {
  const contextResult = validateThemeContextBlock({
    status: "ready",
    policy: "auto",
    source_kind: "figma_sections",
    confidence: "high",
    generated: { css_path: "/tmp/brand-theme.css" },
  });
  assert.equal(contextResult.ok, false);
  assert.ok(contextResult.errors.some((error) => error.code === "context.theme.source_kind"));
  assert.ok(contextResult.errors.some((error) => error.code === "context.theme.generated.css_path"));

  const reportResult = validateAssemblyReportThemeBlock({
    status: "applied",
    css_path: "src/demo/assets/css/brand-theme.css",
    load_order: "unknown",
    commerce_pages: [],
    evidence: [],
    warnings: [],
    repair_loop_defect: null,
  });
  assert.equal(reportResult.ok, false);
  assert.ok(reportResult.errors.some((error) => error.code === "report.theme.load_order"));

  const looseBackCompatResult = validateAssemblyReportThemeBlock({
    status: "needs_review",
    css_path: null,
    load_order: "unknown",
    commerce_pages: [],
    evidence: [],
    warnings: [],
    repair_loop_defect: {},
  });
  assert.equal(looseBackCompatResult.ok, true);

  const malformedDefectResult = validateAssemblyReportThemeBlock({
    status: "needs_review",
    css_path: null,
    load_order: "unknown",
    commerce_pages: [],
    evidence: [],
    warnings: [],
    repair_loop_defect: "not-an-object",
  });
  assert.equal(malformedDefectResult.ok, false);
  assert.ok(malformedDefectResult.errors.some((error) => error.code === "report.theme.repair_loop_defect"));
});

test("prepare-build records inspect-only theme context and report without writing CSS by default", () => {
  withTempDir((dir) => {
    const source = join(dir, "source");
    const target = join(dir, "target");
    mkdirSync(join(source, "assets/css"), { recursive: true });
    mkdirSync(target, { recursive: true });
    writeJson(join(target, "package.json"), { dependencies: { "next-campaign-page-kit": "fixture" } });
    for (const page of ["landing", "checkout", "upsell", "receipt"]) {
      writeFileSync(join(source, `${page}.html`), page === "landing" ? `<link rel="stylesheet" href="assets/css/tokens.css">` : `<main>${page}</main>`);
    }
    writeFileSync(join(source, "assets/css/tokens.css"), highConfidenceTokens());
    const specPath = join(dir, "campaignspec.json");
    writeJson(specPath, readJson(resolve(root, "examples/campaignspec.v42.basic.json")));

    const output = execFileSync(process.execPath, [
      cli,
      "prepare-build",
      "--spec", specPath,
      "--source", source,
      "--target", target,
      "--template-family", "olympus",
      "--json",
    ], { cwd: root, encoding: "utf8" });
    const result = JSON.parse(output);

    assert.equal(result.context.theme.policy, "inspect_only");
    assert.equal(result.context.theme.confidence, "high");
    assert.equal(result.context.theme.wrote.report, true);
    assert.equal(result.context.theme.wrote.css, false);
    assert.equal(existsSync(join(target, ".campaign-runtime/theme/theme-report.json")), true);
    assert.equal(existsSync(join(target, ".campaign-runtime/theme/brand-theme.css")), false);
    assert.equal(result.report.theme.status, "needs_review");
  });
});

test("a theme write error copied onto the Assembly Report validates against themeIssue, with or without detail", async () => {
  // prepare-build copied each theme write error as { code, message, detail:
  // error.detail || null }; themeIssue.detail is an object, so a not_ready or
  // empty error made the report fail its own schema and record setup/build
  // refused it ("theme.warnings.0.detail must be object").
  const { themeIssueForReport } = await import("./brand-theme.mjs");
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../schemas/campaign-runtime-assembly-report.v0.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(schema, "report");
  const validIssue = ajv.compile({ $ref: "report#/$defs/themeIssue" });

  const bare = themeIssueForReport({ code: "theme.generate.not_ready", message: "not ready", detail: null });
  assert.deepEqual(bare, { code: "theme.generate.not_ready", message: "not ready" });
  assert.ok(validIssue(bare), JSON.stringify(validIssue.errors));
  const withDetail = themeIssueForReport({ code: "theme.generate.exists", message: "exists", detail: { safe_commands: ["x"] } });
  assert.deepEqual(withDetail.detail, { safe_commands: ["x"] });
  assert.ok(validIssue(withDetail), JSON.stringify(validIssue.errors));
  // The shape prepare-build used to write is the one the schema rejects.
  assert.equal(validIssue({ code: "theme.generate.not_ready", message: "not ready", detail: null }), false);
});
