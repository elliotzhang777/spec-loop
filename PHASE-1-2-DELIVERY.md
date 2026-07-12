# Phase 1–2 Delivery Report

## Outcome

Phase 1 and Phase 2 are implemented from zero in this repository. No existing project code was copied.

The implementation provides a local file-protocol engine for:

```text
SPEC → PLAN → WORK → VERIFY → ITERATE → ACCEPTANCE → DELIVERY
```

## Architecture

```text
CLI
  → strict Markdown/JSON schemas
  → legal lifecycle transitions
  → prepared transaction journal + atomic rename
  → TASK_STATE.md + STATE_HISTORY.jsonl
  → numbered Round artifacts
  → Evidence hash validation
  → Delivery AC mapping

Phase 2 runtime
  → BUDGET.md
  → LOOP_LEDGER.jsonl
  → Guard
  → generated RUN_LOG.md
  → generated RUN_SUMMARY.md
```

`TASK_STATE.md` is the sole current lifecycle source. `STATE_HISTORY.jsonl` is an integrity trail used to reject fabricated lifecycle edits. `LOOP_LEDGER.jsonl` is the Attempt history source; Run Log and Summary are deterministic projections.

## CLI

| Command | Purpose |
|---|---|
| `init` | Create Light, Standard or Heavy task templates |
| `check` | Validate schemas and all cross-file invariants |
| `status` | Read authoritative lifecycle state |
| `next` | Show the legal next operation without mutation |
| `plan` | Validate contracts and transition draft → planned |
| `round` | Create the next continuous Round; run Guard after iteration |
| `verify` | Attach hashed Evidence and transition pass/fail |
| `deliver` | Recompute AC mappings and transition to delivered |
| `runtime-init` | Atomically initialize Budget, Ledger, Log and Summary |
| `attempt` | Append one strict, continuous Attempt |
| `guard` | Return continue, stop or needs_user |
| `summary` | Regenerate the purely factual runtime summary |

## File schemas

Normative schemas and runtime rules are documented in [DES-001](spec/03-design/DES-001-file-contract-lifecycle-acceptance.md) and [DES-002](spec/03-design/DES-002-ledger-guard-recovery.md), and enforced with strict Zod objects. Unknown fields fail. YAML duplicate keys and flat Ledger JSON duplicate keys fail. Placeholder values fail in task contracts, Rounds and error fingerprints.

Evidence binds:

- Evidence ID;
- task ID;
- current Round;
- code revision;
- artifact path;
- artifact SHA-256;
- result exit code;
- creation time.

## State machine

```text
draft --plan--> planned --round--> working
working --verify pass--> verifying --deliver--> delivered
working/verifying --verify fail--> iterating --round + Guard--> working
```

Every transition increments `state_version`. Direct state edits diverge from CLI history and fail `check`.

## Recovery

Multi-file commands first write all temporary files, then persist a prepared journal. Atomic renames roll the transaction forward. Every mutating/check operation recovers prepared journals before reading state. Missing or hash-divergent transaction files cause a hard failure rather than guessed state.

## Tests

The automated suite covers:

- Guard decisions;
- Standard and Heavy end-to-end Delivery;
- Heavy independent Verifier and human gate;
- incomplete AC mapping;
- placeholder templates;
- fabricated state;
- illegal-state Attempt;
- malformed, duplicate and unknown Ledger fields;
- continuous Attempt and Round rules;
- strict Budget fields;
- Run Log divergence;
- prepared transaction recovery;
- secret rejection.

Run with:

```bash
npm test
```

## Dogfood

### Standard

`dogfood/standard-final` reached `delivered` in Round 1. Its Evidence is the final 21-test automated suite stored as a hash-verified artifact. The earlier `standard-phase1` run is retained as development history.

### Heavy

`dogfood/heavy-final` reached `delivered` in Round 2. The earlier `heavy-phase2` run is retained as development history:

1. Round 1 recorded an independent rejection of stale pre-final evidence.
2. Guard returned `continue` within budget.
3. Round 2 generated fresh evidence from the final implementation and full suite.
4. Independent verification and explicit human check signed the current Round.
5. Delivery maps every Heavy AC to current EV-2.

## Known limitations

- No Agent invocation or Prompt orchestration.
- No background scheduler or multi-task queue.
- No Git worktree manager, push, PR or merge.
- No connector writes.
- Filesystem permissions are not a security sandbox.
- State history is an integrity consistency mechanism, not a cryptographic signature against a malicious editor who rewrites all files.
- JSON duplicate-key detection is intentionally scoped to flat Ledger Attempt objects.
- Evidence code revision is supplied by the caller; later Git integration should resolve and verify the repository HEAD automatically.
- Human check is a structured declaration, not identity-backed authentication.

## Phase 3 suggestions (not implemented)

When the next phase is authorized, consider:

1. Agent Provider adapter and versioned role protocols;
2. automatic code-revision discovery from Git;
3. worktree isolation;
4. deterministic Gate command execution;
5. independent Reviewer/Acceptance Agent orchestration;
6. multi-task queue, resource claims and leases;
7. stronger identity-backed human approvals.
