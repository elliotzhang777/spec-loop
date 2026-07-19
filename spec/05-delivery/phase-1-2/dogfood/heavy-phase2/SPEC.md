---
schema_version: 1
task_id: TASK-DOGFOOD-HEAVY
title: Validate Phase 2 runtime guard and ledger
level: heavy
---

# Goal

Prove the Phase 2 runtime ledger, Guard, deterministic projections and multi-Round Heavy acceptance using the real spec-loop implementation.

## Scope

- Record a failed first Round and a successful repair Round.
- Exercise sequential Attempts, automatic Guard and deterministic summaries.
- Require an independent Verifier, human check and current-Round signature.

## Non-goals

- Do not implement later Agent orchestration or scheduling.
- Do not store credentials or external Connector data.
