# Classifier + cost-aware model routing

The cost story in one sentence: a dependable **workhorse** model completes
mapped task classes; **frontier** models run only where judgment lives.
Re-routing is a config edit, not a code change.

Code: `src/routing/classify.ts`, `src/routing/table.ts`. Wired into the
dispatch path by `src/engine/orchestrate.ts`. Tests: `tests/routing.test.ts`.

## The triage stage

Before any expensive worker spawns, a cheap classifier reads the card and
answers:

| Question | Values |
|---|---|
| `class` | `chore` · `research` · `feature` · `plan` · `review` |
| `delegation` | `auto` (AI can run unattended) · `human` (judgment held) |
| `complexity` | `deterministic` · `exploratory` |
| `outcome` | `code` · `artifact` · `answer` |

Two implementations of the `Classifier` interface:

- **`RuleClassifier`** - deterministic keyword + `card_type` heuristics. Zero
  cost, zero network. The fallback and the test workhorse.
- **`HeadlessModelClassifier`** - one `claude -p --model <cheap>` call with
  tools disabled, strict JSON out. **Any** failure - spawn error, timeout,
  unparseable reply, invalid enum - falls back to the rules. Classification
  must never block the board.

## The routing table: `knowledge/routing.json`

Config, not code - part of the governed knowledge layer, seeded on first boot,
schema-validated (`schema/routing.schema.json`):

```json
{
  "version": 1,
  "tiers": {
    "workhorse": "claude-haiku-4-5",
    "frontier": "claude-opus-4-8"
  },
  "routes": {
    "chore": "workhorse",
    "research": "workhorse",
    "feature": "frontier",
    "plan": "frontier",
    "review": "frontier",
    "default": "workhorse"
  },
  "classifier": { "model": "claude-haiku-4-5" }
}
```

- `tiers` maps tier → concrete model id (harness-native naming - put whatever
  your harness accepts here).
- `routes` maps card class → tier and must carry `default` (unknown classes
  route there).
- `classifier.model` is the cheap model the triage call itself runs on.

Fail-safe like the rest of the knowledge layer: a malformed table falls back
to the seeded defaults (never to "no routing") with a warning.

## Precedence

1. **Human pin wins.** A `model:` field in the card's frontmatter is never
   overridden - the classifier still runs (the class is useful provenance),
   but the pinned model dispatches.
2. Otherwise the classified class resolves through `routes` → `tiers`.
3. `--model M` on `holdco serve` sets the pool-level default when routing is
   off.

## Provenance, not hidden state

The decision is written onto the card (`class` / `tier` / `model` /
`classified_by`) before dispatch, and the classify stage emits a StageEvent
(deterministic node, `stage: "classify"`) carrying tier + model - so every
routing decision is inspectable on the card and in the deck. The write is
loop-suppressed: it produces no reconcile delta.

## CLI

```
holdco serve                     # default: model classifier (routing table's cheap model)
holdco serve --classifier rule   # deterministic rules only - no model call
holdco serve --classifier off    # no triage; cards run on the pool default model
```

Live proof: `scripts/live-m5-routing.sh` - a chore card auto-ran on the
workhorse tier at roughly a fifth of the frontier cost.
