# Hostile-target orientation fixture

A miniature Campaigns OS target that carries every locally executable thing a
real checkout can carry: Git hooks, executable scripts, and npm package
lifecycle scripts. Its orientation data under `repo/` is valid, so a correct
consumer can read it end to end and produce a normal envelope.

**Nothing in this directory is ever executed by this repository.** The files
exist so that a consumer's parser can be pointed at a target that *would* run
code if the parser ever shelled out, checked anything out, or installed
anything. Every tripwire appends one line to the file named by
`CAMPAIGNS_OS_TRIPWIRE_LOG` (falling back to `tripwire.log` beside itself) and
then exits 0, so a hit is recorded rather than crashing the run being tested.

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
