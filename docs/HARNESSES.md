# Harness adapters

A **Harness** adapts one coding-agent runtime (Pi, Claude Code, Codex, …) to
five verbs. The engine's worker pool owns everything harness-neutral - slot
accounting, circuit breaker, budget kill, watchdog, git-diff harvest, board
writes. The adapter owns transport only: how a worker launches, how its brief
is delivered, how liveness/completion are observed, how usage and transcripts
are harvested.

Contract: `src/harness/types.ts`. Acceptance bar: `src/harness/conformance.ts`.

## The five verbs

```ts
interface Harness {
  readonly name: string;                                        // adapter id on cards, StageEvents, deck badges
  spawn(req: SpawnRequest): Promise<HarnessSession>;            // launch worker, deliver brief (the ONE verb allowed to throw)
  inject(session, message: string): Promise<boolean>;           // mid-run steer; false = could not deliver
  poll(session): Promise<PollResult>;                           // non-blocking status probe; NEVER throws
  collect(session): Promise<HarnessArtifacts>;                  // outcome, usage, transcript + prompt refs
  dispose(session): Promise<void>;                              // idempotent teardown; transcript survives
}
```

Two hard rules:

1. **`poll()` returns a value, never throws.** A transport hiccup must not
   crash the engine's sweep - report `{state: "unknown"}` and let the
   watchdog decide.
2. **The safety policy is enforced natively per harness.** One pure evaluator
   (`src/harness/policy.ts`) decides; each adapter wraps it in its runtime's
   own enforcement mechanism. Same policy, native blocking.

## Safety policy

`SafetyPolicy = { writeScopes, denyCommands }`. Writes are allowed only under
the per-card worktree + scoped dir; commands matching a deny pattern (or whose
write targets resolve outside scope) are blocked. The default deny list bans
`git push/commit/merge/rebase/reset --hard/apply` - publishing is a human
gate, and the engine harvests the *uncommitted* worktree, so a worker commit
would break the merge-back contract.

The policy source is `knowledge/permissions.json` (fail-safe: malformed →
default deny posture). Enforcement shells:

| Harness | Mechanism |
|---|---|
| Claude Code | PreToolUse hook process (`src/harness/claude-code-guard.ts`) - exit 2 blocks, stderr feeds back to the model |
| Pi | tool-call guard extension (`src/harness/pi-guard.ts`), loaded via `-e`; fails closed if the policy file is unreadable |
| Codex | its sandbox config (per the stub's implementation sketch) |

## Shipped adapters

- **`claude-code`** (`src/harness/claude-code.ts`) - the default. Each worker
  is a headless `claude -p` process speaking stream-json on stdin/stdout.
  Stdin stays open so `inject()` can steer mid-run; every stdout line streams
  into `session.jsonl` (the durable transcript); usage/cost accumulate from
  result events; completion is protocol-level (no sentinel).
- **`pi`** (`src/harness/pi.ts`) - runs workers as Pi processes in herdr
  panes: execution-only `pi --no-extensions -e pi-guard`, sentinel-based
  completion detection, submit-verify steer delivery, stable pane labels
  (pane ids renumber when siblings close). Needs a live herdr session, so it
  registers when a Pi shell wires it in.
- **`codex`** (`src/harness/codex.ts`) - a conformance stub that fails
  *loudly* at spawn (a card asking for it escalates to `Needs Review` instead
  of stalling). The file carries a full implementation sketch; the
  conformance suite is the finish line.

## Conformance

`runConformance(world)` is shipped source, not test-only - a contributor runs
exactly this against their adapter. The caller provides a `ConformanceWorld`
(make a workspace, drive the worker to completion, break the transport,
attempt policy violations through the worker's own action channel). Checks:

1. **lifecycle** - spawn → (starting|working) → done; never "done" before the
   work happened
2. **prompt artifact** - the brief lands in a durable `promptRef`
3. **constraints rendered** - `knowledge/constraints.md` text provably reaches
   the worker's delivered context (`constraintsRef`)
4. **edge safety** - with the transport broken, `poll()` *returns*
   (`unknown`/`failed`), never throws; `dispose()` survives too
5. **policy enforcement** - an out-of-scope write and a denied command are
   both blocked by the adapter's *native* mechanism
6. **telemetry** - `collect()` yields usage (tokens + cost), a durable
   transcript ref, and the worker's `OUTCOME:` line
7. **dispose idempotency** - dispose twice, no throw; evidence survives

Reference worlds: `tests/harness-claude-code.test.ts` (hermetic fake CLI
speaking the real stream-json protocol) and `tests/harness-pi.test.ts`.

## Adding an adapter

1. Implement `Harness` against `src/harness/types.ts`.
2. Enforce `SafetyPolicy` through your runtime's native mechanism, delegating
   verdicts to `evaluateToolAction` in `src/harness/policy.ts`.
3. Build a `ConformanceWorld` for your transport (fake is fine - the Claude
   Code tests fake the whole CLI) and pass `runConformance`.
4. Register it in the `harnesses` record in `src/cli.ts`; select per board
   with `--worker-harness <name>` or per card with `worker:` frontmatter.
