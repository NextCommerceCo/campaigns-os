# Harness matrix

Where each agent harness looks for instructions, skills, plugins and MCP
servers. The matrix exists so a packaging decision can cite a source instead of
a recollection.

**First-party** means the harness vendor documents the cell in its own
documentation, and this file cites that page. Anything else is `unverified`,
including a value we believe to be true from a local artifact or from memory: a
cell without a citation is a claim nobody can check.

**Tested** is a stronger word than first-party and no cell here claims it. A
cell becomes tested only after an install exercise on a populated home directory
— an actual install run against a real harness home with existing content,
producing a receipt. Documented discovery is not an installation receipt: that a
vendor documents a directory says where the harness *reads*, not that installing
into it succeeded, merged cleanly, or was picked up.

Two skill placements are in scope for the first release: `.claude/skills` and
`.agents/skills`. Note that Codex does not merge same-name skills across its
search path — a skill with the same name found in two of its directories is
listed twice.

All first-party cells below were verified 2026-09-22 against the cited pages.

## Matrix

| Harness | Instruction file | Skills directory | Plugin manifest | MCP registration | Status |
| --- | --- | --- | --- | --- | --- |
| Claude Code | [`CLAUDE.md` / `.claude/CLAUDE.md` (project), `~/.claude/CLAUDE.md` (user); `AGENTS.md` also readable](https://code.claude.com/docs/en/memory) | [`~/.claude/skills/<name>/SKILL.md` (personal), `.claude/skills/<name>/SKILL.md` (project); `.agents/skills` is not documented](https://code.claude.com/docs/en/skills) | unverified — not retrieved first-party this cycle | [`.mcp.json` at project root (project scope); `~/.claude.json` (user/local scope); `claude mcp add --scope`](https://code.claude.com/docs/en/mcp) | first-party (verified 2026-09-22) |
| Codex | [`~/.codex/AGENTS.md` (global; override variant preferred), then `AGENTS.md` / `AGENTS.override.md` from the git root down to the cwd, merged, closer wins; 32 KiB cap](https://learn.chatgpt.com/codex/agent-configuration/agents-md#how-codex-discovers-guidance) | [`$CWD/.agents/skills`, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`; same-name skills are not merged and both are listed](https://learn.chatgpt.com/docs/build-skills) | unverified (local artifact only) | [`[mcp_servers.<name>]` in `~/.codex/config.toml`; `codex mcp add`](https://learn.chatgpt.com/codex/extend/mcp#configure-with-configtoml) | first-party (verified 2026-09-22) |
| Cursor | [`.cursor/rules/*.mdc` (project rules); `AGENTS.md` in the root and in subdirectories; order Team → Project → User](https://cursor.com/docs/context/rules) | [project `.agents/skills/`, `.cursor/skills/`; user `~/.agents/skills/`, `~/.cursor/skills/`; compatibility `.claude/skills`, `.codex/skills` (project and `~`); nested directories discovered](https://cursor.com/docs/skills#skill-directories) | unverified | [`.cursor/mcp.json` (project), `~/.cursor/mcp.json` (global)](https://cursor.com/docs/context/mcp) | first-party (verified 2026-09-22) |
| Grok Build | unverified | unverified | unverified | unverified | unverified |
| Muse Code | unverified | unverified | unverified | unverified | unverified |
| GitHub Copilot CLI | unverified | unverified | unverified | unverified | unverified |
| Hermes | unverified | unverified | unverified | unverified | unverified |
| OpenClaw | unverified | unverified | unverified | unverified | unverified |
| Grok Bot | unverified | unverified | unverified | unverified | unverified |

The six `unverified` harnesses are not first-release targets. Nothing is claimed
about them here, in either direction: an empty row is an absence of first-party
evidence, not a statement that the harness lacks the feature.

## Further first-party notes

These do not fit a column but bear on how a skill behaves once installed.

- Claude Code skill lifecycle: the text of an invoked `SKILL.md` stays in
  context and is not re-read on later turns
  ([skill content lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle)).
  A skill therefore cannot rely on being re-read after an edit mid-session.
- Claude Code tool permissions: `allowed-tools` is a per-turn permission grant,
  and `disallowed-tools` removes tools per turn
  ([pre-approve tools for a skill](https://code.claude.com/docs/en/skills#pre-approve-tools-for-a-skill)).

## Changing this file

Add a first-party cell only with the vendor page that states it, and move a cell
to `tested` only with an install receipt against a populated home. Re-verify a
cited cell before relying on it: vendor documentation moves, and the date on a
row is the date it was read, not a guarantee about today.
