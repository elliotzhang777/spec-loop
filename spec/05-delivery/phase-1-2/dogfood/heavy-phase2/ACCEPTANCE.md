---
schema_version: 1
task_id: TASK-DOGFOOD-HEAVY
criteria:
  - id: AC-1
    text: Attempt numbers and Round numbers remain continuous across two real Rounds.
  - id: AC-2
    text: Guard permits the repair Round while budgets remain within configured limits.
  - id: AC-3
    text: Ledger, Run Log and deterministic Run Summary remain consistent after all Attempts.
  - id: AC-4
    text: Heavy Delivery has current-Round Evidence, an independent Verifier and an explicit human check.
---

# Acceptance Contract

Each criterion requires current evidence.
