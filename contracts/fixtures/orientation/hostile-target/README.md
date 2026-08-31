# Hostile-target orientation fixture

A miniature Campaigns OS target that carries every locally executable thing a
real checkout can carry: Git hooks, executable scripts, and npm package
lifecycle scripts. Its orientation data under `repo/` is valid, so a correct
consumer can read it end to end and produce a normal envelope.

"Valid" includes the fixture's own supported-surface manifest: every path
`repo/contracts/supported-surface.json` declares exists in the tree, and the
digest it records for its hashed entry is that file's real sha256. A consumer
that verifies integrity therefore succeeds here rather than refusing — which is
the point, because a read that refuses early never reaches the tripwires and so
proves nothing about whether the parser would have executed them.
`scripts/check-release-ledger.test.mjs` asserts that correspondence, so the
fixture cannot quietly rot back into a refusal.

The fixture carries two invariants over one tree, because the tripwires are the
same tripwires: a target that can ambush a reader can ambush an installer.

1. **Orientation executes nothing.** The tripwire count for a full orientation
   read is exactly zero. This is the original invariant and `tripwires[]` plus
   `expected_hit_count` in `manifest.json` describe it.
2. **Runtime-recipe preparation executes only the recipe's own steps.** The
   accepted recipe installs with dependency lifecycle scripts suppressed and
   builds one named script without its pre/post siblings. `recipe_execution` in
   `manifest.json` describes it: the tripwire log stays empty and the separate
   intended-script log holds exactly one line. `repo/hostile-dependency-tripwire/`
   exists for this second invariant — it is packed into a tarball and installed
   as a real dependency, so dependency-side lifecycle scripts are exercised for
   real rather than assumed.

   That invariant needs a control, and `recipe_execution.control` names it:
   running the same two commands *without* the suppressing flag must fire
   tripwires. A suppression test with no control passes just as happily against
   a dependency whose scripts would never have fired anyway.

**Nothing in this directory is ever executed by this repository.** The files
exist so that a consumer's parser can be pointed at a target that *would* run
code if the parser ever shelled out, checked anything out, or installed
anything. Every tripwire appends one line to the file named by
`CAMPAIGNS_OS_TRIPWIRE_LOG` (falling back to `tripwire.log` beside itself) and
then exits 0, so a hit is recorded rather than crashing the run being tested.
The one exception is `repo/bin/intended.mjs`, which is not a tripwire: it is the
script the recipe's build step is *supposed* to run, and it logs to
`CAMPAIGNS_OS_INTENDED_LOG` instead.

The assertion that the hit count stays zero belongs to the consumer's parser
suite, not here: this repository ships the fixture, the consumer ships the
counter. `manifest.json` enumerates the tripwires so that counter can assert an
exact expected set rather than a hand-copied list.

Consuming it:

1. Materialize `repo/` as the target tree (copy it, or commit it into a
   temporary repository and install `repo/hooks/*` as that repository's hooks).
2. Point `CAMPAIGNS_OS_TRIPWIRE_LOG` at a fresh path.
3. Run the full orientation read against the target.
4. Assert the log does not exist, or is empty.

Any non-zero count means the parser executed target-controlled code, which the
contract forbids regardless of how harmless the executed code looks.
