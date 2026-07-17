# Contributing

## Requirements

- **Node ≥ 24.** The code runs TypeScript directly via Node's built-in type
  stripping and uses `node:sqlite` — no build step, no transpiler, no runtime
  dependencies.
- Nothing to install for the core loop; `npm install` fetches dev-only
  `typescript` + `@types/node` for the typecheck.

## Strip-only TypeScript

Because files execute as-is under Node's type stripping, only *erasable*
TypeScript syntax is allowed:

- **No** constructor parameter properties (`constructor(private x: T)`) —
  declare the field and assign it.
- **No** `enum` — use `as const` arrays/objects + union types.
- **No** `namespace`.
- Use `import type` for type-only imports.
- Import local modules **with the `.ts` extension**
  (`allowImportingTsExtensions` is on).

`npm run typecheck` (`tsc --noEmit`, strict) is the compile gate; CI runs it
on every push.

## Tests

```
npm test
```

Plain Node scripts, one per module in `tests/`, no test framework. Each file
is directly runnable (`node tests/routing.test.ts`) and exits non-zero on
failure. New behavior needs coverage in the matching test file; a new module
needs a new test file wired into the `test` script in `package.json`.

## Adding adapters

Don't start from scratch — both seams ship executable acceptance bars:

- **Harness** (Pi/Claude Code/Codex-style executor): implement
  `src/harness/types.ts`, pass `runConformance`
  (`src/harness/conformance.ts`). See [docs/HARNESSES.md](docs/HARNESSES.md).
- **Connector** (Slack/Telegram/webhook-style intake): implement
  `src/connectors/types.ts`, pass `runConnectorConformance`
  (`src/connectors/conformance.ts`).

A hermetic fake transport is fine — that's how the shipped adapters are
tested (`tests/fixtures/fake-claude.mjs`).

## Ground rules

- Zero runtime dependencies stays zero. Node builtins only.
- Fail-safe posture: malformed config narrows authority, never widens it.
- `poll()`-shaped code returns verdicts, never throws into the sweep.
- Data-contract changes (card frontmatter, StageEvent, knowledge files) go
  through `schema/` — update the JSON Schema + fixtures in the same PR.
