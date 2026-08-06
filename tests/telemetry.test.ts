// telemetry.test.ts - StageEvent emission at the harness boundary. Proves:
//   • the pool's happy path emits started → passed(+usage/payload_ref) →
//     harvest → review-gate, every event valid against the wire schema;
//   • watchdog escalation emits failed → review-gate;
//   • DECK PARITY: the same card shape run through two differently-named fake
//     harnesses yields IDENTICAL event sequences except the `harness` field;
//   • the orchestrator emits approval-gate awaiting_human → passed and
//     classify started → passed around triage.
// Run via `node tests/telemetry.test.ts`.

import { execSync, type ExecSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CardEngine } from "../src/engine/core.ts";
import { gitWorktreeAdd } from "../src/engine/git-ops.ts";
import { Orchestrator } from "../src/engine/orchestrate.ts";
import { Reconciler } from "../src/engine/reconciler.ts";
import { WorkerPool } from "../src/engine/worker-pool.ts";
import { WorkspaceManager } from "../src/engine/workspace-manager.ts";
import { createStandaloneHost } from "../src/host/host.ts";
import type { Harness, HarnessArtifacts, HarnessSession, PollResult, SpawnRequest } from "../src/harness/types.ts";
import { RuleClassifier } from "../src/routing/classify.ts";
import { loadRoutingTable } from "../src/routing/table.ts";
import { validateFile } from "../src/schema/validate.ts";
import { MemorySink, type StageEvent } from "../src/telemetry/stage-events.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
	if (cond) {
		pass++;
		console.log(`  ✅ ${msg}`);
	} else {
		fail++;
		console.log(`  ❌ ${msg}`);
	}
}

const GIT: ExecSyncOptions = { encoding: "utf8", stdio: "pipe", timeout: 15_000 };
const SCHEMA_PATH = fileURLToPath(new URL("../schema/stage-event.schema.json", import.meta.url));

/** Per-block hermetic env: a REAL git repo (board root) + a scopedBase. */
function setup(): { root: string; cardsDir: string; scopedBase: string; cleanup: () => void } {
	const tmp = fs.mkdtempSync(join(tmpdir(), "telemetry-test-"));
	const root = join(tmp, "repo");
	const cardsDir = join(root, "cards");
	const scopedBase = join(tmp, "scoped");
	fs.mkdirSync(cardsDir, { recursive: true });
	execSync(`git init --initial-branch=main ${root}`, GIT);
	execSync(`git -C ${root} config user.email "test@telemetry.holdco"`, GIT);
	execSync(`git -C ${root} config user.name "Telemetry Test"`, GIT);
	fs.writeFileSync(join(root, "README.md"), "# Telemetry Test Repo\n");
	execSync(`git -C ${root} add -A`, GIT);
	execSync(`git -C ${root} commit -m "Init"`, GIT);
	return {
		root,
		cardsDir,
		scopedBase,
		cleanup: () => {
			try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
		},
	};
}

function mkCard(cardsDir: string, id: string, opts: { tier?: string } = {}): string {
	const file = join(cardsDir, `${id}.md`);
	const tierLine = opts.tier ? `tier: ${opts.tier}\n` : "";
	fs.writeFileSync(
		file,
		`---\ntype: card\nid: ${id}\ntitle: "card ${id}"\nstatus: Executing\ncard_type: research\ndomain: root\n${tierLine}---\n\n## Brief\ndo the thing for ${id}\n\n## Reconciler Log\n`,
	);
	return file;
}

// ── Lean FakeHarness (the worker-pool.test.ts pattern, trimmed) ──────────────

class FakeHarness implements Harness {
	readonly name: string;
	private readonly states = new Map<string, PollResult>();

	constructor(name = "fake") {
		this.name = name;
	}

	async spawn(req: SpawnRequest): Promise<HarnessSession> {
		const promptRef = join(req.workspace.scopedDir, "prompt.md");
		fs.writeFileSync(promptRef, req.instruction, "utf8");
		return { harness: this.name, cardId: req.workspace.cardId, runId: req.runId, promptRef, startedAt: Date.now() };
	}
	async inject(): Promise<boolean> {
		return true;
	}
	async poll(session: HarnessSession): Promise<PollResult> {
		return this.states.get(session.cardId) ?? { state: "working" };
	}
	async collect(session: HarnessSession): Promise<HarnessArtifacts> {
		return {
			outcome: "did the work",
			outputTail: "OUTCOME: did the work\n",
			usage: { tokensIn: 400, tokensOut: 56, costUsd: 0.0123 },
			transcriptRef: null,
			promptRef: session.promptRef,
			errorCount: 0,
		};
	}
	async dispose(): Promise<void> {}

	setDone(id: string): void {
		this.states.set(id, { state: "done" });
	}
	setUnknown(id: string): void {
		this.states.set(id, { state: "unknown" });
	}
}

function quietHost() {
	return createStandaloneHost({ quiet: true, sink: () => {} });
}

/** Pool rig with a MemorySink + real worktree for a card. */
function makeRig(cardsDir: string, scopedBase: string, fake: FakeHarness, opts: { watchdogMs?: number; now?: () => number; withWsMgr?: boolean } = {}) {
	const host = quietHost();
	const reconciler = new Reconciler(cardsDir);
	const sink = new MemorySink();
	const wsMgr = opts.withWsMgr === false ? undefined : new WorkspaceManager({ host, scopedBase });
	const pool = new WorkerPool({
		host,
		reconciler,
		harnesses: { [fake.name]: fake },
		defaultHarness: fake.name,
		maxSlots: 2,
		cardBudgetUsd: 1.0,
		watchdogMs: opts.watchdogMs ?? 600_000,
		wsMgr,
		now: opts.now,
		scopedBase,
		stageEvents: sink,
	});
	return { pool, sink, reconciler, wsMgr, host };
}

function injectWorktree(wsMgr: WorkspaceManager, root: string, scopedBase: string, id: string): string {
	const scopedDir = join(scopedBase, id);
	const worktree = join(scopedDir, "worktree");
	fs.mkdirSync(scopedDir, { recursive: true });
	const baseCommit = gitWorktreeAdd(root, "HEAD", worktree);
	wsMgr.lifecycleWorkspaces.set(id, {
		cardId: id,
		workspaceId: null,
		paneId: null,
		scopedDir,
		worktreePath: worktree,
		baseCommit,
		createdAt: Date.now(),
	});
	return worktree;
}

// ══════════════════════════════════════════════════════════════════════════════
// a. happy path: started → passed(+usage/payload_ref) → harvest → review-gate
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── a. pool happy path: started → passed → harvest → review-gate");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const fake = new FakeHarness("fake");
	const rig = makeRig(cardsDir, scopedBase, fake);
	const file = mkCard(cardsDir, "alpha", { tier: "workhorse" });
	rig.reconciler.snapshot.set("alpha", "Executing");
	const worktree = injectWorktree(rig.wsMgr!, root, scopedBase, "alpha");

	rig.pool.dispatch("alpha", file, { cwd: root });
	await rig.pool.settleLaunches();
	fs.writeFileSync(join(worktree, "note.md"), "worker output\n");
	fake.setDone("alpha");
	await rig.pool.sweep();

	const evs = rig.sink.events;
	ok(evs.length === 4, `exactly 4 events emitted (got ${evs.length})`);
	const [started, passed, harvest, gate] = evs;
	ok(started.stage === "worker" && started.status === "started" && started.node_type === "agent", "1st: worker node started");
	ok(started.harness === "fake" && started.card_id === "alpha", "started carries harness name + card_id");
	ok(started.node_id === `${started.run_id}:worker` && started.run_id.startsWith("alpha-"), "node_id = <runId>:worker on the per-spawn runId");
	ok(started.tier === "workhorse", "tier read from the card's `tier:` frontmatter");
	ok(typeof started.prompt_ref === "string" && started.prompt_ref.endsWith("prompt.md"), "started carries prompt_ref");
	ok(passed.status === "passed" && passed.node_id === started.node_id && passed.stage === "worker", "2nd: same worker node passed");
	ok(
		passed.usage?.tokens_in === 400 && passed.usage?.tokens_out === 56 && passed.usage?.cost_usd === 0.0123,
		"passed carries usage from artifacts.usage",
	);
	ok(passed.payload_ref === join(scopedBase, "alpha", "card.diff"), "passed payload_ref = the card.diff path");
	ok(
		harvest.node_type === "deterministic" && harvest.stage === "harvest" && harvest.status === "passed" && harvest.harness === null,
		"3rd: deterministic harvest node passed, harness null",
	);
	ok(harvest.node_id === `${started.run_id}:harvest` && harvest.payload_ref === passed.payload_ref, "harvest node carries the diff payload_ref");
	ok(
		gate.node_type === "gate" && gate.stage === "human-gate:review" && gate.status === "awaiting_human" && gate.harness === null,
		"4th: review gate awaiting_human (pool emits it - no landing event exists for Needs Review)",
	);
	ok(evs.every((e) => e.run_id === started.run_id), "all four events share the run_id");
	ok(evs.every((e) => typeof e.ts === "string" && !Number.isNaN(Date.parse(e.ts))), "every event carries an ISO ts");
	ok(evs.every((e) => validateFile(SCHEMA_PATH, e).valid), "every emitted event validates against stage-event.schema.json");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// b. watchdog escalation: started → failed (no usage) → review-gate
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── b. watchdog escalation: failed → review-gate");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	let clock = 1_000_000;
	const fake = new FakeHarness("fake");
	const rig = makeRig(cardsDir, scopedBase, fake, { watchdogMs: 10_000, now: () => clock, withWsMgr: false });
	const file = mkCard(cardsDir, "bravo");
	rig.reconciler.snapshot.set("bravo", "Executing");

	rig.pool.dispatch("bravo", file, { cwd: root });
	await rig.pool.settleLaunches();
	fake.setUnknown("bravo");
	clock += 60_000; // 60s of silence against a 10s watchdog
	await rig.pool.sweep();

	const evs = rig.sink.events;
	ok(evs.length === 3, `exactly 3 events emitted (got ${evs.length})`);
	const [started, failed, gate] = evs;
	ok(started.status === "started" && started.stage === "worker", "1st: worker started");
	ok(failed.status === "failed" && failed.node_id === started.node_id && failed.harness === "fake", "2nd: same worker node failed");
	ok(failed.usage === undefined, "watchdog failure carries NO usage (cost unknown)");
	ok(gate.stage === "human-gate:review" && gate.status === "awaiting_human" && gate.harness === null, "3rd: review gate awaiting_human");
	ok(evs.every((e) => validateFile(SCHEMA_PATH, e).valid), "every escalation event validates against the schema");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// c. DECK PARITY: two differently-named harnesses → identical sequences
//    except the `harness` field
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── c. deck parity: identical sequences from two adapters, `harness` aside");

	async function runOnce(harnessName: string): Promise<StageEvent[]> {
		const { root, cardsDir, scopedBase, cleanup } = setup();
		const fake = new FakeHarness(harnessName);
		const rig = makeRig(cardsDir, scopedBase, fake);
		const file = mkCard(cardsDir, "parity", { tier: "frontier" });
		rig.reconciler.snapshot.set("parity", "Executing");
		const worktree = injectWorktree(rig.wsMgr!, root, scopedBase, "parity");
		rig.pool.dispatch("parity", file, { cwd: root });
		await rig.pool.settleLaunches();
		fs.writeFileSync(join(worktree, "same-output.md"), "identical work\n");
		fake.setDone("parity");
		await rig.pool.sweep();
		cleanup();
		return rig.sink.events;
	}

	/** Strip run nonce, ts, tmp paths, and the harness field itself. */
	function normalize(evs: StageEvent[]): Record<string, unknown>[] {
		const runId = evs[0].run_id;
		return evs.map((e) => {
			const c: Record<string, unknown> = { ...e };
			c.run_id = e.run_id === runId ? "RUN" : e.run_id;
			c.node_id = e.node_id.split(runId).join("RUN");
			delete c.ts;
			delete c.harness;
			if (typeof c.prompt_ref === "string") c.prompt_ref = c.prompt_ref.replace(/^.*\/scoped\//, "SCOPED/");
			if (typeof c.payload_ref === "string") c.payload_ref = c.payload_ref.replace(/^.*\/scoped\//, "SCOPED/");
			return c;
		});
	}

	const a = await runOnce("harness-one");
	const b = await runOnce("harness-two");
	ok(a.length === 4 && b.length === 4, "both adapters emit 4 events");
	ok(JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)), "sequences IDENTICAL modulo run nonce/ts/paths/harness");
	ok(
		a.filter((e) => e.stage === "worker").every((e) => e.harness === "harness-one") &&
			b.filter((e) => e.stage === "worker").every((e) => e.harness === "harness-two"),
		"only the worker events' `harness` field names the adapter",
	);
	ok(
		a.concat(b)
			.filter((e) => e.stage !== "worker")
			.every((e) => e.harness === null),
		"harvest + gate events carry harness null under BOTH adapters",
	);
}

// ══════════════════════════════════════════════════════════════════════════════
// d. orchestrator: approval-gate awaiting_human → passed, classify started → passed
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── d. orchestrator: approval gate + classify events");
	const board = fs.mkdtempSync(join(tmpdir(), "telemetry-orch-"));
	const cards = join(board, "cards");
	fs.mkdirSync(cards, { recursive: true });
	fs.writeFileSync(join(board, "README.md"), "x\n");
	execSync("git init -qb main && git add -A && git -c user.name=t -c user.email=t@holdco.test commit -qm init", { cwd: board, stdio: "pipe" });

	const host = createStandaloneHost({
		flags: { "cards-dir": cards, "card-events-off": "true", "card-sweep-ms": "3600000" },
		quiet: true,
		sink: () => {},
	});
	const engine = new CardEngine(host, { cwd: board, noLease: true });
	engine.start();
	const sink = new MemorySink();
	const fake = new FakeHarness("fake");
	const scopedBase = join(board, ".scoped");
	const wsMgr = new WorkspaceManager({ host, scopedBase });
	const pool = new WorkerPool({
		host,
		reconciler: engine.reconciler!,
		harnesses: { fake },
		defaultHarness: "fake",
		maxSlots: 4,
		cardBudgetUsd: 5,
		watchdogMs: 60_000,
		wsMgr,
		scopedBase,
		stageEvents: sink,
	});
	const orch = new Orchestrator({
		host,
		engine,
		pool,
		wsMgr,
		cwd: board,
		classifier: new RuleClassifier(),
		routing: loadRoutingTable(board),
		stageEvents: sink,
	});
	orch.start(3_600_000); // subscriptions only; the 1h interval never fires

	// A card ARRIVES at Needs Approval (created after engine start → NEW_CARD landing).
	const file = join(cards, "golf.md");
	fs.writeFileSync(
		file,
		`---\ntype: card\nid: golf\ntitle: "Fix typo in docs"\nstatus: Needs Approval\ncard_type: maintenance\ndomain: root\n---\n\n## Brief\nrename the misspelled header\n\n## Reconciler Log\n`,
	);
	engine.runReconcile("sweep");
	const awaiting = sink.events.find((e) => e.node_id === "golf:approval-gate" && e.status === "awaiting_human");
	ok(awaiting !== undefined, "card:needs-approval landing → approval-gate awaiting_human");
	ok(
		awaiting?.node_type === "gate" && awaiting?.stage === "human-gate:approval" && awaiting?.harness === null,
		"approval gate is a harness-null gate node on stage human-gate:approval",
	);
	ok(awaiting?.run_id === "golf" && awaiting?.card_id === "golf", "engine-level events use the CARD id as run_id");

	// Human approves → Queued; drain: pass 1 intake, pass 2 classify + dispatch.
	fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^status:.*$/m, "status: Queued"));
	engine.runReconcile("sweep");
	await orch.drain();
	await new Promise((r) => setTimeout(r, 300));
	await orch.drain();
	await pool.settleLaunches();

	const seq = sink.events;
	const classifyStarted = seq.findIndex((e) => e.node_id === "golf:classify" && e.status === "started");
	const classifyPassed = seq.findIndex((e) => e.node_id === "golf:classify" && e.status === "passed");
	const approvalPassed = seq.findIndex((e) => e.node_id === "golf:approval-gate" && e.status === "passed");
	ok(classifyStarted !== -1 && classifyPassed !== -1, "classify node emits started then passed");
	ok(classifyStarted < classifyPassed, "classify started precedes passed");
	const cp = seq[classifyPassed];
	ok(cp.node_type === "agent" && cp.stage === "classify" && cp.tier === "workhorse", "classify passed carries the routed tier");
	ok(cp.model === undefined, "rules classifier → no model on the classify event");
	ok(approvalPassed !== -1, "Queued → Executing write emits approval-gate passed (approval consumed)");
	ok(seq[approvalPassed].harness === null && seq[approvalPassed].node_type === "gate", "approval-gate passed keeps the gate shape");
	ok(
		seq.some((e) => e.stage === "worker" && e.status === "started" && e.card_id === "golf"),
		"pool worker started follows (full funnel wired)",
	);
	ok(seq.every((e) => validateFile(SCHEMA_PATH, e).valid), "every orchestrator-path event validates against the schema");

	await orch.stop();
	engine.stop();
	fs.rmSync(board, { recursive: true, force: true });
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");
