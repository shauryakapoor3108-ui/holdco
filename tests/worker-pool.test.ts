// worker-pool.test.ts — drives the WorkerPool DIRECTLY (dispatch + sweep, no
// orchestrator) through the Harness seam under a controllable FakeHarness and a
// fake EngineHost. The old herdr/obs-driven transport mechanics moved into the
// adapters and are covered by tests/harness-pi.test.ts + tests/harness-claude-code.test.ts —
// they are NOT re-tested here. This suite proves the harness-NEUTRAL machinery:
// slot accounting, circuit breaker, budget kill, activity watchdog, the unified
// git-diff harvest, board-state writes, adapter selection + teardown.
// Run via `node tests/worker-pool.test.ts`.
//
// Every block that exercises the finalize diff harvest uses a REAL git repo +
// a REAL git worktree (gitWorktreeAdd) registered on a REAL WorkspaceManager in
// worktree-only mode (no herdr) — the harvest runs real `git add -A` +
// `git diff --staged <base>` against the worktree's creation base.

import { execSync, type ExecSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineHost } from "../src/host/host.ts";
import { gitWorktreeAdd } from "../src/engine/git-ops.ts";
import { Reconciler } from "../src/engine/reconciler.ts";
import { WorkerPool, type WorkerPoolDeps } from "../src/engine/worker-pool.ts";
import { WorkspaceManager } from "../src/engine/workspace-manager.ts";
import type {
	Harness,
	HarnessArtifacts,
	HarnessSession,
	PollResult,
	SpawnRequest,
} from "../src/harness/types.ts";

// ── Test harness ─────────────────────────────────────────────────────────────

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

/** Per-block hermetic environment: a REAL git repo (root = the board dir, holds
 *  cards/) + a scopedBase, all under one mkdtemp dir. */
function setup(): { root: string; cardsDir: string; scopedBase: string; cleanup: () => void } {
	const tmp = fs.mkdtempSync(join(tmpdir(), "wp-test-"));
	const root = join(tmp, "repo");
	const cardsDir = join(root, "cards");
	const scopedBase = join(tmp, "scoped");
	fs.mkdirSync(cardsDir, { recursive: true });
	execSync(`git init --initial-branch=main ${root}`, GIT);
	execSync(`git -C ${root} config user.email "test@wp.holdco"`, GIT);
	execSync(`git -C ${root} config user.name "WP Test"`, GIT);
	fs.mkdirSync(join(root, "knowledge"), { recursive: true });
	fs.writeFileSync(join(root, "knowledge", "FILING.md"), "# Filing\n");
	fs.writeFileSync(join(root, "README.md"), "# WP Test Repo\n");
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

function mkCard(cardsDir: string, id: string, opts: { cardType?: string; brief?: boolean; worker?: string } = {}): string {
	const file = join(cardsDir, `${id}.md`);
	const cardType = opts.cardType ?? "research";
	const brief = opts.brief ?? true;
	const workerLine = opts.worker ? `worker: ${opts.worker}\n` : "";
	fs.writeFileSync(
		file,
		`---\ntype: card\nid: ${id}\ntitle: "card ${id}"\nstatus: Executing\ncard_type: ${cardType}\ndomain: root\n${workerLine}---\n\n` +
			(brief ? `## Brief\ndo the thing for ${id}\n\n` : "") +
			`## Reconciler Log\n`,
	);
	return file;
}

const status = (file: string) => fs.readFileSync(file, "utf8").match(/^status:\s*(.*)$/m)![1].trim();
const fm = (file: string) => fs.readFileSync(file, "utf8");

// ── FakeHarness (the controllable Harness seam double) ──────────────────────
// spawn records the SpawnRequest + writes prompt.md into the scopedDir; the test
// controls per-card poll state / cost / activity and the artifacts collect()
// returns. spawn can be made to throw (the ONE verb allowed to).

class FakeHarness implements Harness {
	readonly name: string;
	readonly spawned: SpawnRequest[] = [];
	readonly disposed: HarnessSession[] = [];
	failSpawn = false;
	private readonly states = new Map<string, PollResult>();
	private readonly artifactOverrides = new Map<string, Partial<HarnessArtifacts>>();

	constructor(name = "fake") {
		this.name = name;
	}

	async spawn(req: SpawnRequest): Promise<HarnessSession> {
		if (this.failSpawn) throw new Error("fake harness refused to spawn");
		this.spawned.push(req);
		const promptRef = join(req.workspace.scopedDir, "prompt.md");
		fs.writeFileSync(promptRef, `# worker prompt for ${req.card.id} (run ${req.runId})\n\n${req.instruction}\n`, "utf8");
		return { harness: this.name, cardId: req.workspace.cardId, runId: req.runId, promptRef, startedAt: Date.now() };
	}

	async inject(): Promise<boolean> {
		return true;
	}

	async poll(session: HarnessSession): Promise<PollResult> {
		return this.states.get(session.cardId) ?? { state: "working" };
	}

	async collect(session: HarnessSession): Promise<HarnessArtifacts> {
		const over = this.artifactOverrides.get(session.cardId) ?? {};
		return {
			outcome: "did the work",
			outputTail: "boot\nwork\nOUTCOME: did the work\n",
			usage: { tokensIn: 400, tokensOut: 56, costUsd: 0.0123 },
			transcriptRef: null,
			promptRef: session.promptRef,
			errorCount: 0,
			...over,
		};
	}

	async dispose(session: HarnessSession): Promise<void> {
		this.disposed.push(session);
	}

	// ── test control surface ──
	setWorking(id: string): void {
		this.states.set(id, { ...this.states.get(id), state: "working" });
	}
	setDone(id: string): void {
		this.states.set(id, { ...this.states.get(id), state: "done" });
	}
	setFailed(id: string): void {
		this.states.set(id, { ...this.states.get(id), state: "failed" });
	}
	setUnknown(id: string): void {
		this.states.set(id, { ...this.states.get(id), state: "unknown" });
	}
	setCost(id: string, costUsd: number): void {
		const cur = this.states.get(id) ?? { state: "working" as const };
		this.states.set(id, { ...cur, costUsd });
	}
	setLastActivity(id: string, ts: number): void {
		const cur = this.states.get(id) ?? { state: "working" as const };
		this.states.set(id, { ...cur, lastActivityAt: ts });
	}
	setArtifacts(id: string, over: Partial<HarnessArtifacts>): void {
		this.artifactOverrides.set(id, over);
	}
	disposedFor(id: string): boolean {
		return this.disposed.some((s) => s.cardId === id);
	}
}

/** Captured fake host: pool notifications + events + log lines land here. */
function fakeHost() {
	const logged: any[] = [];
	const emitted: { event: string; payload: any }[] = [];
	const notices: { msg: string; level: string }[] = [];
	const host: EngineHost = {
		events: {
			emit(event, payload) {
				emitted.push({ event, payload });
			},
			on() {
				return () => {};
			},
		},
		log: {
			entry(_kind, data) {
				logged.push(data);
			},
		},
		config: { get: () => undefined },
		notify(msg, level) {
			notices.push({ msg, level });
		},
	};
	return { host, logged, emitted, notices };
}

interface PoolRig {
	pool: WorkerPool;
	fake: FakeHarness;
	reconciler: Reconciler;
	host: EngineHost;
	logged: any[];
	emitted: { event: string; payload: any }[];
	notices: { msg: string; level: string }[];
	wsMgr?: WorkspaceManager;
}

function makePool(
	cardsDir: string,
	scopedBase: string,
	opts: Partial<WorkerPoolDeps> & { withWsMgr?: boolean; fake?: FakeHarness } = {},
): PoolRig {
	const { host, logged, emitted, notices } = fakeHost();
	const fake = opts.fake ?? new FakeHarness("fake");
	const reconciler = new Reconciler(cardsDir);
	// worktree-only mode: NO herdr dep — the git worktree is the isolation primitive.
	const wsMgr = opts.withWsMgr ? new WorkspaceManager({ host, scopedBase }) : undefined;
	const deps: WorkerPoolDeps = {
		host,
		reconciler,
		harnesses: opts.harnesses ?? { [fake.name]: fake },
		defaultHarness: opts.defaultHarness ?? fake.name,
		maxSlots: opts.maxSlots ?? 2,
		cardBudgetUsd: opts.cardBudgetUsd ?? 1.0,
		watchdogMs: opts.watchdogMs ?? 600_000,
		wsMgr,
		now: opts.now,
		scopedBase,
	};
	return { pool: new WorkerPool(deps), fake, reconciler, host, logged, emitted, notices, wsMgr };
}

/** Inject a lifecycle worktree handle (a REAL git worktree) into wsMgr for a card —
 *  worktree-only mode, so workspaceId is null. */
function injectWorktree(rig: PoolRig, root: string, scopedBase: string, id: string): { worktree: string; baseCommit: string } {
	const scopedDir = join(scopedBase, id);
	const worktree = join(scopedDir, "worktree");
	fs.mkdirSync(scopedDir, { recursive: true });
	const baseCommit = gitWorktreeAdd(root, "HEAD", worktree);
	rig.wsMgr!.lifecycleWorkspaces.set(id, {
		cardId: id,
		workspaceId: null,
		paneId: null,
		scopedDir,
		worktreePath: worktree,
		baseCommit,
		createdAt: Date.now(),
	});
	return { worktree, baseCommit };
}

// ══════════════════════════════════════════════════════════════════════════════
// a. dispatch: synchronous slot reservation + EXEC_DISPATCH + the SpawnRequest
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── a. dispatch reserves slot synchronously + correct SpawnRequest through the seam");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { withWsMgr: true });
	const file = mkCard(cardsDir, "alpha");
	rig.reconciler.snapshot.set("alpha", "Executing");
	const { worktree } = injectWorktree(rig, root, scopedBase, "alpha");

	rig.pool.dispatch("alpha", file, { cwd: root });
	ok(rig.pool.freeSlots() === 1, "slot reserved SYNCHRONOUSLY (freeSlots 2 → 1 before settleLaunches)");
	ok(rig.logged.some((e) => e.event === "EXEC_DISPATCH" && e.card === "alpha" && e.harness === "fake"), "EXEC_DISPATCH logged with the harness name");
	await rig.pool.settleLaunches();

	ok(rig.fake.spawned.length === 1, "adapter spawn called exactly once");
	const req = rig.fake.spawned[0];
	ok(req.card.id === "alpha" && req.workspace.cardId === "alpha", "SpawnRequest carries the card id");
	ok(req.workspace.dir === worktree, "SpawnRequest workspace.dir IS the lifecycle worktree");
	ok(req.workspace.scopedDir === join(scopedBase, "alpha"), "SpawnRequest carries the scoped dir");
	ok(req.instruction.includes("do the thing for alpha"), "SpawnRequest instruction carries the brief");
	ok(typeof req.runId === "string" && req.runId.startsWith("alpha-"), "SpawnRequest carries the per-spawn runId nonce");
	ok(req.policy.writeScopes.includes(worktree) && req.policy.writeScopes.includes(join(scopedBase, "alpha")), "policy writeScopes = worktree + scoped dir");
	ok(req.policy.denyCommands.length > 0, "policy denyCommands is non-empty (default deny list)");
	ok(fs.existsSync(join(scopedBase, "alpha", "prompt.md")), "adapter wrote prompt.md into the scoped dir");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// b. done → finalize: real worktree diff harvest, board write, teardown
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── b. done → finalize (real git worktree diff harvest)");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { withWsMgr: true });
	const file = mkCard(cardsDir, "bravo");
	rig.reconciler.snapshot.set("bravo", "Executing");
	const { worktree } = injectWorktree(rig, root, scopedBase, "bravo");

	rig.pool.dispatch("bravo", file, { cwd: root });
	await rig.pool.settleLaunches();
	// The worker's "work": a REAL file into its worktree, then the adapter reports done.
	fs.writeFileSync(join(worktree, "knowledge", "analysis.md"), "# Analysis\nfindings\n");
	rig.fake.setDone("bravo");
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "card → Needs Review after harvest");
	const text = fm(file);
	ok(text.includes("cost_total: 0.0123") && text.includes("tokens: 456"), "cost/tokens from artifacts.usage written to frontmatter");
	ok(/^harness: fake$/m.test(text), "harness name annotated on the card");
	ok(text.includes("diff_status: changed (1 file(s))"), "diff_status: changed");
	ok(text.includes("## Diff") && text.includes("diff --git"), "card body carries a ## Diff section with the real diff");
	ok(!text.includes("no change produced"), "outcome NOT flagged no-change (a real diff was produced)");
	ok(!text.includes("review_flag"), "no review_flag (OUTCOME line present, zero errors)");
	const diffPath = join(scopedBase, "bravo", "card.diff");
	ok(fs.existsSync(diffPath) && fs.readFileSync(diffPath, "utf8").includes("analysis.md"), "card.diff written to the scoped dir");
	ok(rig.pool.freeSlots() === 2, "slot freed after finalize");
	ok(rig.emitted.some((e) => e.event === "exec:idle"), "exec:idle emitted (drain nudge)");
	ok(rig.fake.disposedFor("bravo"), "adapter dispose called after finalize");
	const events = rig.reconciler.reconcile("sweep");
	ok(!events.some((e) => e.event === "ILLEGAL_REVERT"), "snapshot synced — next reconcile sees no delta / no ILLEGAL_REVERT");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// c. clean-worktree completion → no-change flag
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── c. clean-worktree completion → outcome flagged, ## Diff says clean");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { withWsMgr: true });
	const file = mkCard(cardsDir, "charlie");
	rig.reconciler.snapshot.set("charlie", "Executing");
	injectWorktree(rig, root, scopedBase, "charlie");

	rig.pool.dispatch("charlie", file, { cwd: root });
	await rig.pool.settleLaunches();
	// The worker completes WITHOUT touching its worktree.
	rig.fake.setDone("charlie");
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "clean card → Needs Review");
	const text = fm(file);
	ok(text.includes("no change produced"), "outcome flagged `no change produced`");
	ok(text.includes("diff_status: clean"), "diff_status: clean");
	ok(text.includes("worktree clean — no changes produced"), "## Diff section says worktree clean");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// d. telemetry unavailable: artifacts.usage null → flagged, never fabricated
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── d. telemetry unavailable (usage null) → cost unknown + telemetry flag");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { withWsMgr: true });
	const file = mkCard(cardsDir, "delta");
	rig.reconciler.snapshot.set("delta", "Executing");
	const { worktree } = injectWorktree(rig, root, scopedBase, "delta");

	rig.pool.dispatch("delta", file, { cwd: root });
	await rig.pool.settleLaunches();
	fs.writeFileSync(join(worktree, "knowledge", "note.md"), "# note\n");
	rig.fake.setArtifacts("delta", { usage: null });
	rig.fake.setDone("delta");
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "telemetry-less card still finalizes to Needs Review");
	const text = fm(file);
	ok(text.includes('cost_total: "unknown (telemetry unavailable)"'), 'cost_total: "unknown (telemetry unavailable)"');
	ok(/^telemetry: unavailable$/m.test(text), "telemetry: unavailable annotation written");
	ok(text.includes("diff_status: changed (1 file(s))"), "diff harvest still runs without telemetry");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// e. no-brief card → straight to Needs Review, no spawn
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── e. no-brief card → Needs Review without spawning");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const file = mkCard(cardsDir, "echo", { brief: false });
	rig.reconciler.snapshot.set("echo", "Executing");

	rig.pool.dispatch("echo", file, { cwd: root });
	await rig.pool.settleLaunches();
	ok(status(file) === "Needs Review", "no-brief card → Needs Review");
	ok(fm(file).includes("no brief — nothing to execute"), "outcome explains the no-brief skip");
	ok(rig.fake.spawned.length === 0, "no worker spawned");
	ok(rig.pool.freeSlots() === 2, "no slot consumed");
	ok(rig.logged.some((e) => e.event === "EXEC_NO_BRIEF" && e.card === "echo"), "EXEC_NO_BRIEF logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// f. circuit breaker: 4th dispatch halts; clearDispatchCount resets
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── f. circuit breaker on the 4th dispatch; clearDispatchCount resets");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const file = mkCard(cardsDir, "foxtrot", { brief: false }); // no-brief: each dispatch is a clean non-spawning pass
	rig.reconciler.snapshot.set("foxtrot", "Executing");

	for (let i = 0; i < 3; i++) rig.pool.dispatch("foxtrot", file, { cwd: root });
	ok(!rig.logged.some((e) => e.event === "EXEC_CIRCUIT_BREAKER"), "first 3 dispatches pass the breaker");
	rig.pool.dispatch("foxtrot", file, { cwd: root });
	ok(rig.logged.some((e) => e.event === "EXEC_CIRCUIT_BREAKER" && e.card === "foxtrot"), "4th dispatch trips EXEC_CIRCUIT_BREAKER");
	const text = fm(file);
	ok(/^halt: true$/m.test(text), "breaker writes halt: true");
	ok(status(file) === "Needs Review", "breaker halts the card at Needs Review");

	rig.pool.clearDispatchCount("foxtrot");
	const before = rig.logged.filter((e) => e.event === "EXEC_CIRCUIT_BREAKER").length;
	rig.pool.dispatch("foxtrot", file, { cwd: root });
	ok(rig.logged.filter((e) => e.event === "EXEC_CIRCUIT_BREAKER").length === before, "clearDispatchCount resets the breaker (next dispatch passes)");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// g. isolation breach (HARDENING 1): wsMgr present, no lifecycle worktree
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── g. isolation breach: wsMgr present but no lifecycle worktree → quarantined");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { withWsMgr: true }); // wsMgr present, NO handle injected
	const file = mkCard(cardsDir, "golf");
	rig.reconciler.snapshot.set("golf", "Executing");

	rig.pool.dispatch("golf", file, { cwd: root });
	await rig.pool.settleLaunches();
	ok(status(file) === "Needs Review", "breach card quarantined to Needs Review");
	ok(fm(file).includes('review_flag: "isolation-breach"'), "review_flag: isolation-breach written");
	ok(rig.fake.spawned.length === 0, "no worker spawned on a breach");
	ok(rig.pool.freeSlots() === 2, "no slot consumed on a breach");
	ok(rig.logged.some((e) => e.event === "EXEC_ISOLATION_BREACH" && e.card === "golf"), "EXEC_ISOLATION_BREACH logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// h. unknown `worker:` harness name → loud escalation, no spawn
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── h. unknown `worker:` harness name → Needs Review, review_flag no-harness");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const file = mkCard(cardsDir, "hotel", { worker: "nosuch" });
	rig.reconciler.snapshot.set("hotel", "Executing");

	rig.pool.dispatch("hotel", file, { cwd: root });
	await rig.pool.settleLaunches();
	ok(status(file) === "Needs Review", "unknown-harness card → Needs Review (no stall in Executing)");
	const text = fm(file);
	ok(text.includes('review_flag: "no-harness"'), "review_flag: no-harness written");
	ok(text.includes('unknown harness \\"nosuch\\"') || text.includes("nosuch"), "outcome names the unregistered harness");
	ok(rig.fake.spawned.length === 0, "no worker spawned");
	ok(rig.pool.freeSlots() === 2, "no slot consumed");
	ok(rig.logged.some((e) => e.event === "EXEC_NO_HARNESS" && e.card === "hotel"), "EXEC_NO_HARNESS logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// i. budget kill: poll costUsd above cardBudgetUsd mid-run
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── i. budget kill: over-budget worker is killed → Needs Review");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { cardBudgetUsd: 1.0 });
	const file = mkCard(cardsDir, "india");
	rig.reconciler.snapshot.set("india", "Executing");

	rig.pool.dispatch("india", file, { cwd: root });
	await rig.pool.settleLaunches();
	rig.fake.setCost("india", 5.25); // way over the $1 cap
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "over-budget card → Needs Review");
	const text = fm(file);
	ok(text.includes('review_flag: "budget"'), "review_flag: budget written");
	ok(text.includes("budget exceeded"), "outcome carries the budget-kill reason");
	ok(text.includes("cost_total: 5.25"), "the observed cost is written to the card");
	ok(rig.fake.disposedFor("india"), "over-budget worker session disposed");
	ok(rig.pool.freeSlots() === 2, "slot freed after the kill");
	ok(rig.logged.some((e) => e.event === "EXEC_BUDGET_EXCEEDED" && e.card === "india"), "EXEC_BUDGET_EXCEEDED logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// j. watchdog: poll "unknown" + stale activity (injectable now) → escalated
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── j. watchdog: unknown poll + stale lastActivity → escalated");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	let clock = 1_000_000;
	const rig = makePool(cardsDir, scopedBase, { watchdogMs: 10_000, now: () => clock });
	const file = mkCard(cardsDir, "juliet");
	rig.reconciler.snapshot.set("juliet", "Executing");

	rig.pool.dispatch("juliet", file, { cwd: root });
	await rig.pool.settleLaunches();

	// "unknown" is a transport hiccup, not a verdict: with FRESH activity nothing happens.
	rig.fake.setUnknown("juliet");
	await rig.pool.sweep();
	ok(status(file) === "Executing" && rig.pool.hasSlot("juliet"), "unknown poll with fresh activity does NOT escalate");

	// Now the activity goes stale (the watchdog backstop): advance the injectable clock.
	clock += 60_000; // 60s of silence against a 10s watchdog
	await rig.pool.sweep();
	ok(status(file) === "Needs Review", "stale-activity card escalated to Needs Review");
	const text = fm(file);
	ok(text.includes('review_flag: "watchdog"'), "review_flag: watchdog written");
	ok(text.includes("no worker activity"), "outcome carries the no-activity reason");
	ok(rig.fake.disposedFor("juliet"), "watchdogged worker session disposed");
	ok(rig.pool.freeSlots() === 2, "slot freed after escalation");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// k. poll "failed" → terminal escalation
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── k. poll failed → escalated to Needs Review");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const file = mkCard(cardsDir, "kilo");
	rig.reconciler.snapshot.set("kilo", "Executing");

	rig.pool.dispatch("kilo", file, { cwd: root });
	await rig.pool.settleLaunches();
	rig.fake.setFailed("kilo");
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "failed worker → Needs Review");
	const text = fm(file);
	ok(text.includes('review_flag: "watchdog"') && text.includes("harness reported terminal failure"), "escalation flagged with the terminal-failure reason");
	ok(rig.fake.disposedFor("kilo"), "failed worker session disposed");
	ok(!rig.pool.hasSlot("kilo") && rig.pool.freeSlots() === 2, "slot freed after escalation");
	ok(rig.logged.some((e) => e.event === "EXEC_ESCALATED" && e.card === "kilo" && e.mechanism === "watchdog"), "EXEC_ESCALATED logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// l. spawn throws → failLaunch: escalate + free the slot + prune scoped dir
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── l. spawn throws → failLaunch → Needs Review, slot freed");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	rig.fake.failSpawn = true;
	const file = mkCard(cardsDir, "lima");
	rig.reconciler.snapshot.set("lima", "Executing");

	rig.pool.dispatch("lima", file, { cwd: root });
	ok(rig.pool.freeSlots() === 1, "slot reserved before the launch failure surfaces");
	await rig.pool.settleLaunches();
	ok(status(file) === "Needs Review", "failed launch → Needs Review");
	ok(fm(file).includes("worker launch failed"), "outcome carries the launch-failure reason");
	ok(rig.pool.freeSlots() === 2, "slot freed after failLaunch");
	ok(rig.emitted.some((e) => e.event === "exec:idle"), "exec:idle emitted after failLaunch");
	ok(!fs.existsSync(join(scopedBase, "lima")), "pre-lifecycle scoped dir pruned on launch failure (no wsMgr handle)");
	ok(rig.logged.some((e) => e.event === "EXEC_ESCALATED" && e.card === "lima" && e.mechanism === "launch-failure"), "EXEC_ESCALATED (launch-failure) logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// m. haltKill: active slot killed, session disposed, scoped dir pruned
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── m. haltKill: kills the active slot, disposes the session, prunes the scoped dir");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const file = mkCard(cardsDir, "mike");
	rig.reconciler.snapshot.set("mike", "Executing");

	rig.pool.dispatch("mike", file, { cwd: root });
	await rig.pool.settleLaunches();
	ok(rig.pool.hasSlot("mike") && fs.existsSync(join(scopedBase, "mike")), "worker live with a scoped dir before /halt");
	await rig.pool.haltKill("mike");
	ok(!rig.pool.hasSlot("mike") && rig.pool.freeSlots() === 2, "slot freed by haltKill");
	ok(rig.fake.disposedFor("mike"), "worker session disposed by haltKill");
	ok(!fs.existsSync(join(scopedBase, "mike")), "scoped dir pruned (halt = deliberate kill)");
	ok(rig.logged.some((e) => e.event === "EXEC_HALT_KILL" && e.card === "mike"), "EXEC_HALT_KILL logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// n. per-card `worker:` frontmatter selects the harness from the registry
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── n. per-card `worker:` field selects the adapter from the registry");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const fakeA = new FakeHarness("fake");
	const fakeB = new FakeHarness("other");
	const rig = makePool(cardsDir, scopedBase, {
		fake: fakeA,
		harnesses: { fake: fakeA, other: fakeB },
		defaultHarness: "fake",
	});
	const fileB = mkCard(cardsDir, "november", { worker: "other" });
	const fileA = mkCard(cardsDir, "oscar"); // no worker: field → pool default
	rig.reconciler.snapshot.set("november", "Executing");
	rig.reconciler.snapshot.set("oscar", "Executing");

	rig.pool.dispatch("november", fileB, { cwd: root });
	rig.pool.dispatch("oscar", fileA, { cwd: root });
	await rig.pool.settleLaunches();

	ok(fakeB.spawned.length === 1 && fakeB.spawned[0].card.id === "november", "worker: other → the `other` adapter spawned november");
	ok(fakeA.spawned.length === 1 && fakeA.spawned[0].card.id === "oscar", "no worker: field → the default adapter spawned oscar");
	ok(rig.logged.some((e) => e.event === "EXEC_DISPATCH" && e.card === "november" && e.harness === "other"), "EXEC_DISPATCH names the selected harness");

	// Completion is finalized through the SELECTED adapter and annotated with its name.
	fakeB.setDone("november");
	await rig.pool.sweep();
	ok(/^harness: other$/m.test(fm(fileB)), "finalize annotates the selected harness name");
	ok(fakeB.disposedFor("november") && !fakeA.disposedFor("november"), "the selected adapter (not the default) is disposed");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// o. no-outcome-line review flag when outputTail lacks an OUTCOME line
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── o. outputTail without an OUTCOME line → review_flag no-outcome-line");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { withWsMgr: true });
	const file = mkCard(cardsDir, "papa");
	rig.reconciler.snapshot.set("papa", "Executing");
	const { worktree } = injectWorktree(rig, root, scopedBase, "papa");

	rig.pool.dispatch("papa", file, { cwd: root });
	await rig.pool.settleLaunches();
	fs.writeFileSync(join(worktree, "knowledge", "papa.md"), "# papa\n");
	rig.fake.setArtifacts("papa", { outcome: "did stuff (fallback tail)", outputTail: "did stuff but never printed the marker line\n" });
	rig.fake.setDone("papa");
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "card still finalizes to Needs Review");
	ok(fm(file).includes('review_flag: "no-outcome-line"'), "review_flag: no-outcome-line written");
	cleanup();
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");
