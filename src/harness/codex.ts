// codex.ts — the Codex adapter STUB + the contributor path to finishing it.
//
// v1 ships two working harnesses (Pi, Claude Code) and this pluggable third:
// the contract is src/harness/types.ts, the acceptance bar is the conformance
// suite in src/harness/conformance.ts — an adapter that passes conformance
// against its own transport is done. See tests/harness-claude-code.test.ts and
// tests/harness-pi.test.ts for what a ConformanceWorld looks like.
//
// Implementation sketch for a contributor (matching the other adapters):
//   spawn   → write prompt.md + policy.json into the scoped dir; launch
//             `codex exec --json --sandbox workspace-write -C <worktree>` as a
//             child process; deliver the prompt; keep a session handle.
//   policy  → enforce natively: Codex's sandbox config scopes writes to the
//             worktree; denyCommands render into the sandbox/approval policy.
//             The verdict logic MUST be src/harness/policy.ts (one evaluator,
//             N enforcement shells) so all harnesses block identically.
//   poll    → parse the child's JSON event stream; NEVER throw (transport
//             failure = {state:"unknown"}).
//   collect → usage/cost from the stream's token_count events; transcript =
//             the captured event log in the scoped dir; outcome via
//             extractOutcome (../engine/executor.ts).
//   dispose → idempotent kill + transcript snapshot.

import type { Harness, HarnessArtifacts, HarnessSession, PollResult, SpawnRequest } from "./types.ts";

const HOWTO =
	"CodexHarness is a conformance stub — implement it against src/harness/types.ts " +
	"and prove it with runConformance (src/harness/conformance.ts). See src/harness/codex.ts for the sketch.";

/** Registered so a card with `worker: codex` fails LOUDLY at spawn (the engine
 *  escalates it to Needs Review with this reason) instead of silently stalling. */
export class CodexHarness implements Harness {
	readonly name = "codex";

	async spawn(_req: SpawnRequest): Promise<HarnessSession> {
		throw new Error(HOWTO);
	}
	async inject(_session: HarnessSession, _message: string): Promise<boolean> {
		return false;
	}
	async poll(_session: HarnessSession): Promise<PollResult> {
		return { state: "failed" };
	}
	async collect(_session: HarnessSession): Promise<HarnessArtifacts> {
		return { outcome: HOWTO, outputTail: "", usage: null, transcriptRef: null, promptRef: "", errorCount: 0 };
	}
	async dispose(_session: HarnessSession): Promise<void> {
		/* nothing to tear down */
	}
}
