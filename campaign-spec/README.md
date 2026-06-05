# campaign-spec

The CampaignSpec contract layer: a normalize phase, a composable rule registry,
and a canonical fixture corpus. Read `../CONTEXT.md` first for vocabulary
(`CampaignSpec`, `Rule`, `Violation`, `Tag`, `Corpus`).

This module is the single, public source of truth for CampaignSpec validation.
The Campaigns OS CLI doctor runs these rules during spec validation, and any
campaign authoring UI (such as a Map Builder bundle) can import the same registry
so internal teams and third-party agencies validate against identical rules. The
rules are pure TypeScript over a normalized spec with no heavy dependencies.

## Layout

```
campaign-spec/
  index.ts                 # public interface
  types.ts                 # CampaignSpec, Rule, Violation, Tag, Severity
  normalize.ts             # v4.3 authoring → canonical v4.2 funnels[] shape
  rules/
    index.ts               # preset RuleSet constants
    cycle-detection.ts     # one file per rule
    ...
  fixtures/
    index.ts               # corpus loader
    *.json                 # specs
    expected/*.json        # expected violations per spec
  test/
    rules/*.test.ts        # per-rule unit tests
    corpus.test.ts         # corpus contract test
```

## Public interface

```ts
import {
  // Types
  type CampaignSpec, type Rule, type Violation, type Tag,
  // Phases
  normalize, runRules, validateSpec,
  // Presets
  allRules, fastRules, specOnlyRules,
} from './campaign-spec'

// Backwards-compat (= runRules(allRules, normalize(spec)))
const violations = validateSpec(spec)

// Composable
const violations = runRules(normalize(spec), fastRules)

// Custom selection
const violations = runRules(
  normalize(spec),
  allRules.filter(r => r.tags.includes('structure') && r.id !== 'CycleDetection'),
)
```

## Rule shape

```ts
type Rule = {
  id: string                    // unique, stable; appears in Violation.ruleId
  severity: 'error' | 'warning' // default; per-violation can override
  tags: Tag[]                   // closed set, see types.ts
  check(spec: CampaignSpec): Violation[]
}
```

Rules are **pure** over a normalized spec. No context bag. No live data
dependency. Mode flags ("partial spec mid-edit", "fast mode") are tag filters,
not context flags. Rule parameters are bound at registration time.

## Violation shape

```ts
type Violation = {
  ruleId: string
  severity: 'error' | 'warning'
  message: string
  path: string                  // JSON Pointer: /funnels/0/pages/2/route
  data?: Record<string, unknown>
}
```

`path` enables field-level UI without rule-specific wiring. `data` carries
structured detail.

## Adding a rule

1. Create `rules/your-rule.ts`. Export a `Rule` value.
2. Add it to the `allRules` array in `rules/index.ts`. If it belongs in
   `fastRules` or `specOnlyRules`, add it to those too.
3. Add a unit test in `test/rules/your-rule.test.ts` that loads a focused
   fixture and asserts the violations.
4. If the rule needs a new fixture, add `fixtures/<name>.json` and
   `fixtures/expected/<name>.expected.json`. The corpus contract test will
   pick it up automatically.

## Adding a tag

Edit the `Tag` union in `types.ts` and the tag inventory in `../CONTEXT.md`.
The closed taxonomy is intentional — closed sets are documented; open sets
drift.

## Tests

```bash
cd campaign-spec
bun test
```

Two surfaces:

- **Per-rule** (`test/rules/*.test.ts`): focused fixtures, focused assertions.
- **Corpus contract** (`test/corpus.test.ts`): every fixture asserted against
  its expected violations across all rules. Drift lights up exactly which
  fixture diffed.

## Consuming from a browser bundle

A campaign authoring UI can bundle this module (e.g. with esbuild as a browser
IIFE) and expose the public interface on `window` to run export-time validation
client-side. The rules have no Node-only or live-data dependencies, so the same
registry that backs the CLI doctor runs unchanged in the browser.

## See also

- `../CONTEXT.md` — domain vocabulary.
- v4.1 spec topology is intentionally unsupported: `normalize()` rejects
  `funnel_pages` input rather than silently wrapping it.
