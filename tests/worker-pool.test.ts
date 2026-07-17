// worker-pool.test.ts — drives the WorkerPool DIRECTLY (dispatch + sweep, no index.ts
// orchestration) under a fake EngineHost, a COCKPIT-aware fake herdr, and a fake obs
// client. Worker completion is simulated the selftest way: the worker's labelled pane
// output is set via setLabelOutput (the pool re-resolves pane ids by STABLE label each
// tick) and the sweep detects the concrete sentinel.
// Run via `node tests/worker-pool.test.ts`.
//
// Every block that must exercise the finalize diff harvest uses a REAL git repo +
// a REAL git worktree (gitWorktreeAdd) — the harvest runs real `git add -A` +
// `git diff --staged <base>` against the worktree's creation base.

import { execSync, type ExecSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineHost } from "../src/host/host.ts";
import { gitWorktreeAdd } from "../src/engine/git-ops.ts";
import type { HerdrAdapter } from "../src/engine/herdr-adapter.ts";
import type { ObsClient } from "../src/engine/obs-client.ts";
import { Reconciler } from "../src/engine/reconciler.ts";
import { WorkerPool, workerLabel, type WorkerPoolDeps } from "../src/engine/worker-pool.ts";
import { WorkspaceManager } from "../src/engine/workspace-manager.ts";

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

/** Per-block hermetic environment: a REAL git repo (root = the board/vault dir, holds
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

// ── Fakes (the selftest IdxFakeHerdr / IdxFakeObs patterns, host-notify adapted) ──

interface FPane { id: string; label?: string; tabId: string; wsId: string; state: string }
/** COCKPIT-aware fake herdr: ONE cockpit workspace whose owner pane is the root; workers are
 *  labelled splits (worker:<id>). Worker output is addressed by the STABLE label — the pool
 *  re-resolves the pane id each tick — so tests use setLabelOutput(workerLabel(id)). */
class FakeHerdr {
	closed: string[] = []; // WORKSPACE closes (the pool no longer does these; wsMgr still can)
	paneCloses: string[] = []; // PANE closes (the cockpit teardown path)
	runCmds: { pane: string; cmd: string }[] = [];
	paneOutputs = new Map<string, string>();
	labelOutputs = new Map<string, string>();
	failSplit = false; // paneSplit returns null (cockpit placement failure)
	emptyList = false; // paneList returns [] (transient herdr read failure)
	waitOutputResult = true; // claude-driver `herdr wait output` outcome
	waitOutputCalls: { pane: string; match: string; timeoutMs: number }[] = [];
	private pseq = 0;
	private wseq = 0;
	private wsLabels = new Map<string, string>();
	private panes: FPane[] = [];
	async workspaceCreate(label: string) {
		const wsId = `ws${++this.wseq}`;
		this.wsLabels.set(wsId, label);
		const id = `p${++this.pseq}`;
		this.panes.push({ id, tabId: `${wsId}:1`, wsId, state: "unknown" });
		return { ok: true, workspaceId: wsId, paneId: id };
	}
	async workspaceList() {
		return [...this.wsLabels].map(([workspace_id, label]) => ({ workspace_id, label }));
	}
	async workspaceClose(id: string) {
		this.closed.push(id);
		this.wsLabels.delete(id);
		this.panes = this.panes.filter((p) => p.wsId !== id);
		return true;
	}
	async paneList(workspaceId?: string) {
		if (this.emptyList) return [];
		return this.panes
			.filter((p) => !workspaceId || p.wsId === workspaceId)
			.map((p) => ({ pane_id: p.id, agent_status: p.state, label: p.label, tab_id: p.tabId, workspace_id: p.wsId }));
	}
	async tabList(workspaceId?: string) {
		const tabs = new Map<string, { label: string; count: number }>();
		for (const p of this.panes) {
			if (workspaceId && p.wsId !== workspaceId) continue;
			const t = tabs.get(p.tabId) ?? { label: p.tabId.endsWith(":1") ? "1" : "bench", count: 0 };
			t.count++;
			tabs.set(p.tabId, t);
		}
		return [...tabs].map(([tab_id, v]) => ({ tab_id, label: v.label, pane_count: v.count }));
	}
	async paneSplit(paneId: string, _direction: "right" | "down", _cwd?: string) {
		if (this.failSplit) return null;
		const anchor = this.panes.find((p) => p.id === paneId);
		if (!anchor) return null;
		const id = `p${++this.pseq}`;
		this.panes.push({ id, tabId: anchor.tabId, wsId: anchor.wsId, state: "unknown" });
		return id;
	}
	async tabCreate(workspaceId: string, _label: string, _cwd?: string) {
		const id = `p${++this.pseq}`;
		this.panes.push({ id, tabId: `${workspaceId}:bench`, wsId: workspaceId, state: "unknown" });
		return { tabId: `${workspaceId}:bench`, paneId: id };
	}
	async paneRename(paneId: string, label: string) {
		const p = this.panes.find((x) => x.id === paneId);
		if (p) p.label = label;
		return true;
	}
	async paneReportAgent(paneId: string, _s: string, _a: string, state: string) {
		const p = this.panes.find((x) => x.id === paneId);
		if (p) p.state = state;
		return true;
	}
	async paneClose(paneId: string) {
		this.paneCloses.push(paneId);
		this.panes = this.panes.filter((p) => p.id !== paneId);
		return true;
	}
	async paneRun(pane: string, cmd: string) {
		this.runCmds.push({ pane, cmd });
		return true;
	}
	async paneSendText() {
		return true;
	}
	async paneSendKeys() {
		return true;
	}
	async paneRead(pane: string) {
		const p = this.panes.find((x) => x.id === pane);
		if (p?.label && this.labelOutputs.has(p.label)) return this.labelOutputs.get(p.label)!;
		return this.paneOutputs.get(pane) ?? "";
	}
	async paneAgentStatus() {
		return "idle";
	}
	async waitOutput(pane: string, match: string, timeoutMs: number) {
		this.waitOutputCalls.push({ pane, match, timeoutMs });
		return this.waitOutputResult;
	}
	// ── test helpers ──
	setLabelOutput(label: string, text: string) {
		this.labelOutputs.set(label, text);
	}
	workerPane(cardId: string): string | undefined {
		return this.panes.find((p) => p.label === `worker:${cardId}`)?.id;
	}
	removePane(label: string) {
		this.panes = this.panes.filter((p) => p.label !== label);
	}
}

class FakeObs {
	defaultSession: string | null = "sess";
	stats = new Map<string, { ok: boolean; stats: any }>();
	async resolveSessionIdByTag() {
		return this.defaultSession;
	}
	async getStats(sid: string) {
		return this.stats.get(sid) ?? { ok: false, stats: null };
	}
	async health() {
		return true;
	}
}

/** Captured fake host: pool notifications land here (no Pi ctx.ui anymore). */
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
	herdr: FakeHerdr;
	obs: FakeObs;
	reconciler: Reconciler;
	host: EngineHost;
	logged: any[];
	emitted: { event: string; payload: any }[];
	notices: { msg: string; level: string }[];
	wsMgr?: WorkspaceManager;
}

function makePool(cardsDir: string, scopedBase: string, opts: Partial<WorkerPoolDeps> & { withWsMgr?: boolean; hostBits?: ReturnType<typeof fakeHost> } = {}): PoolRig {
	const { host, logged, emitted, notices } = opts.hostBits ?? fakeHost();
	const herdr = new FakeHerdr();
	const obs = new FakeObs();
	const reconciler = new Reconciler(cardsDir);
	const wsMgr = opts.withWsMgr ? new WorkspaceManager({ host, herdr: herdr as unknown as HerdrAdapter, scopedBase }) : undefined;
	const deps: WorkerPoolDeps = {
		host,
		reconciler,
		herdr: herdr as unknown as HerdrAdapter,
		obs: obs as unknown as ObsClient,
		obsToken: "test-token",
		obsServerUrl: "http://127.0.0.1:0",
		maxSlots: opts.maxSlots ?? 2,
		cardBudgetUsd: opts.cardBudgetUsd ?? 1.0,
		watchdogMs: opts.watchdogMs ?? 600_000,
		wsMgr,
		now: opts.now ?? (() => Date.now()),
		sleep: () => Promise.resolve(),
		scopedBase,
		slug: "t",
	};
	return { pool: new WorkerPool(deps), herdr, obs, reconciler, host, logged, emitted, notices, wsMgr };
}

/** Fresh obs stats blob (fresh latest_ts so the watchdog stays quiet). */
function freshStats(cost: number, tokens: number, now = Date.now()) {
	return { ok: true, stats: { total_cost: cost, total_tokens: tokens, error_count: 0, latest_ts: new Date(now).toISOString() } };
}

/** Inject a lifecycle worktree handle (a REAL git worktree) into wsMgr for a card. */
function injectWorktree(rig: PoolRig, root: string, scopedBase: string, id: string): { worktree: string; baseCommit: string } {
	const scopedDir = join(scopedBase, id);
	const worktree = join(scopedDir, "worktree");
	fs.mkdirSync(scopedDir, { recursive: true });
	const baseCommit = gitWorktreeAdd(root, "HEAD", worktree);
	rig.wsMgr!.lifecycleWorkspaces.set(id, {
		cardId: id,
		workspaceId: `ws-${id}`,
		paneId: null,
		scopedDir,
		worktreePath: worktree,
		baseCommit,
		createdAt: Date.now(),
	});
	return { worktree, baseCommit };
}

// ══════════════════════════════════════════════════════════════════════════════
// a. dispatch: synchronous slot reservation, launch command, task.md contract
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── a. dispatch reserves slot synchronously + launch command + task.md");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const file = mkCard(cardsDir, "alpha");
	rig.reconciler.snapshot.set("alpha", "Executing");

	rig.pool.dispatch("alpha", file, { cwd: root });
	ok(rig.pool.freeSlots() === 1, "slot reserved SYNCHRONOUSLY (freeSlots 2 → 1 before settleLaunches)");
	ok(rig.logged.some((e) => e.event === "EXEC_DISPATCH" && e.card === "alpha"), "EXEC_DISPATCH logged");
	await rig.pool.settleLaunches();

	const cmd = rig.herdr.runCmds[0]?.cmd ?? "";
	ok(cmd.includes("pi --no-extensions"), "launch command spawns an execution-only Pi worker (pi --no-extensions)");
	ok(cmd.includes("HOLDCO_CARD_DIR="), "launch command exports HOLDCO_CARD_DIR (worker-guard scope)");
	ok(cmd.includes("run:"), "launch command carries the per-spawn run: correlation tag");

	const task = fs.readFileSync(join(scopedBase, "alpha", "task.md"), "utf8");
	ok(task.includes("<<CARD-DONE:CARDID>>>"), "task.md describes the sentinel with the CARDID placeholder");
	ok(!task.includes("<<CARD-DONE:alpha>>>"), "task.md NEVER contains the concrete sentinel (echo false-positive defeated)");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// b. sentinel completion → finalize: real worktree diff harvest, board write, teardown
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── b. sentinel completion → finalize (real git worktree diff harvest)");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { withWsMgr: true });
	const file = mkCard(cardsDir, "bravo");
	rig.reconciler.snapshot.set("bravo", "Executing");
	const { worktree } = injectWorktree(rig, root, scopedBase, "bravo");
	rig.obs.stats.set("sess", freshStats(0.0123, 456));

	rig.pool.dispatch("bravo", file, { cwd: root });
	await rig.pool.settleLaunches();
	// The worker writes a REAL file into its worktree, then emits the sentinel.
	fs.writeFileSync(join(worktree, "knowledge", "analysis.md"), "# Analysis\nfindings\n");
	rig.herdr.setLabelOutput(workerLabel("bravo"), `boot\nwork\nOUTCOME: did the analysis\n<<CARD-DONE:bravo>>>`);
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "card → Needs Review after harvest");
	const text = fm(file);
	ok(text.includes("cost_total: 0.0123") && text.includes("tokens: 456"), "cost/tokens from fake obs written to frontmatter");
	ok(text.includes("diff_status: changed (1 file(s))"), "diff_status: changed");
	ok(text.includes("## Diff") && text.includes("diff --git"), "card body carries a ## Diff section with the real diff");
	ok(!text.includes("no change produced"), "outcome NOT flagged no-change (a real diff was produced)");
	const diffPath = join(scopedBase, "bravo", "card.diff");
	ok(fs.existsSync(diffPath) && fs.readFileSync(diffPath, "utf8").includes("analysis.md"), "card.diff written to the scoped dir");
	ok(rig.pool.freeSlots() === 2, "slot freed after finalize");
	ok(rig.emitted.some((e) => e.event === "exec:idle"), "exec:idle emitted (drain nudge)");
	ok(rig.herdr.paneCloses.length > 0, "worker pane closed (cockpit teardown)");
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
	rig.obs.stats.set("sess", freshStats(0.01, 10));

	rig.pool.dispatch("charlie", file, { cwd: root });
	await rig.pool.settleLaunches();
	// The worker completes WITHOUT touching its worktree.
	rig.herdr.setLabelOutput(workerLabel("charlie"), `OUTCOME: nothing to do\n<<CARD-DONE:charlie>>>`);
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "clean card → Needs Review");
	const text = fm(file);
	ok(text.includes("no change produced"), "outcome flagged `no change produced`");
	ok(text.includes("diff_status: clean"), "diff_status: clean");
	ok(text.includes("worktree clean — no changes produced"), "## Diff section says worktree clean");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// d. no-brief card → straight to Needs Review, no spawn
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── d. no-brief card → Needs Review without spawning");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const file = mkCard(cardsDir, "delta", { brief: false });
	rig.reconciler.snapshot.set("delta", "Executing");

	rig.pool.dispatch("delta", file, { cwd: root });
	await rig.pool.settleLaunches();
	ok(status(file) === "Needs Review", "no-brief card → Needs Review");
	ok(fm(file).includes("no brief — nothing to execute"), "outcome explains the no-brief skip");
	ok(rig.herdr.runCmds.length === 0, "no worker spawned");
	ok(rig.pool.freeSlots() === 2, "no slot consumed");
	ok(rig.logged.some((e) => e.event === "EXEC_NO_BRIEF" && e.card === "delta"), "EXEC_NO_BRIEF logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// e. circuit breaker: 4th dispatch halts; clearDispatchCount resets
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── e. circuit breaker on the 4th dispatch; clearDispatchCount resets");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const file = mkCard(cardsDir, "echo", { brief: false }); // no-brief: each dispatch is a clean non-spawning pass
	rig.reconciler.snapshot.set("echo", "Executing");

	for (let i = 0; i < 3; i++) rig.pool.dispatch("echo", file, { cwd: root });
	ok(!rig.logged.some((e) => e.event === "EXEC_CIRCUIT_BREAKER"), "first 3 dispatches pass the breaker");
	rig.pool.dispatch("echo", file, { cwd: root });
	ok(rig.logged.some((e) => e.event === "EXEC_CIRCUIT_BREAKER" && e.card === "echo"), "4th dispatch trips EXEC_CIRCUIT_BREAKER");
	const text = fm(file);
	ok(/^halt: true$/m.test(text), "breaker writes halt: true");
	ok(status(file) === "Needs Review", "breaker halts the card at Needs Review");

	rig.pool.clearDispatchCount("echo");
	const before = rig.logged.filter((e) => e.event === "EXEC_CIRCUIT_BREAKER").length;
	rig.pool.dispatch("echo", file, { cwd: root });
	ok(rig.logged.filter((e) => e.event === "EXEC_CIRCUIT_BREAKER").length === before, "clearDispatchCount resets the breaker (next dispatch passes)");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// f. isolation breach (HARDENING 1): wsMgr present, no lifecycle worktree
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── f. isolation breach: wsMgr present but no lifecycle worktree → quarantined");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { withWsMgr: true }); // wsMgr present, NO handle injected
	const file = mkCard(cardsDir, "foxtrot");
	rig.reconciler.snapshot.set("foxtrot", "Executing");

	rig.pool.dispatch("foxtrot", file, { cwd: root });
	await rig.pool.settleLaunches();
	ok(status(file) === "Needs Review", "breach card quarantined to Needs Review");
	ok(fm(file).includes('review_flag: "isolation-breach"'), "review_flag: isolation-breach written");
	ok(rig.herdr.runCmds.length === 0, "no worker spawned on a breach");
	ok(rig.pool.freeSlots() === 2, "no slot consumed on a breach");
	ok(rig.logged.some((e) => e.event === "EXEC_ISOLATION_BREACH" && e.card === "foxtrot"), "EXEC_ISOLATION_BREACH logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// g. budget kill: obs cost above cardBudgetUsd mid-run
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── g. budget kill: over-budget worker is killed → Needs Review");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { cardBudgetUsd: 1.0 });
	const file = mkCard(cardsDir, "golf");
	rig.reconciler.snapshot.set("golf", "Executing");

	rig.pool.dispatch("golf", file, { cwd: root });
	await rig.pool.settleLaunches();
	rig.obs.stats.set("sess", freshStats(5.25, 1000)); // way over the $1 cap
	const panesBefore = rig.herdr.paneCloses.length;
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "over-budget card → Needs Review");
	const text = fm(file);
	ok(text.includes('review_flag: "budget"'), "review_flag: budget written");
	ok(text.includes("budget exceeded"), "outcome carries the budget-kill reason");
	ok(rig.herdr.paneCloses.length > panesBefore, "over-budget worker pane closed");
	ok(rig.pool.freeSlots() === 2, "slot freed after the kill");
	ok(rig.logged.some((e) => e.event === "EXEC_BUDGET_EXCEEDED" && e.card === "golf"), "EXEC_BUDGET_EXCEEDED logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// h. watchdog: stale obs latest_ts → escalated
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── h. watchdog: stale obs latest_ts → escalated");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const fixedNow = Date.now();
	const rig = makePool(cardsDir, scopedBase, { watchdogMs: 10_000, now: () => fixedNow });
	const file = mkCard(cardsDir, "hotel");
	rig.reconciler.snapshot.set("hotel", "Executing");

	rig.pool.dispatch("hotel", file, { cwd: root });
	await rig.pool.settleLaunches();
	// Cheap but STALE telemetry: last activity 60s ago against a 10s watchdog.
	rig.obs.stats.set("sess", freshStats(0.01, 10, fixedNow - 60_000));
	await rig.pool.sweep();

	ok(status(file) === "Needs Review", "stale-obs card escalated to Needs Review");
	const text = fm(file);
	ok(text.includes('review_flag: "watchdog"'), "review_flag: watchdog written");
	ok(text.includes("obs latest_ts stale"), "outcome carries the stale-obs reason");
	ok(rig.pool.freeSlots() === 2, "slot freed after escalation");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// i. dead-pane watchdog: gone from a NON-EMPTY list escalates; an EMPTY list does not
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── i. dead-pane watchdog: non-empty-list omission escalates; empty list is transient");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	rig.obs.defaultSession = null; // no obs session → budget/stale-obs phases stay quiet
	const file = mkCard(cardsDir, "india");
	rig.reconciler.snapshot.set("india", "Executing");

	rig.pool.dispatch("india", file, { cwd: root });
	await rig.pool.settleLaunches();

	// Transient herdr read failure: paneList returns [] → must NOT escalate.
	rig.herdr.emptyList = true;
	await rig.pool.sweep();
	ok(status(file) === "Executing", "EMPTY pane list (transient herdr failure) does NOT escalate");
	ok(rig.pool.hasSlot("india"), "slot survives the transient empty read");
	rig.herdr.emptyList = false;

	// Genuine omission: the worker's pane vanished from a NON-EMPTY list (owner pane remains).
	rig.herdr.removePane(workerLabel("india"));
	await rig.pool.sweep();
	ok(status(file) === "Needs Review", "pane gone from a NON-EMPTY list → escalated to Needs Review");
	const text = fm(file);
	ok(text.includes('review_flag: "watchdog"') && text.includes("worker pane gone from cockpit"), "watchdog flag + dead-pane reason written");
	ok(!rig.pool.hasSlot("india"), "slot freed after the dead-pane escalation");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// j. failLaunch: cockpit placement failure
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── j. failLaunch: cockpit placement failure → Needs Review, slot freed");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	rig.herdr.failSplit = true; // paneSplit → null → place() fails
	const file = mkCard(cardsDir, "juliet");
	rig.reconciler.snapshot.set("juliet", "Executing");

	rig.pool.dispatch("juliet", file, { cwd: root });
	ok(rig.pool.freeSlots() === 1, "slot reserved before the launch failure surfaces");
	await rig.pool.settleLaunches();
	ok(status(file) === "Needs Review", "failed launch → Needs Review");
	ok(fm(file).includes("worker launch failed"), "outcome carries the launch-failure reason");
	ok(rig.pool.freeSlots() === 2, "slot freed after failLaunch");
	ok(rig.emitted.some((e) => e.event === "exec:idle"), "exec:idle emitted after failLaunch");
	ok(!fs.existsSync(join(scopedBase, "juliet")), "pre-lifecycle scoped dir pruned on launch failure (no wsMgr handle)");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// k. haltKill: active slot killed, pane closed, scoped dir pruned
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── k. haltKill: kills the active slot, closes the pane, prunes the scoped dir");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const file = mkCard(cardsDir, "kilo");
	rig.reconciler.snapshot.set("kilo", "Executing");

	rig.pool.dispatch("kilo", file, { cwd: root });
	await rig.pool.settleLaunches();
	ok(rig.pool.hasSlot("kilo") && fs.existsSync(join(scopedBase, "kilo")), "worker live with a scoped dir before /halt");
	const panesBefore = rig.herdr.paneCloses.length;
	await rig.pool.haltKill("kilo");
	ok(!rig.pool.hasSlot("kilo") && rig.pool.freeSlots() === 2, "slot freed by haltKill");
	ok(rig.herdr.paneCloses.length > panesBefore, "worker pane closed by haltKill");
	ok(!fs.existsSync(join(scopedBase, "kilo")), "scoped dir pruned (halt = deliberate kill)");
	ok(rig.logged.some((e) => e.event === "EXEC_HALT_KILL" && e.card === "kilo"), "EXEC_HALT_KILL logged");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// l. claude driver: launch command, sentinel placeholder discipline, harvest + timeout
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── l. claude driver: pane-peer launch + wait-output completion + diff harvest");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase, { withWsMgr: true });
	const file = mkCard(cardsDir, "lima", { worker: "claude" });
	rig.reconciler.snapshot.set("lima", "Executing");
	const { worktree } = injectWorktree(rig, root, scopedBase, "lima");
	// The worker's edits + completion output exist before the (fake, instant) wait resolves.
	fs.writeFileSync(join(worktree, "knowledge", "claude-note.md"), "# Note\n");
	rig.herdr.setLabelOutput(workerLabel("lima"), `working...\nOUTCOME: claude did it\nFLEET_DONE_lima`);

	rig.pool.dispatch("lima", file, { cwd: root });
	await rig.pool.settleLaunches(); // the claude path finalizes inside its own launch promise

	const cmd = rig.herdr.runCmds[0]?.cmd ?? "";
	ok(cmd.includes("claude --dangerously-skip-permissions"), "claude launch command uses the REPL initial-prompt form");
	ok(!cmd.includes("FLEET_DONE_lima"), "concrete FLEET_DONE sentinel NEVER appears in the launch prompt");
	ok(cmd.includes("FLEET_DONE_<CARDID>"), "prompt describes the sentinel with the <CARDID> placeholder");
	ok(rig.herdr.waitOutputCalls.some((c) => c.match === "FLEET_DONE_lima"), "wait output level-scans for the concrete sentinel");
	ok(status(file) === "Needs Review", "claude completion → Needs Review");
	const text = fm(file);
	ok(text.includes('cost_total: "unknown (telemetry unavailable)"'), "claude worker finalizes with telemetry unavailable (no obs)");
	ok(text.includes("diff_status: changed (1 file(s))"), "claude worktree diff harvested (real git)");
	ok(text.includes("## Diff") && text.includes("claude-note.md"), "## Diff section carries the claude diff");
	ok(!rig.pool.hasSlot("lima"), "claude slot freed after finalize");

	// Timeout path: waitOutput resolves false → the one watchdog escalation route.
	const rig2 = makePool(cardsDir, scopedBase, { watchdogMs: 10_000 });
	rig2.herdr.waitOutputResult = false;
	const file2 = mkCard(cardsDir, "mike", { worker: "claude" });
	rig2.reconciler.snapshot.set("mike", "Executing");
	rig2.pool.dispatch("mike", file2, { cwd: root });
	await rig2.pool.settleLaunches();
	ok(status(file2) === "Needs Review", "claude wait-output timeout → escalated to Needs Review");
	ok(fm(file2).includes('review_flag: "watchdog"') && fm(file2).includes("did not signal done"), "timeout escalation flagged watchdog");
	cleanup();
}

// ══════════════════════════════════════════════════════════════════════════════
// m. buildWorkerTask: CODE vs ARTIFACT contract + placeholder discipline
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── m. task.md contract: CODE (ops) vs ARTIFACT (research)");
	const { root, cardsDir, scopedBase, cleanup } = setup();
	const rig = makePool(cardsDir, scopedBase);
	const opsFile = mkCard(cardsDir, "november", { cardType: "ops" });
	const resFile = mkCard(cardsDir, "oscar", { cardType: "research" });
	rig.reconciler.snapshot.set("november", "Executing");
	rig.reconciler.snapshot.set("oscar", "Executing");

	rig.pool.dispatch("november", opsFile, { cwd: root });
	rig.pool.dispatch("oscar", resFile, { cwd: root });
	await rig.pool.settleLaunches();

	const opsTask = fs.readFileSync(join(scopedBase, "november", "task.md"), "utf8");
	ok(opsTask.includes("type: CODE") && opsTask.includes("Apply the edits to the named files INSIDE this worktree"), "ops card gets the CODE-change contract");
	ok(opsTask.includes("OUTCOME: <files changed + verify result>"), "CODE contract asks for the files-changed OUTCOME");

	const resTask = fs.readFileSync(join(scopedBase, "oscar", "task.md"), "utf8");
	ok(resTask.includes("REAL knowledge paths") && resTask.includes("knowledge/FILING.md"), "research card gets the knowledge filing contract");
	ok(resTask.includes("knowledge/decisions/my-decision.md"), "filing layout points at knowledge/decisions for cross-domain artifacts");

	for (const [id, task] of [["november", opsTask], ["oscar", resTask]] as const) {
		ok(task.includes("<<CARD-DONE:CARDID>>>") && !task.includes(`<<CARD-DONE:${id}>>>`), `${id}: sentinel placeholder discipline held`);
	}
	cleanup();
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");
