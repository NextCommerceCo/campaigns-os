// #730 milestone 1: frozen literal vectors for commerce-signature/v1 and for
// classifyDrift, captured before the doctor shared-input refactor.
//
// Every expected value below is a literal: the facts string a page should
// produce and the "sha256:..." hash of that string, recomputed with node:crypto
// independently of src/change-scope.mjs. Nothing here derives an expected
// value from the implementation under test. These literals must never be
// regenerated: a recorded build's stages.assembly.commerce_signature carries
// exactly these bytes, and the #730 milestone 4 port of buildCommerceSignature
// and classifyDrift must reproduce them exactly. A failure here is a v1
// behavior change, not a stale fixture. src/change-scope.test.mjs pins
// sensitivity against derived baselines; this file pins the bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBuiltSiteScope } from "./built-site-scope.mjs";
import {
  COMMERCE_SIGNATURE_ALGORITHM,
  buildCommerceSignature,
  campaignConfigFingerprint,
  classifyDrift,
  pageCommerceFacts,
} from "./change-scope.mjs";

// The hash of an independently written facts string. Used only to check that
// each literal below is the sha256 of the facts string it claims to be.
const sha256 = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const EMPTY = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-change-scope-v1-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Asserts the literal is the hash of the facts string, then that the
// implementation produces it for every given HTML input.
function assertVector(id, { html, facts, signature }) {
  assert.equal(sha256(facts), signature, `${id}: the literal signature must be sha256 of the literal facts string (vector table typo)`);
  for (const input of Array.isArray(html) ? html : [html]) {
    assert.equal(pageCommerceFacts(input).signature, signature,
      `${id}: commerce-signature/v1 of ${JSON.stringify(input).slice(0, 160)} must hash the facts ${JSON.stringify(facts)}`);
  }
}

// The realistic upsell page from src/change-scope.test.mjs:27-30, copied
// byte for byte so a later edit there cannot move this vector.
const UPSELL = `<!doctype html><html><head><meta name="next-page-type" content="upsell"><meta name="next-upsell-accept-url" content="../receipt/">
<script src="https://cdn.example.test/campaign-cart@0.4.40/loader.js"></script><script>window.nextConfig = { debug: false };</script></head>
<body><h1 class="hero">Add a second bottle</h1><img src="bottle.png" alt="Bottle"><p style="color: red">Only today.</p>
<div data-next-package-id="12" data-next-shipping-id="3"><a href="../receipt/" data-next-upsell-action="skip">No thanks</a></div></body></html>`;

// The PAGES fixture from src/page-only-change.test.mjs:25-30, copied byte for byte.
const PAGES = Object.freeze({
  landing: `<!doctype html><html><head><meta name="next-page-type" content="product"></head><body><h1>Landing headline</h1><a href="../checkout/">Order now</a></body></html>\n`,
  checkout: `<!doctype html><html><head><meta name="next-page-type" content="checkout"></head><body><h1>Checkout</h1><form data-next-checkout="form"><button type="submit">Pay</button></form></body></html>\n`,
  upsell1: `<!doctype html><html><head><meta name="next-page-type" content="upsell"><meta name="next-upsell-accept-url" content="../receipt/"></head><body><h1>Add a second bottle</h1><div data-next-package-id="12"><button data-next-upsell-action="add">Yes</button></div></body></html>\n`,
  receipt: `<!doctype html><html><head><meta name="next-page-type" content="receipt"></head><body><h1>Thank you</h1></body></html>\n`,
});
const SLUG = "synthetic-campaign";
const CONFIG = { [SLUG]: { sdk_version: "0.4.40", store_name: "Synthetic Store" } };

// The signature record build keeps for PAGES + CONFIG, as literals.
const PAGES_SIGNATURE = Object.freeze({
  algorithm: "commerce-signature/v1",
  campaign_config: "sha256:b0c4fd62aa84f51e745b2b43e9688fa578a113b6cf18222f63c63af322600d49",
  pages: {
    "checkout/index.html": "sha256:57aaeba6491591513cbd132266db14d2215cf3d27180a458b5124c44a76dbf79",
    "landing/index.html": "sha256:941fda3743ee82c3c6e2b908ac82a3d444143fe05ea9847b00ac3e1e9f351b50",
    "receipt/index.html": "sha256:3cb949b0c73538f1d5cefe60d3ec4180b0d413d2cc88ed5658b7c15f8f9476ee",
    "upsell1/index.html": "sha256:390df23d8943c48da475d31191a362cd14c8b4099ee5a8a8ee0bddd3aa25ff98",
  },
});
const PAGES_FACTS = Object.freeze({
  "checkout/index.html": "meta[next-page-type]=checkout\nform[data-next-checkout]=form",
  "landing/index.html": "meta[next-page-type]=product\na[href]=../checkout/",
  "receipt/index.html": "meta[next-page-type]=receipt",
  "upsell1/index.html": "meta[next-page-type]=upsell\nmeta[next-upsell-accept-url]=../receipt/\ndiv[data-next-package-id]=12\nbutton[data-next-upsell-action]=add",
});

function findPackageJson(startFile, name) {
  for (let dir = dirname(startFile); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      if (pkg.name === name) return { dir, pkg };
    }
  }
  return null;
}

// Node module resolution for `name` as seen from `fromDir`.
function resolveDependencyPackage(fromDir, name) {
  for (let dir = fromDir; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8"));
  }
  return null;
}

test("the installed HTML parser is the one the v1 literals were captured with", () => {
  const parse5 = findPackageJson(fileURLToPath(import.meta.resolve("parse5")), "parse5");
  assert.ok(parse5, "setup: parse5's package.json resolves");
  const entities = resolveDependencyPackage(parse5.dir, "entities");
  assert.ok(entities, "setup: parse5's entities dependency resolves");
  const why = "commerce-signature/v1 hashes parse5's tree and entities' decoding; a parser upgrade can move recorded v1 hashes "
    + "(reading as commerce_markup_changed on a copy-only edit), so it must be reviewed against these vectors before this pin moves. "
    + "The published package pins and bundles both dependencies so consumer resolution preserves saved v1 records";
  assert.equal(parse5.pkg.version, "8.0.1", `parse5 ${parse5.pkg.version} is installed: ${why}`);
  assert.equal(entities.version, "8.1.0", `entities ${entities.version} is installed: ${why}`);
});

test("pageCommerceFacts v1: literal facts and hashes for each commerce-bearing surface", () => {
  assert.equal(COMMERCE_SIGNATURE_ALGORITHM, "commerce-signature/v1");
  assert.equal(sha256(""), EMPTY);
  const vectors = {
    "A1 empty and copy-only pages carry no facts": {
      html: ["", "<html><body><h1>Hi</h1><p>x</p></body></html>"],
      facts: "", signature: EMPTY,
    },
    "A2 attributes in source order": {
      html: '<div data-next-package-id="1" data-next-shipping-id="2"></div>',
      facts: "div[data-next-package-id]=1\ndiv[data-next-shipping-id]=2",
      signature: "sha256:727ea1f854065b8c7da0ed4fbac5e2aa724afe2ba9131d21c32fdec52c0f5b38",
    },
    "A3 attribute order is part of the hash": {
      html: '<div data-next-shipping-id="2" data-next-package-id="1"></div>',
      facts: "div[data-next-shipping-id]=2\ndiv[data-next-package-id]=1",
      signature: "sha256:db028eca3c281ffe24f2c76025a3989cbb839bd56665161f684b0a59bc4c70c8",
    },
    "A4 non-commerce attributes are ignored": {
      html: [
        '<div class="x" data-next-package-id="1" data-next-shipping-id="2"></div>',
        '<div id="a" data-product-id="7" data-sku="s" data-price="9" data-next-package-id="1" style="color:red" data-next-shipping-id="2"></div>',
      ],
      facts: "div[data-next-package-id]=1\ndiv[data-next-shipping-id]=2",
      signature: "sha256:727ea1f854065b8c7da0ed4fbac5e2aa724afe2ba9131d21c32fdec52c0f5b38",
    },
    "A5 a duplicate attribute keeps parse5's first value": {
      html: '<div data-next-package-id="1" data-next-package-id="9" data-next-shipping-id="2"></div>',
      facts: "div[data-next-package-id]=1\ndiv[data-next-shipping-id]=2",
      signature: "sha256:727ea1f854065b8c7da0ed4fbac5e2aa724afe2ba9131d21c32fdec52c0f5b38",
    },
    "A6 script references in document order": {
      html: '<script src="a.js"></script><script src="b.js"></script>',
      facts: "script[src]=a.js\nscript[src]=b.js",
      signature: "sha256:0eba61e34dd9acf1e3bd88f81371fe1ab5fceda40fae9649385ab46e59da14a5",
    },
    "A7 script order is part of the hash": {
      html: '<script src="b.js"></script><script src="a.js"></script>',
      facts: "script[src]=b.js\nscript[src]=a.js",
      signature: "sha256:c7a5976ef652002f4a3f059f3ccb312ebde6885d8cfc7d2cda7bfc84e2579f07",
    },
    "A8 an inline script is the sha256 of its body, nested in the fact": {
      html: "<script>var a=1;</script>",
      facts: "script=sha256:81a68c14d1d9c91b5af330765479162cc3f8b4cc49f9df2fddd4d6ee7c36afa3",
      signature: "sha256:f2eb96d00701257303e07fee87974518e3015e8f59b0d8dee42a96a655ed61f4",
    },
    "A9 the inline body is hashed raw, without trimming": {
      html: "<script>var a=1; </script>",
      facts: "script=sha256:5c8733e5c8e895c74f7ae7b0cbb7b91f14f6b08fd5751fea247a37404f52e3ae",
      signature: "sha256:7022f845238a7bf3338adfe81527fdce525ee384e112103794d379d38dcba936",
    },
    "A10 src wins over an inline body": {
      html: '<script src="a.js">ignored</script>',
      facts: "script[src]=a.js",
      signature: "sha256:e1b9f9b799ddb34d492adb141624084f6f44b1fcbe408d20a44b35805e2f70b4",
    },
    "A11 template contents are walked": {
      html: '<template id="t"><div data-next-package-id="5"></div></template>',
      facts: "div[data-next-package-id]=5",
      signature: "sha256:16e62d7207aedfe343499d3f2c3ccc86faa33905a9d3447182f0dd8231f3e83a",
    },
    "A12 a package ref change inside a template changes the hash": {
      html: '<template id="t"><div data-next-package-id="6"></div></template>',
      facts: "div[data-next-package-id]=6",
      signature: "sha256:f2f6f5502c72c6fd57a3bdbed34db682fa45fd5d38b17ed208640162dcaf7b92",
    },
    "A13 a copy-only change inside a template keeps the hash": {
      html: '<template id="t"><div data-next-package-id="5">Buy two, <b>save more</b></div></template>',
      facts: "div[data-next-package-id]=5",
      signature: "sha256:16e62d7207aedfe343499d3f2c3ccc86faa33905a9d3447182f0dd8231f3e83a",
    },
    "A14 duplicate next-* meta tags are all kept, in order": {
      html: '<meta name="next-campaign-id" content="A"><meta name="next-campaign-id" content="B">',
      facts: "meta[next-campaign-id]=A\nmeta[next-campaign-id]=B",
      signature: "sha256:ad0bd04ac02967bddc04d6acf47939434d804cbc663c6392dac836c7d9eee353",
    },
    "A15 one next-* meta tag": {
      html: '<meta name="next-campaign-id" content="A">',
      facts: "meta[next-campaign-id]=A",
      signature: "sha256:bed6e697a449d1d0cd20b57702649c15603b6569c749b98ead13f35bd7de8775",
    },
    "A16 the meta name is trimmed and lowercased": {
      html: '<meta name="  NEXT-Campaign-Id " content="A">',
      facts: "meta[next-campaign-id]=A",
      signature: "sha256:bed6e697a449d1d0cd20b57702649c15603b6569c749b98ead13f35bd7de8775",
    },
    "A17 the meta content is raw, not trimmed": {
      html: '<meta name="next-campaign-id" content=" A">',
      facts: "meta[next-campaign-id]= A",
      signature: "sha256:594a3e470b69269919c6c5407c24e55b868ed22338d4683fc3d269be4c6d1c1a",
    },
    "A18 a link target is its entity-decoded value": {
      html: ['<a href="/x?a=1&amp;b=2">Go</a>', '<a href="/x?a=1&b=2">Go</a>'],
      facts: "a[href]=/x?a=1&b=2",
      signature: "sha256:3d87b3b908c46bf853733caea7be2a411f1f03c2467461c843f5dd9fce68afa2",
    },
    "A19 a form action": {
      html: '<form action="/pay" method="post"></form>',
      facts: "form[action]=/pay",
      signature: "sha256:6b4d9bd8429c4f008f018175795bacb6f7be2441922d2efb8acc12955f1ec0e9",
    },
    "A20 link, iframe, img, base, formaction, comments and noscript are not hashed": {
      html: [
        '<link rel="stylesheet" href="a.css">',
        '<iframe src="https://pay.example.test/frame"></iframe>',
        '<img src="bottle.png" alt="">',
        '<base href="/campaign/">',
        '<form><button formaction="/pay">Pay</button></form>',
        '<!-- <div data-next-package-id="1"></div> -->',
        '<noscript><a href="/no-js">Order</a><div data-next-package-id="1"></div></noscript>',
        '<style>.x{color:red}</style>',
      ],
      facts: "", signature: EMPTY,
    },
    "A21 the tag name is part of the fact": {
      html: '<section data-next-package-id="1"></section>',
      facts: "section[data-next-package-id]=1",
      signature: "sha256:a05d47e98128a7dc6c1cafbc60fd5f89a1a87cb20ab0aac17661f70c4a7bb38b",
    },
    "A21b the div form, with the attribute name lowercased by the parser": {
      html: ['<div data-next-package-id="1"></div>', '<DIV DATA-NEXT-PACKAGE-ID="1"></DIV>'],
      facts: "div[data-next-package-id]=1",
      signature: "sha256:561dc649d788e51d92f008ecbb2b203fb6d142af922f4116ac3e40b8b575ca96",
    },
    "A22 a template-id attribute": {
      html: '<div data-template-id="1"></div>',
      facts: "div[data-template-id]=1",
      signature: "sha256:82a01ea8e49799ff5a024a3082aa7977f05ea8976d78b4bfadf0f90624d3f524",
    },
    "A23 a checkout marker is a fact": {
      html: '<div data-next-checkout="form"></div>',
      facts: "div[data-next-checkout]=form",
      signature: "sha256:7637f5745129c706f69d9b1eedd2bad8bafdd50fe866787c3a643feeaa1a739b",
    },
    "A24 the realistic upsell page": {
      html: UPSELL,
      facts: [
        "meta[next-page-type]=upsell",
        "meta[next-upsell-accept-url]=../receipt/",
        "script[src]=https://cdn.example.test/campaign-cart@0.4.40/loader.js",
        "script=sha256:6c6bc631c3700704a2fe2fdfa9db71e250659a59a142f756687c58aaada539d9",
        "div[data-next-package-id]=12",
        "div[data-next-shipping-id]=3",
        "a[data-next-upsell-action]=skip",
        "a[href]=../receipt/",
      ].join("\n"),
      signature: "sha256:71a99275ca58c07133b30c079814b781d69fbb093a56664b91c3a1f9831043ed",
    },
    "A25 an SVG xlink:href reads as a[href]": {
      html: '<svg><a xlink:href="/x"><text>Go</text></a></svg>',
      facts: "a[href]=/x",
      signature: "sha256:0f904d49e43aa8f7bac739cc368ad68dc6e209f0e6001229129553485ef77770",
    },
    "A26 an inline event handler is a fact": {
      html: '<button onclick="next.add(1)">Add</button>',
      facts: "button[onclick]=next.add(1)",
      signature: "sha256:b80e2fa10c0338b6c5950d38698490b3b3014c58da9e75ee333ec0e8276db14c",
    },
    "A27 any on* handler is a fact, not only onclick": {
      html: '<button onmouseover="go()">Add</button>',
      facts: "button[onmouseover]=go()",
      signature: "sha256:aa1b1f6184b28c97d8ac0dbee88e03c3423f23d7a46685c2d20c1ac10847edf2",
    },
    "A28 an os-checkout-* binding is a fact": {
      html: '<div os-checkout-form="main"></div>',
      facts: "div[os-checkout-form]=main",
      signature: "sha256:b5981eec531ddea5050ab4d301fdee530f8c100d922a954fb27210cd5c7e6156",
    },
    "A29 data-* names carrying offer, voucher, coupon, package, shipping or upsell without the next- prefix": {
      html: '<div data-offer-id="3" data-bundle-voucher="V" data-coupon-code="C" data-package="P" data-shipping-method="S" data-upsell-step="U"></div>',
      facts: [
        "div[data-offer-id]=3",
        "div[data-bundle-voucher]=V",
        "div[data-coupon-code]=C",
        "div[data-package]=P",
        "div[data-shipping-method]=S",
        "div[data-upsell-step]=U",
      ].join("\n"),
      signature: "sha256:f9544d8a47a5d4b4ed048939db34f584cdbefe7c68dd118122c4bc0525160d31",
    },
    "A30 a data-* name that merely contains a commerce word matches": {
      html: '<div data-offering="x"></div>',
      facts: "div[data-offering]=x",
      signature: "sha256:53ca7e8752a5267ff713cb12c3f73194ec64285f0d814f31fd399d46737f7419",
    },
    "A31 near-miss names are not commerce attributes": {
      html: [
        '<div data-next="1"></div>',
        '<div on="x"></div>',
        '<div onclick2="y"></div>',
        '<div data-template="t"></div>',
        '<div os-checkoutx="z"></div>',
        "<a>no target</a>",
        "<form></form>",
        '<meta name="next">',
      ],
      facts: "", signature: EMPTY,
    },
    "A32 an empty script src is a fact with an empty value": {
      html: '<script src=""></script>',
      facts: "script[src]=",
      signature: "sha256:edf18447f9e7eb5ac94f80bdfbe04c1899f5564062a10b377b451865d13bbf7a",
    },
    "A33 an empty link target is a fact with an empty value": {
      html: '<a href="">x</a>',
      facts: "a[href]=",
      signature: "sha256:f8dfcc86dee7c43a35817b9130a31dffb36580759261b059740d04cdfe27bfc4",
    },
    "A34 an empty form action is a fact with an empty value": {
      html: '<form action=""></form>',
      facts: "form[action]=",
      signature: "sha256:501f95f38f5275a74799b611108e8d1d36526d7cd7ea569910c994391e25bb66",
    },
    "A35 a next-* meta without content is a fact with an empty value": {
      html: '<meta name="next-x">',
      facts: "meta[next-x]=",
      signature: "sha256:739c355ad286c64bbfced227af755f8f17a0409b36f9080ec4c2e1eb595e915c",
    },
    "A36 a camelCase SVG tag name is lowercased": {
      html: '<svg><foreignObject data-next-package-id="1"></foreignObject></svg>',
      facts: "foreignobject[data-next-package-id]=1",
      signature: "sha256:f20c8ba1b48dc627dbd25427df45cac982f79c1eb179dda4d9c83f03c1cef014",
    },
    // The lower bound only: a page nested 1,000 deep still hashes. A bounded
    // parser (cart-placeholders' MAX_ELEMENT_DEPTH = 512) would omit it.
    "A37 a commerce attribute 1,000 elements deep is still hashed": {
      html: `${"<div>".repeat(1000)}<div data-next-package-id="1"></div>${"</div>".repeat(1000)}`,
      facts: "div[data-next-package-id]=1",
      signature: "sha256:561dc649d788e51d92f008ecbb2b203fb6d142af922f4116ac3e40b8b575ca96",
    },
  };
  for (const [id, vector] of Object.entries(vectors)) assertVector(id, vector);
  // The nested inline-body hashes are themselves literal sha256 values.
  assert.equal(sha256("var a=1;"), "sha256:81a68c14d1d9c91b5af330765479162cc3f8b4cc49f9df2fddd4d6ee7c36afa3");
  assert.equal(sha256("var a=1; "), "sha256:5c8733e5c8e895c74f7ae7b0cbb7b91f14f6b08fd5751fea247a37404f52e3ae");
  assert.equal(sha256("window.nextConfig = { debug: false };"), "sha256:6c6bc631c3700704a2fe2fdfa9db71e250659a59a142f756687c58aaada539d9");
});

test("pageCommerceFacts v1: page_type and checkout are read but never hashed", () => {
  assert.deepEqual(pageCommerceFacts(UPSELL), {
    signature: "sha256:71a99275ca58c07133b30c079814b781d69fbb093a56664b91c3a1f9831043ed", page_type: "upsell", checkout: false,
  });
  assert.deepEqual(pageCommerceFacts('<div data-next-checkout="form"></div>'), {
    signature: "sha256:7637f5745129c706f69d9b1eedd2bad8bafdd50fe866787c3a643feeaa1a739b", page_type: null, checkout: true,
  });
  assert.deepEqual(pageCommerceFacts('<meta name="next-page-type" content=" Checkout ">'), {
    signature: "sha256:c15ac059468d0907c7c936babf6565d8c196b7100a771dea649a05e485dc354e", page_type: "checkout", checkout: false,
  }, "page_type is trimmed and lowercased while the fact keeps the raw content");
  assert.equal(sha256("meta[next-page-type]= Checkout "), "sha256:c15ac059468d0907c7c936babf6565d8c196b7100a771dea649a05e485dc354e");
  assert.deepEqual(pageCommerceFacts('<meta name="next-page-type" content="  ">'), {
    signature: "sha256:35ac9dc67d30cb91b22c5b7c33d3a2b1e130323dcd4bd6122951807107a079b3", page_type: null, checkout: false,
  }, "a blank page type reads as null while the fact keeps the raw content");
  assert.equal(sha256("meta[next-page-type]=  "), "sha256:35ac9dc67d30cb91b22c5b7c33d3a2b1e130323dcd4bd6122951807107a079b3");
  assert.deepEqual(pageCommerceFacts('<meta name="next-page-type" content="checkout_step">'), {
    signature: "sha256:2cb9d1a82c676d296e56ecb7ab01f6c002b50c5fed996ac00ca455b66a929ef8", page_type: "checkout_step", checkout: false,
  });
  assert.equal(sha256("meta[next-page-type]=checkout_step"), "sha256:2cb9d1a82c676d296e56ecb7ab01f6c002b50c5fed996ac00ca455b66a929ef8");

  // Every CHECKOUT_ATTRIBUTE branch sets checkout: true, and is also a hashed fact.
  for (const [html, facts, signature, checkout] of [
    ['<div data-next-payment-method="card"></div>', "div[data-next-payment-method]=card", "sha256:38975b49b777338ee75c9ffb3f6364a5a47d552d00ed3c228ecd82d62726c29b", true],
    ['<div data-next-express-checkout="paypal"></div>', "div[data-next-express-checkout]=paypal", "sha256:588cfbf9463b32727e56cb311cabad0a7c478eae230219d7ef1a012cc8e4dc14", true],
    ['<div os-checkout="1"></div>', "div[os-checkout]=1", "sha256:d463e16e73048ed1ced95588e76570ea0203d68ec2b8f38b2c3da93b6852aec5", true],
    ['<div os-checkout-form="main"></div>', "div[os-checkout-form]=main", "sha256:b5981eec531ddea5050ab4d301fdee530f8c100d922a954fb27210cd5c7e6156", true],
    // A data-next-* name is always a fact, but only checkout|payment|express-checkout followed by "-" or the end is a checkout marker.
    ['<div data-next-checkoutx="1"></div>', "div[data-next-checkoutx]=1", "sha256:61ef642ff5e46dfeeea11fc578d9e69660a839c863b59dbfc9c46d8ed1d8e6d2", false],
  ]) {
    assert.equal(sha256(facts), signature, `${html}: the literal signature must be sha256 of the literal facts string`);
    assert.deepEqual(pageCommerceFacts(html), { signature, page_type: null, checkout }, `${html} reads checkout: ${checkout}`);
  }
});

test("pageCommerceFacts v1: line endings, a BOM and attribute quoting do not move the hash", () => {
  const lf = '<!doctype html>\n<html><head>\n<meta name="next-page-type" content="upsell">\n<script>\nvar a=1;\nvar b=2;\n</script>\n</head><body>\n<div data-next-package-id="12" data-next-shipping-id="3"></div>\n</body></html>\n';
  const facts = [
    "meta[next-page-type]=upsell",
    "script=sha256:367649efc3c846a490787bf227d7ffd0094e2d2724d18e76951958cee7f9670f",
    "div[data-next-package-id]=12",
    "div[data-next-shipping-id]=3",
  ].join("\n");
  const literal = "sha256:67bec4903125ec5cf13798bb05390d82cc703bc2a4bcd9cc7f2458a1fbe9770b";
  assert.equal(sha256("\nvar a=1;\nvar b=2;\n"), "sha256:367649efc3c846a490787bf227d7ffd0094e2d2724d18e76951958cee7f9670f");
  assertVector("CRLF/BOM/quoting invariance", {
    html: [
      lf,
      lf.replace(/\n/g, "\r\n"),
      `﻿${lf}`,
      lf.replace('content="upsell"', "content='upsell'").replace('data-next-package-id="12"', "data-next-package-id=12").replace('data-next-shipping-id="3"', "data-next-shipping-id='3'"),
    ],
    facts, signature: literal,
  });
});

test("campaignConfigFingerprint v1: literal hashes of the canonical entry, and every unavailable status", () => withTempDir((dir) => {
  let n = 0;
  const repoWith = (text) => {
    const repo = join(dir, `repo-${n += 1}`);
    mkdirSync(join(repo, "_data"), { recursive: true });
    if (text !== null) writeFileSync(join(repo, "_data", "campaigns.json"), text);
    return repo;
  };
  const fingerprint = (text, slug = "m") => campaignConfigFingerprint(repoWith(text), slug);
  const SIMPLE = "sha256:a5e536266ccf8fc2357d64dba2d336bcf6a21f7fefe476d0d23c1f5b0af05fa5";
  assert.equal(sha256('{"sdk_version":"0.4.40","store_name":"S"}'), SIMPLE);
  for (const [label, text, slug] of [
    ["sorted keys", '{"m":{"sdk_version":"0.4.40","store_name":"S"}}', "m"],
    ["reordered keys", '{"m":{"store_name":"S","sdk_version":"0.4.40"}}', "m"],
    ["whitespace", '{\n  "m" : {\n    "store_name" : "S",\n    "sdk_version" : "0.4.40"\n  }\n}\n', "m"],
    ["another campaign's entry", '{"other":{"sdk_version":"9"},"m":{"sdk_version":"0.4.40","store_name":"S"}}', "m"],
    ["slug normalization", '{"m":{"sdk_version":"0.4.40","store_name":"S"}}', " /m/ "],
  ]) assert.equal(fingerprint(text, slug), SIMPLE, `${label} keeps the config fingerprint`);

  const NESTED = "sha256:10fc20711f44976239c10caf3b82369ea837462131d93769f12c1d396b11b819";
  assert.equal(sha256('{"a":{"y":[2,1],"z":1}}'), NESTED);
  assert.equal(fingerprint('{"m":{"a":{"z":1,"y":[2,1]}}}'), NESTED, "nested keys are sorted");
  assert.equal(fingerprint('{"m":{"a":{"y":[2,1],"z":1}}}'), NESTED);
  const NESTED_REORDERED_ARRAY = "sha256:4589f67174efe808be5e5310f06ed4707c7317efed596165f4d73233d7775dfb";
  assert.equal(sha256('{"a":{"y":[1,2],"z":1}}'), NESTED_REORDERED_ARRAY);
  assert.equal(fingerprint('{"m":{"a":{"z":1,"y":[1,2]}}}'), NESTED_REORDERED_ARRAY, "array order is kept");

  const N1 = "sha256:2bfd14f43d17fc7cea24e0917a8879b4b2f880b8baeec1b9d90fbaad655e71bd";
  assert.equal(sha256('{"n":1}'), N1);
  for (const number of ["1", "1.0", "1e0"]) assert.equal(fingerprint(`{"m":{"n":${number}}}`), N1, `${number} canonicalizes through JSON`);
  const N2 = "sha256:363379742f80b51bdb9206579af7754911543079b9399cb3fc315fb199f476e8";
  assert.equal(sha256('{"n":2}'), N2);
  assert.equal(fingerprint('{"m":{"n":1,"n":2}}'), N2, "a duplicate key keeps the last value");
  assert.equal(fingerprint('{"m":{"n":2}}'), N2);

  assert.equal(fingerprint('{"other":{}}'), "unavailable:entry_missing");
  assert.equal(fingerprint('{"M":{"n":1}}'), "unavailable:entry_missing", "slug lookup is case-sensitive");
  assert.equal(fingerprint("{"), "unavailable:invalid_json");
  assert.equal(fingerprint("[]"), "unavailable:root_not_object");
  assert.equal(fingerprint("null"), "unavailable:root_not_object");
  assert.equal(fingerprint('{"m":[]}'), "unavailable:entry_not_object");
  assert.equal(fingerprint('{"m":null}'), "unavailable:entry_not_object");
  assert.equal(fingerprint(null), "unavailable:file_missing");
  assert.equal(campaignConfigFingerprint(join(dir, "does-not-exist"), "m"), "unavailable:target_repo_missing");
  writeFileSync(join(dir, "plain-file"), "x");
  assert.equal(campaignConfigFingerprint(join(dir, "plain-file"), "m"), "unavailable:target_repo_missing");
  assert.equal(campaignConfigFingerprint("", "m"), "unavailable:target_repo_missing");
}));

// A target repo holding PAGES under _site/<slug>/ and CONFIG in _data.
function writePagesRepo(dir) {
  const outputRoot = join(dir, "_site", SLUG);
  for (const [page, html] of Object.entries(PAGES)) {
    mkdirSync(join(outputRoot, page), { recursive: true });
    writeFileSync(join(outputRoot, page, "index.html"), html);
  }
  mkdirSync(join(dir, "_data"), { recursive: true });
  writeFileSync(join(dir, "_data", "campaigns.json"), JSON.stringify(CONFIG));
  return outputRoot;
}

test("buildCommerceSignature v1: the page-only-change fixture's literal signature", () => withTempDir((dir) => {
  const outputRoot = writePagesRepo(dir);
  for (const [path, facts] of Object.entries(PAGES_FACTS)) {
    assert.equal(sha256(facts), PAGES_SIGNATURE.pages[path], `${path}: literal is the sha256 of its literal facts`);
  }
  assert.equal(sha256(JSON.stringify(CONFIG[SLUG])), PAGES_SIGNATURE.campaign_config, "config literal is the sha256 of the canonical entry");
  const scope = resolveBuiltSiteScope(outputRoot);
  assert.equal(scope.ok, true, "setup: the built-site scope resolves");
  const signature = buildCommerceSignature({ scope, outputRoot, targetRepo: dir, publicRouteSlug: SLUG });
  assert.deepEqual(signature, PAGES_SIGNATURE, "record build's commerce_signature for PAGES must equal the literal v1 object");
  assert.deepEqual(Object.keys(signature), ["algorithm", "campaign_config", "pages"], "persisted key order");
  assert.deepEqual(Object.keys(signature.pages), ["checkout/index.html", "landing/index.html", "receipt/index.html", "upsell1/index.html"],
    "page keys follow the sorted scope order, which sets the persisted JSON bytes");

  assert.equal(buildCommerceSignature({ scope: { ok: false, pages: [] }, outputRoot, targetRepo: dir, publicRouteSlug: SLUG }), null, "an unresolved scope has no signature");
  assert.equal(buildCommerceSignature({ scope: null, outputRoot, targetRepo: dir, publicRouteSlug: SLUG }), null);

  // A hand-built scope: a page that cannot be read is left out, silently,
  // while a page nested 1,000 elements deep is kept (vector A37).
  mkdirSync(join(outputRoot, "deep"), { recursive: true });
  writeFileSync(join(outputRoot, "deep", "index.html"), `${"<div>".repeat(1000)}<div data-next-package-id="1"></div>${"</div>".repeat(1000)}`);
  const handScope = { ok: true, pages: [
    { built_path: join(outputRoot, "landing", "index.html") },
    { built_path: join(outputRoot, "gone", "index.html") },
    { built_path: join(outputRoot, "receipt") },
    { built_path: join(outputRoot, "deep", "index.html") },
  ] };
  assert.deepEqual(buildCommerceSignature({ scope: handScope, outputRoot, targetRepo: dir, publicRouteSlug: SLUG }), {
    algorithm: "commerce-signature/v1",
    campaign_config: "sha256:b0c4fd62aa84f51e745b2b43e9688fa578a113b6cf18222f63c63af322600d49",
    pages: {
      "landing/index.html": "sha256:941fda3743ee82c3c6e2b908ac82a3d444143fe05ea9847b00ac3e1e9f351b50",
      "deep/index.html": "sha256:561dc649d788e51d92f008ecbb2b203fb6d142af922f4116ac3e40b8b575ca96",
    },
  }, "a missing file and a directory are omitted from pages; a deeply nested page is not");
  // The config fingerprint follows the target repo, not the scope.
  assert.deepEqual(buildCommerceSignature({ scope: { ok: true, pages: [] }, outputRoot, targetRepo: join(dir, "nowhere"), publicRouteSlug: SLUG }), {
    algorithm: "commerce-signature/v1", campaign_config: "unavailable:target_repo_missing", pages: {},
  });
}));

test("classifyDrift v1: every branch against a literal recorded baseline", () => withTempDir((dir) => {
  const outputRoot = writePagesRepo(dir);
  const baseline = (overrides = {}) => ({ commerce_signature: { ...structuredClone(PAGES_SIGNATURE), ...overrides } });
  const page = (id) => ({ page_id: id, built_path: `${id}/index.html` });
  const known = (overrides = {}) => ({ status: "known", changed_pages: [], unmapped_files: [], extra: [], missing: [], ...overrides });
  const classify = (changes, assembly = baseline()) => classifyDrift({ changes, baseline: assembly, outputRoot, targetRepo: dir, publicRouteSlug: SLUG });
  const write = (id, html) => {
    mkdirSync(join(outputRoot, id), { recursive: true });
    writeFileSync(join(outputRoot, id, "index.html"), html);
  };

  assert.deepEqual(classify({ status: "unknown" }), { kind: "unknown", reasons: [] }, "an unknown change list is unknown");
  assert.deepEqual(classify({ status: "unknown" }, {}), { kind: "unknown", reasons: [] }, "no baseline does not change an unknown change list");
  assert.deepEqual(classify(known()), { kind: "none", reasons: [] }, "an unchanged build is none");
  assert.deepEqual(classify(known(), baseline({ campaign_config: "sha256:x" })), { kind: "none", reasons: [] },
    "a config change with no output change is never read: v1 returns none before the config");
  assert.deepEqual(classify(known(), {}), { kind: "none", reasons: [] }, "no output change is none even without a signature");

  // The bytes on disk equal the baseline, so a listed page reads page-only.
  assert.deepEqual(classify(known({ changed_pages: [page("landing")] })), { kind: "page_only", reasons: [] });
  write("landing", PAGES.landing.replace("Landing headline", "A new headline"));
  assert.deepEqual(classify(known({ changed_pages: [page("landing")] })), { kind: "page_only", reasons: [] }, "a copy-only landing edit is page-only");

  assert.deepEqual(classify(known({ unmapped_files: ["assets/site.css"] })),
    { kind: "commerce_affecting", reasons: [{ code: "unmapped_file", path: "assets/site.css" }] }, "a CSS-only asset is an unmapped file in v1");

  write("checkout", PAGES.checkout.replace("<h1>Checkout</h1>", "<h1>Secure checkout</h1>"));
  assert.deepEqual(classify(known({ changed_pages: [page("checkout")] })),
    { kind: "commerce_affecting", reasons: [{ code: "checkout_page", path: "checkout/index.html" }] }, "a copy-only checkout edit is commerce");
  write("select", "<!doctype html><html><body><h1>Choose your bundle</h1></body></html>\n");
  assert.deepEqual(classify(known({ changed_pages: [page("select")] })),
    { kind: "commerce_affecting", reasons: [{ code: "checkout_page", path: "select/index.html" }] }, "the select route infers a checkout page type with no meta");
  write("story", '<!doctype html><html><body><form data-next-checkout="form"><button>Pay</button></form></body></html>\n');
  assert.deepEqual(classify(known({ changed_pages: [page("story")] })),
    { kind: "commerce_affecting", reasons: [{ code: "checkout_page", path: "story/index.html" }] }, "checkout markup on a free-form route is a checkout page");
  // Every other checkout signal on a free-form route ("chapter-N" infers the
  // generic page type), with copy only around it.
  for (const [id, marker] of [
    ["chapter-1", '<meta name="next-page-type" content="checkout_step">'],
    ["chapter-2", '<div data-next-payment-method="card"></div>'],
    ["chapter-3", '<div data-next-express-checkout="paypal"></div>'],
    ["chapter-4", '<div os-checkout-payment="combo"></div>'],
    ["chapter-5", '<div os-checkout="1"></div>'],
  ]) {
    write(id, `<!doctype html><html><head></head><body>${marker}<h1>Step</h1></body></html>\n`);
    assert.deepEqual(classify(known({ changed_pages: [page(id)] })),
      { kind: "commerce_affecting", reasons: [{ code: "checkout_page", path: `${id}/index.html` }] }, `${marker} on a free-form route is a checkout page`);
  }

  // Precedence: a checkout page reads checkout_page alone, even when its hash moved.
  write("checkout", PAGES.checkout.replace("<h1>Checkout</h1>", '<h1>Checkout</h1><div data-next-package-id="7"></div>'));
  assert.deepEqual(classify(known({ changed_pages: [page("checkout")] })),
    { kind: "commerce_affecting", reasons: [{ code: "checkout_page", path: "checkout/index.html" }] }, "a checkout page with a commerce edit reads checkout_page, not commerce_markup_changed");
  // Precedence: the next-page-type meta wins over route inference. The select
  // route infers a checkout page type, but this page says product, and its
  // hash equals the baseline's, so it reads page-only.
  write("select", '<!doctype html><html><head><meta name="next-page-type" content="product"></head><body><h1>Choose your bundle, now</h1></body></html>\n');
  assert.equal(sha256("meta[next-page-type]=product"), "sha256:78536131aba2fb1b72d99be7b3977dc20987963b2b70b36a739c35e4f7b09783");
  assert.deepEqual(classify(known({ changed_pages: [page("select")] }),
    baseline({ pages: { ...PAGES_SIGNATURE.pages, "select/index.html": "sha256:78536131aba2fb1b72d99be7b3977dc20987963b2b70b36a739c35e4f7b09783" } })),
  { kind: "page_only", reasons: [] }, "meta next-page-type is read before the route");
  // A page whose meta now says checkout reads checkout_page, not commerce_markup_changed.
  write("upsell1", PAGES.upsell1.replace('content="upsell"', 'content="checkout"'));
  assert.deepEqual(classify(known({ changed_pages: [page("upsell1")] })),
    { kind: "commerce_affecting", reasons: [{ code: "checkout_page", path: "upsell1/index.html" }] }, "a page retyped as checkout is a checkout page");
  write("checkout", PAGES.checkout.replace("<h1>Checkout</h1>", "<h1>Secure checkout</h1>"));

  write("upsell1", PAGES.upsell1.replace('data-next-package-id="12"', 'data-next-package-id="14"'));
  assert.deepEqual(classify(known({ changed_pages: [page("upsell1")] })),
    { kind: "commerce_affecting", reasons: [{ code: "commerce_markup_changed", path: "upsell1/index.html" }] }, "a package ref edit is commerce markup");
  write("upsell1", PAGES.upsell1.replace("Add a second bottle", "Add a third bottle"));
  assert.deepEqual(classify(known({ changed_pages: [page("upsell1")] })), { kind: "page_only", reasons: [] }, "a copy-only upsell edit is page-only");

  assert.deepEqual(classify(known({ changed_pages: [page("upsell1")], extra: ["upsell1/index.html"] })),
    { kind: "commerce_affecting", reasons: [{ code: "page_added", path: "upsell1/index.html" }] });
  assert.deepEqual(classify(known({ changed_pages: [page("checkout")], extra: ["checkout/index.html"] })),
    { kind: "commerce_affecting", reasons: [{ code: "page_added", path: "checkout/index.html" }] }, "an added page reads page_added before any checkout check");
  assert.deepEqual(classify(known({ changed_pages: [page("upsell2")], missing: ["upsell2/index.html"] })),
    { kind: "commerce_affecting", reasons: [{ code: "page_removed", path: "upsell2/index.html" }] });

  for (const [label, assembly] of [
    ["an older algorithm", baseline({ algorithm: "commerce-signature/v0" })],
    ["no signature", {}],
    ["pages not an object", baseline({ pages: [] })],
    ["a non-string config", baseline({ campaign_config: null })],
  ]) {
    assert.deepEqual(classify(known({ changed_pages: [page("landing")] }), assembly),
      { kind: "commerce_affecting", reasons: [{ code: "commerce_signature_unavailable" }] }, `${label} reads as no recorded signature`);
    assert.deepEqual(classify(known({ changed_pages: [page("checkout"), page("landing")] }), assembly),
      { kind: "commerce_affecting", reasons: [{ code: "commerce_signature_unavailable" }, { code: "checkout_page", path: "checkout/index.html" }] },
      `${label}: a checkout page still reads checkout_page after the pathless reason`);
  }

  const withoutLanding = structuredClone(PAGES_SIGNATURE.pages);
  delete withoutLanding["landing/index.html"];
  assert.deepEqual(classify(known({ changed_pages: [page("landing")] }), baseline({ pages: withoutLanding })),
    { kind: "commerce_affecting", reasons: [{ code: "commerce_signature_unavailable", path: "landing/index.html" }] }, "a signature without the page's key");
  assert.deepEqual(classify(known({ changed_pages: [page("vanished")] })),
    { kind: "commerce_affecting", reasons: [{ code: "commerce_signature_unavailable", path: "vanished/index.html" }] }, "a changed page that cannot be read");

  assert.deepEqual(classify(known({ changed_pages: [page("landing")] }), baseline({ campaign_config: "unavailable:file_missing" })),
    { kind: "commerce_affecting", reasons: [{ code: "campaign_config_unavailable" }] }, "a recorded unavailable config");
  assert.deepEqual(classify(known({ changed_pages: [page("landing")] }), baseline({ campaign_config: "sha256:x" })),
    { kind: "commerce_affecting", reasons: [{ code: "campaign_config_changed" }] }, "a recorded config hash that differs");
  writeFileSync(join(dir, "_data", "campaigns.json"), JSON.stringify({ [SLUG]: { ...CONFIG[SLUG], sdk_version: "0.4.41" } }));
  assert.deepEqual(classify(known({ changed_pages: [page("landing")] })),
    { kind: "commerce_affecting", reasons: [{ code: "campaign_config_changed" }] }, "an edited config entry against the literal baseline");
  rmSync(join(dir, "_data", "campaigns.json"));
  assert.deepEqual(classify(known({ changed_pages: [page("landing")] })),
    { kind: "commerce_affecting", reasons: [{ code: "campaign_config_changed" }] }, "a current unavailable config against a recorded hash reads changed");
  assert.deepEqual(classify(known({ changed_pages: [page("landing")] }), baseline({ campaign_config: "unavailable:file_missing" })),
    { kind: "commerce_affecting", reasons: [{ code: "campaign_config_unavailable" }] }, "the same unavailable status on both sides still reads unavailable");
  writeFileSync(join(dir, "_data", "campaigns.json"), JSON.stringify(CONFIG));

  assert.deepEqual(classify(known({ changed_pages: [page("checkout"), page("landing")], unmapped_files: ["x.js"] }), baseline({ campaign_config: "sha256:x" })),
    { kind: "commerce_affecting", reasons: [
      { code: "unmapped_file", path: "x.js" },
      { code: "campaign_config_changed" },
      { code: "checkout_page", path: "checkout/index.html" },
    ] }, "reason order: unmapped files, then config, then pages in list order");

  const many = Array.from({ length: 25 }, (_, index) => `assets/file-${String(index).padStart(2, "0")}.js`);
  const capped = classify(known({ unmapped_files: many }), {});
  assert.equal(capped.kind, "commerce_affecting");
  assert.equal(capped.reasons.length, 20, "reasons are capped at CHANGE_PATH_LIMIT = 20");
  assert.deepEqual(capped.reasons[0], { code: "commerce_signature_unavailable" }, "the pathless unavailable reason is first, so the cap never drops it");
  assert.deepEqual(capped.reasons.slice(1), many.slice(0, 19).map((path) => ({ code: "unmapped_file", path })), "then the first 19 unmapped files");
  const cappedSigned = classify(known({ unmapped_files: many }));
  assert.deepEqual(cappedSigned.reasons, many.slice(0, 20).map((path) => ({ code: "unmapped_file", path })), "with a signature, the first 20 unmapped files");
}));

// Captured with parse5 8.0.1 / entities 8.1.0. parse5 8.1.0 no longer
// reconstructs the formatting element after </desc>, dropping the second
// commerce fact. Updating old records would destroy their provenance.
test("v1 preserves foreign-element reconstruction against a saved record", () => withTempDir((dir) => {
  const html = '<svg><desc><b data-next-package-id="1">Old copy</desc><p>More copy';
  const signature = "sha256:b7ef29d46fe19ce25b41a5f3082a244a30e342a62f4233823ce3753b6b9233e5";
  assertVector("foreign element reconstruction", {
    html: [html, html.replace("Old copy", "New copy")],
    facts: "b[data-next-package-id]=1\nb[data-next-package-id]=1",
    signature,
  });
  mkdirSync(join(dir, "_data"));
  writeFileSync(join(dir, "_data/campaigns.json"), JSON.stringify(CONFIG));
  const built = join(dir, "landing.html");
  writeFileSync(built, html.replace("Old copy", "New copy"));
  const baseline = { commerce_signature: { algorithm: "commerce-signature/v1", campaign_config: PAGES_SIGNATURE.campaign_config, pages: { "landing.html": signature } } };
  const changed = { status: "known", extra: [], missing: [], changed_pages: [{ built_path: "landing.html", page_id: "landing", page_type: "product" }], unmapped_files: [] };
  assert.equal(classifyDrift({ changes: changed, baseline, targetRepo: dir, publicRouteSlug: SLUG, outputRoot: dir }).kind, "page_only");
  writeFileSync(built, html.replace('package-id="1"', 'package-id="2"'));
  assert.equal(classifyDrift({ changes: changed, baseline, targetRepo: dir, publicRouteSlug: SLUG, outputRoot: dir }).kind, "commerce_affecting");
}));
