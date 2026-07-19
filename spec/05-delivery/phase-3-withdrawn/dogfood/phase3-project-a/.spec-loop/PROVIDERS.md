---
schema_version: 1
active_provider: codex
providers:
  codex:
    enabled: true
    executable: codex
    args:
      - exec
      - --json
      - --sandbox
      - workspace-write
      - --ephemeral
    timeout_seconds: 1800
  claude-code:
    enabled: false
    executable: claude
    args: []
    timeout_seconds: 1800
  qoder:
    enabled: false
    executable: qoder
    args: []
    timeout_seconds: 1800
---

# Providers

Default provider: Codex.
