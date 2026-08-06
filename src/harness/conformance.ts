// conformance.ts - the executable definition of "a working Harness adapter".
//
// An adapter passes conformance when it proves, against its own transport (real
// or faked by the caller's ConformanceWorld):
//   1. lifecycle transitions - spawn → (starting|working) → done after the run
//      completes; never "done" before the work happened
//   2. prompt artifact - spawn writes the brief to a durable prompt ref
//   3. timeout-returns-value - a broken transport makes poll() RETURN
//      ("unknown"/"failed"), never throw (the engine's sweep must survive)
//   4. telemetry - collect() yields usage (tokens + cost), a durable transcript
//      ref, and the worker's OUTCOME line (deck parity depends on this)
//   5. safety-policy enforcement - a policy-violating action is BLOCKED by the
//      adapter's NATIVE mechanism (hook / guard extension / sandbox)
//   6. dispose idempotency - dispose twice, no throw; evidence survives teardown
//
// The suite is shipped (not test-only) so a contributor adding a Codex adapter
// runs exactly this against their implementation. No test-framework dependency:
// call runConformance and render the returned checks however you like.

import * as fs from "node:fs";
import type { Harness, HarnessSession, HarnessWorkspace, SpawnRequest } from "./types.ts";
import { DEFAULT_DENY_COMMANDS } from "./types.ts";

/** The transport-side driver the caller provides: how to stand up a workspace,
 *  drive the (real or fake) worker to completion, break the transport, and
 *  attempt a policy violation through the worker's own action channel. */
export interface ConformanceWorld {
	harness: Harness;
	/** Fresh per-run workspace (a real git worktree makes the diff story honest). */
	makeWorkspace(): Promise<HarnessWorkspace>;
	/** Drive the running worker to completion; its final output MUST include
	 *  `OUTCOME: ${outcomeText}` delivered through the adapter's own channel. */
	completeRun(session: HarnessSession, outcomeText: string): Promise<void>;
	/** Break the transport under the session (kill the fake server, drop the pane
	 *  registry, …) so the next poll() cannot get an answer. */
	breakTransport(session: HarnessSession): Promise<void>;
	/** From INSIDE the worker's action channel, attempt (a) a write outside the
	 *  policy writeScopes and (b) a denied command. Return what got through. */
	attemptViolations(session: HarnessSession): Promise<{ writeBlocked: boolean; commandBlocked: boolean; detail: string }>;
	/** Model to request, when the harness supports selection. */
	model?: string;
}

export interface ConformanceCheck {
	id: string;
	ok: boolean;
	detail: string;
}

const POLL_TRIES = 50;
const POLL_GAP_MS = 100;

async function pollUntil(h: Harness, s: HarnessSession, want: string, tries = POLL_TRIES): Promise<string> {
	let last = "unknown";
	for (let i = 0; i < tries; i++) {
		last = (await h.poll(s)).state;
		if (last === want || last === "failed") return last;
		await new Promise((r) => setTimeout(r, POLL_GAP_MS));
	}
	return last;
}

/** Run the full conformance suite. Every check runs (no early bail) so a failing
 *  adapter gets the whole picture in one pass. */
export async function runConformance(world: ConformanceWorld): Promise<ConformanceCheck[]> {
	const h = world.harness;
	const checks: ConformanceCheck[] = [];
	const push = (id: string, ok: boolean, detail = "") => checks.push({ id, ok, detail });

	// ── happy path: spawn → working → complete → done → collect → dispose ──────
	const ws = await world.makeWorkspace();
	const CONSTRAINT_MARKER = "CONFORMANCE-CONSTRAINT-7f3a: file artifacts, never chat them.";
	const req: SpawnRequest = {
		workspace: ws,
		instruction: "Conformance run: no real work - follow the completion contract when told.",
		card: { id: ws.cardId, domain: "conformance", cardType: "ops" },
		runId: `${ws.cardId}-conformance-${Math.random().toString(36).slice(2, 8)}`,
		model: world.model,
		policy: { writeScopes: [ws.dir, ws.scopedDir], denyCommands: [...DEFAULT_DENY_COMMANDS] },
		constraints: CONSTRAINT_MARKER,
	};

	let session: HarnessSession | null = null;
	try {
		session = await h.spawn(req);
		push("spawn", true, `session ${session.runId}`);
	} catch (err) {
		push("spawn", false, String(err));
	}

	if (session) {
		push(
			"prompt-artifact",
			!!session.promptRef && fs.existsSync(session.promptRef) && fs.readFileSync(session.promptRef, "utf8").includes(req.instruction),
			session.promptRef,
		);

		// single-source constraints must be RENDERED into the worker's delivered
		// context and durably referenced (knowledge-layer contract).
		push(
			"constraints-rendered",
			!!session.constraintsRef && fs.existsSync(session.constraintsRef) && fs.readFileSync(session.constraintsRef, "utf8").includes(CONSTRAINT_MARKER),
			String(session.constraintsRef),
		);

		const pre = await h.poll(session);
		push("not-done-before-work", pre.state !== "done", `pre-completion poll: ${pre.state}`);

		// safety enforcement while the worker is live
		try {
			const v = await world.attemptViolations(session);
			push("policy-write-blocked", v.writeBlocked, v.detail);
			push("policy-command-blocked", v.commandBlocked, v.detail);
		} catch (err) {
			push("policy-write-blocked", false, `attemptViolations threw: ${String(err)}`);
			push("policy-command-blocked", false, `attemptViolations threw: ${String(err)}`);
		}

		await world.completeRun(session, "conformance artifact complete");
		const state = await pollUntil(h, session, "done");
		push("transition-to-done", state === "done", `post-completion poll: ${state}`);

		const artifacts = await h.collect(session);
		push("collect-outcome", artifacts.outcome.includes("conformance artifact complete"), artifacts.outcome);
		push(
			"collect-usage",
			!!artifacts.usage && artifacts.usage.costUsd >= 0 && artifacts.usage.tokensIn >= 0 && artifacts.usage.tokensOut >= 0,
			JSON.stringify(artifacts.usage),
		);
		push("collect-transcript-ref", !!artifacts.transcriptRef, String(artifacts.transcriptRef));
		push("collect-prompt-ref", artifacts.promptRef === session.promptRef && fs.existsSync(artifacts.promptRef), artifacts.promptRef);

		await h.dispose(session);
		await h.dispose(session); // idempotency
		push("dispose-idempotent", true, "dispose called twice without throw");
		push(
			"transcript-survives-dispose",
			!!artifacts.transcriptRef && fs.existsSync(artifacts.transcriptRef),
			String(artifacts.transcriptRef),
		);
	}

	// ── edge safety: a broken transport must not make poll() throw ──────────────
	const ws2 = await world.makeWorkspace();
	let session2: HarnessSession | null = null;
	try {
		session2 = await h.spawn({ ...req, workspace: ws2, runId: `${ws2.cardId}-edge`, card: { ...req.card, id: ws2.cardId } });
	} catch (err) {
		push("edge-spawn", false, String(err));
	}
	if (session2) {
		await world.breakTransport(session2);
		try {
			const p = await h.poll(session2);
			push("poll-returns-on-transport-failure", p.state === "unknown" || p.state === "failed", `state: ${p.state}`);
		} catch (err) {
			push("poll-returns-on-transport-failure", false, `poll THREW: ${String(err)}`);
		}
		try {
			await h.dispose(session2);
			push("dispose-survives-broken-transport", true);
		} catch (err) {
			push("dispose-survives-broken-transport", false, `dispose THREW: ${String(err)}`);
		}
	}

	return checks;
}
