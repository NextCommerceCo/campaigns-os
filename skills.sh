#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI=(node "$ROOT/bin/campaigns-os.mjs")

usage() {
  cat <<'EOF'
Campaigns OS local skill helper

Usage:
  ./skills.sh status
  ./skills.sh install [claude|codex|agents|all]
  ./skills.sh dry-run [claude|codex|agents|all]
  ./skills.sh context <target-campaign-repo>

Examples:
  ./skills.sh status
  ./skills.sh install codex
  ./skills.sh install all
  ./skills.sh context ../my-campaign-repo

Targets:
  claude  -> ~/.claude/skills
  codex   -> ~/.codex/skills
  agents  -> ~/.agents/skills
  all     -> all of the above
EOF
}

action="${1:-status}"
platform="${2:-all}"

case "$action" in
  status)
    "${CLI[@]}" install-skills --platform all --dry-run
    ;;
  dry-run)
    "${CLI[@]}" install-skills --platform "$platform" --dry-run
    ;;
  install)
    "${CLI[@]}" install-skills --platform "$platform"
    ;;
  claude|codex|agents|all)
    "${CLI[@]}" install-skills --platform "$action"
    ;;
  context)
    target="${2:-}"
    if [[ -z "$target" ]]; then
      echo "Missing target campaign repo." >&2
      usage >&2
      exit 2
    fi
    "${CLI[@]}" install-agent-context --target "$target"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $action" >&2
    usage >&2
    exit 2
    ;;
esac
