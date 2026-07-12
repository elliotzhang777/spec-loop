---
schema_version: 1
task_id: TASK-DOGFOOD-HEAVY
version: 1
ac_coverage:
  - AC-1
  - AC-2
  - AC-3
  - AC-4
---

# Plan

1. Initialize the runtime budget, ledger, human log and deterministic summary.
2. Record a real first-Round verification failure and transition to iterating.
3. Execute Guard before opening the second Round.
4. Record the repair Attempt and rerun the complete test suite.
5. Perform independent verification and explicit human inspection.
6. Map all Heavy criteria to current-Round Evidence and deliver.
