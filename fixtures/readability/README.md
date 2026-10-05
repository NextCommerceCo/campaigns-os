# readability fixtures

Pinned data for the unit 2.4 (readability) row tests. The stub pages the
browser rows serve are written inline in `src/polish-readability.browser.test.mjs`
and `src/qa-cta-contrast.browser.test.mjs` and served on 127.0.0.1; nothing
here is fetched.

| Fixture | What it holds | Used by |
|---|---|---|
| `chromium-153-color-serialization.json` | `rows`: an authored CSS colour (`input`), the string Chromium 153.0.8010.12 serializes for it as a computed `color` (`serialized`), and the parse value written by hand from the CSS Color 4 definition of that serialized form (`expected`: `{space, coords, alpha}`; `none` reads as 0, alpha defaults to 1). `unparseable`: strings outside the closed list of six forms, which parse to `{unparseable}`. | `F2.4-W1` (`src/contrast.test.mjs`) |
| `brand-theme-css-base.json` | Every packet `src/brand-theme.test.mjs` builds through `inspectBrandTheme` (the packet, its options and the directory tree it read), with the CSS the theme generator produced for it by release 1.52.0, byte for byte. The packet directory is written `{root}` in the CSS header. | `F2.4-W16` (`src/brand-theme.test.mjs`) |
