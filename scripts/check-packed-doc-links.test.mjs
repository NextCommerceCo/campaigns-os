import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkPackedDocLinks } from "./check-packed-doc-links.mjs";

function fixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), "campaigns-os-doc-links-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("installed guides must include linked docs and their transitive destinations", () => {
  fixture({ "README.md": "[intake](docs/intake.md)", "docs/intake.md": "[source](source.md#prepare)" }, (root) => {
    assert.match(checkPackedDocLinks(root, ["README.md"]).join("\n"), /docs\/intake.md:1: source.md#prepare is missing/);
    writeFileSync(join(root, "docs/source.md"), "# Prepare\n[broken section](#missing)");
    assert.match(checkPackedDocLinks(root, ["README.md"]).join("\n"), /source.md:2: #missing has no matching/);
    writeFileSync(join(root, "docs/source.md"), "# Prepare\n[back](intake.md)");
    assert.deepEqual(checkPackedDocLinks(root, ["README.md"]), []);
  });
});

test("anchors, encoded paths, reference links and nested URL parentheses resolve", () => {
  fixture({
    "README.md": '[guide](<docs/my guide.md#prepare-input>)\n[again][Guide]\n[shortcut]\n[parentheses](docs/flow(v5).md#named)\n[Guide]: docs/my%20guide.md#prepare-input-1 "title"\n[shortcut]: docs/my%20guide.md#setext-heading',
    "docs/my guide.md": "# Prepare `input`\n# Prepare `input`\nSetext heading\n---\n",
    "docs/flow(v5).md": '<a id="named"></a>',
  }, (root) => assert.deepEqual(checkPackedDocLinks(root, ["README.md"]), []));
});

test("code examples and external URLs do not become package dependencies", () => {
  fixture({ "README.md": '# Intro\n[web](https://example.com/missing.md#any)\n`[code](missing.md)`\n```md\n[example](../examples/missing.md)\n```\n<!-- [draft](missing.md) -->\n[here](#intro)\n' }, (root) => {
    assert.deepEqual(checkPackedDocLinks(root, ["README.md"]), []);
    writeFileSync(join(root, "README.md"), "[escape](../outside.md)\n[invalid](docs/%ZZ.md)");
    assert.equal(checkPackedDocLinks(root, ["README.md"]).length, 2);
  });
});

test("local documentation images must be packed, while remote images stay external", () => {
  fixture({ "README.md": "![diagram](diagram.svg)\n![badge](https://example.com/badge.svg)" }, (root) => {
    assert.deepEqual(checkPackedDocLinks(root, ["README.md"]), ["README.md:1: diagram.svg is missing from the package"]);
    writeFileSync(join(root, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.deepEqual(checkPackedDocLinks(root, ["README.md"]), []);
  });
});

test("multiline code spans and embedded shorter backtick runs remain code", () => {
  fixture({ "README.md": "`multiline\n[example](missing.md)`\n\n``nested `\n[example](also-missing.md)``" }, (root) => {
    assert.deepEqual(checkPackedDocLinks(root, ["README.md"]), []);
  });
});

test("unmatched backticks cannot hide links in later paragraphs or pair unequal runs", () => {
  fixture({ "README.md": "An unmatched ` marker.\n\n[guide](missing.md)\n\nLater `code`." }, (root) => {
    assert.deepEqual(checkPackedDocLinks(root, ["README.md"]), ["README.md:3: missing.md is missing from the package"]);
    writeFileSync(join(root, "README.md"), "Unequal `` [guide](missing.md) ` runs.");
    assert.deepEqual(checkPackedDocLinks(root, ["README.md"]), ["README.md:1: missing.md is missing from the package"]);
  });
});
