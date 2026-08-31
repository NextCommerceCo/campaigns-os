# Example contract (hostile-target fixture)

Invented. This document describes nothing real.

It exists because the fixture's `contracts/supported-surface.json` declares
`docs/example-contract.md` as a named entry. A named entry's promise is that the
path keeps existing, so a consumer that checks its manifest against the tree
must find a file here. When it was missing, a conforming consumer had to refuse
on integrity — which is the opposite of what this fixture is for: the fixture
proves that a full, successful orientation read executes none of the tripwires
under `repo/`.

Nothing in this directory is ever executed by this repository.
