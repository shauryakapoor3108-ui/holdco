// orchestrate.test.ts - INTEGRATION: the daemon's execution glue end to end.
// Real CardEngine (noLease, events-off, huge sweep - reconciles are driven
// manually) + real Reconciler through the engine, real WorkspaceManager in
// worktree-only mode (no herdr), real WorkerPool over a controllable FakeHarness,
// real Orchestrator. drain() is called manually for determinism (start() arms an
// interval); one block exercises start()'s event wiring.
// Run via `node tests/orchestrate.test.ts`.

import { execSync, type ExecSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CardEngine } from "../src/engine/core.ts";
import { Orchestrator } from "../src/engine/orchestrate.ts";
import { WorkerPool } from "../src/engine/worker-pool.ts";
import { WorkspaceManager } from "../src/engine/workspace-manager.ts";
import type { EngineHost } from "../src/host/host.ts";
import { createStandaloneHost } from "../src/host/host.ts";
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

/** Per-block hermetic environment: a REAL git repo with cards/, plus a scopedBase. */
function setup(): { root: string; cardsDir: string; scopedBase: string; cleanup: () => void } {
	const tmp = fs.mkdtempSync(join(tmpdir(), "orch-test-"));
	const root = join(tmp, "repo");
	const cardsDir = join(root, "cards");
	const scopedBase = join(tmp, "scoped");
	fs.mkdirSync(cardsDir, { recursive: true });
	execSync(`git init --initial-branch=main ${root}`, GIT);
	execSync(`git -C ${root} config user.email "test@orch.holdco"`, GIT);
	execSync(`git -C ${root} config user.name "Orch Test"`, GIT);
	fs.mkdirSync(join(root, "knowledge"), { recursive: true });
	fs.writeFileSync(join(root, "knowledge", "FILING.md"), "# Filing\n");
	fs.writeFileSync(join(root, "README.md"), "# Orch Test Repo\n");
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

function mkCard(cardsDir: string, id: string, status: string, opts: { halt?: boolean } = {}): string {
	const file = join(cardsDir, `${id}.md`);
	const haltLine = opts.halt ? "halt: true\n" : "";
	fs.writeFileSync(
		file,
		`---\ntype: card\nid: ${id}\ntitle: "card ${id}"\nstatus: ${status}\ncard_type: research\ndomain: root\n${haltLine}---\n\n` +
			`## Brief\ndo the thing for ${id}\n\n## Reconciler Log\n`,
	);
	return file;
}

const status = (file: string) => fs.readFileSync(file, "utf8").match(/^status:\s*(.*)$/m)![1].trim();
const setStatus = (file: string, s: string) => {
	const text = fs.readFileSync(file, "utf8");
	fs.writeFileSync(file, text.replace(/^status: .*$/m, `status: ${s}`));
};

/** Await a condition (workspace creation is fire-and-forget from the drain/wiring). */
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return cond();
}

// ── FakeHarness (same seam double as worker-pool.test.ts, minimal) ──────────

class FakeHarness implements Harness {
	readonly name = "fake";
	readonly spawned: SpawnRequest[] = [];
	readonly disposed: HarnessSession[] = [];
	private readonly states = new Map<string, PollResult>();
	async spawn(req: SpawnRequest): Promise<HarnessSession> {
		this.spawned.push(req);
		const promptRef = join(req.workspace.scopedDir, "prompt.md");
		fs.writeFileSync(promptRef, `# prompt ${req.card.id}\n\n${req.instruction}\n`, "utf8");
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
			outputTail: "work\nOUTCOME: did the work\n",
			usage: { tokensIn: 100, tokensOut: 20, costUsd: 0.01 },
			transcriptRef: null,
			promptRef: session.promptRef,
			errorCount: 0,
		};
	}
	async dispose(session: HarnessSession): Promise<void> {
		this.disposed.push(session);
	}
	setDone(id: string): void {
		this.states.set(id, { state: "done" });
	}
	spawnedFor(id: string): boolean {
		return this.spawned.some((r) => r.card.id === id);
	}
}

// ── Rig: real engine + wsMgr (worktree-only) + pool (FakeHarness) + orchestrator ──

interface Rig {
	host: EngineHost;
	emitted: Array<{ event: string; payload: any }>;
	logged: Array<Record<string, unknown>>;
	engine: CardEngine;
	wsMgr: WorkspaceManager;
	fake: FakeHarness;
	pool: WorkerPool;
	orch: Orchestrator;
}

function makeRig(root: string, cardsDir: string, scopedBase: string, opts: { maxSlots?: number } = {}): Rig {
	const emitted: Array<{ event: string; payload: any }> = [];
	const logged: Array<Record<string, unknown>> = [];
	const host = createStandaloneHost({
		// Huge sweep-ms + events-off: reconciles are driven MANUALLY via engine.runReconcile.
		flags: { "cards-dir": cardsDir, "card-events-off": "true", "card-sweep-ms": "600000" },
		quiet: true,
		sink: (_kind, data) => logged.push(data),
	});
	const origEmit = host.events.emit.bind(host.events);
	host.events.emit = (event, payload) => {
		emitted.push({ event, payload });
		origEmit(event, payload);
	};
	const engine = new CardEngine(host, { cwd: root, noLease: true });
	const boot = engine.start();
	if (!boot.owner) throw new Error("engine failed to start");
	const wsMgr = new WorkspaceManager({ host, scopedBase }); // worktree-only: NO herdr
	const fake = new FakeHarness();
	const pool = new WorkerPool({
		host,
		reconciler: engine.reconciler!,
		harnesses: { fake },
		defaultHarness: "fake",
		maxSlots: opts.maxSlots ?? 2,
		cardBudgetUsd: 1.0,
		watchdogMs: 600_000,
		wsMgr,
		scopedBase,
	});
	const orch = new Orchestrator({ host, engine, pool, wsMgr, cwd: root });
	return { host, emitted, logged, engine, wsMgr, fake, pool, orch };
}

async function run() {

	console.log("\n── full lifecycle: Needs Approval → Queued → drain → Executing → Needs Review ──");

{
	const t = setup();
	// Card seeded BEFORE boot at the human gate.
	const file = mkCard(t.cardsDir, "alpha", "Needs Approval");
	const rig = makeRig(t.root, t.cardsDir, t.scopedBase);
	ok(rig.engine.reconciler!.snapshot.get("alpha") === "Needs Approval", "boot seeds the snapshot at Needs Approval");

	// Human approves: edit to Queued; the engine detects it on the manual reconcile.
	setStatus(file, "Queued");
	rig.engine.runReconcile("sweep");
	ok(rig.engine.reconciler!.snapshot.get("alpha") === "Queued", "engine detects the human Needs Approval → Queued move");
	ok(rig.emitted.some((e) => e.event === "card:queued" && e.payload.id === "alpha"), "card:queued landing event emitted");

	// Drain pass 1: no lifecycle workspace yet → triggers intake, NOT dispatch.
	await rig.orch.drain();
	ok(status(file) === "Queued", "first drain pass leaves the card Queued (no worktree yet)");
	ok(rig.fake.spawned.length === 0, "no spawn before the workspace exists");
	ok(await until(() => rig.wsMgr.hasWorkspace("alpha")), "onIntake created the lifecycle workspace (worktree-only)");
	const ready = rig.emitted.find((e) => e.event === "workspace:ready" && e.payload.id === "alpha");
	ok(ready !== undefined && ready.payload.workspaceId === null, "workspace:ready emitted with workspaceId null (no herdr)");
	const handle = rig.wsMgr.getWorkspace("alpha")!;
	ok(fs.existsSync(join(handle.worktreePath, "README.md")), "a REAL git worktree exists for the card");

	// Drain pass 2: the engine edge Queued → Executing + dispatch.
	await rig.orch.drain();
	ok(status(file) === "Executing", "second drain pass writes Queued → Executing (engine edge)");
	ok(rig.emitted.some((e) => e.event === "card:dequeued" && e.payload.id === "alpha"), "card:dequeued emitted at dispatch");
	ok(rig.pool.hasSlot("alpha"), "pool slot reserved for the card");
	await rig.pool.settleLaunches();
	ok(rig.fake.spawnedFor("alpha"), "FakeHarness spawned through the seam");
	ok(rig.fake.spawned[0].workspace.dir === handle.worktreePath, "worker cwd IS the lifecycle worktree");

	// Worker "works": a REAL edit inside the worktree, then the adapter reports done.
	fs.writeFileSync(join(handle.worktreePath, "knowledge", "alpha-analysis.md"), "# Analysis\nfindings\n");
	rig.fake.setDone("alpha");
	await rig.pool.sweep();
	ok(status(file) === "Needs Review", "finalize: card → Needs Review");
	const text = fs.readFileSync(file, "utf8");
	ok(text.includes("## Diff") && text.includes("alpha-analysis.md"), "## Diff section carries the real worktree diff");
	ok(text.includes("cost_total: 0.01") && /^harness: fake$/m.test(text), "cost + harness annotations written");
	ok(rig.emitted.some((e) => e.event === "exec:idle"), "exec:idle emitted after finalize");

	// The engine's own writes were loop-suppressed: the next reconcile sees NO delta.
	const events = rig.engine.runReconcile("sweep");
	ok(!events.some((e) => e.event === "ILLEGAL_REVERT"), "next reconcile: NO ILLEGAL_REVERT (snapshot synced through the whole path)");
	ok(status(file) === "Needs Review", "card rests at Needs Review");

	rig.engine.stop();
	t.cleanup();
}

	console.log("\n── sovereignty: human pull-back between snapshot and drain is honoured ──");

{
	const t = setup();
	const file = mkCard(t.cardsDir, "sierra", "Queued"); // seeded Queued → snapshot Queued at boot
	const rig = makeRig(t.root, t.cardsDir, t.scopedBase);
	ok(rig.engine.reconciler!.snapshot.get("sierra") === "Queued", "snapshot holds Queued");

	// Human pulls the card back to Draft AFTER the snapshot was taken, BEFORE the drain.
	setStatus(file, "Draft");
	await rig.orch.drain();
	ok(status(file) === "Draft", "drain is a no-op: the human pull-back stands (card stays Draft)");
	ok(rig.fake.spawned.length === 0, "no worker spawned for the pulled-back card");
	ok(!rig.pool.hasSlot("sierra"), "no slot consumed");
	ok(!rig.wsMgr.hasWorkspace("sierra"), "no intake triggered for the pulled-back card");

	rig.engine.stop();
	t.cleanup();
}

	console.log("\n── halt: true card is never drained ──");

{
	const t = setup();
	const file = mkCard(t.cardsDir, "hotel", "Queued", { halt: true });
	const rig = makeRig(t.root, t.cardsDir, t.scopedBase);
	ok(rig.engine.reconciler!.snapshot.get("hotel") === "Queued", "halted card seeds the snapshot at Queued");

	await rig.orch.drain();
	ok(status(file) === "Queued", "halted card stays Queued (never drained)");
	ok(rig.fake.spawned.length === 0, "no worker spawned for the halted card");
	ok(!rig.wsMgr.hasWorkspace("hotel"), "no intake triggered for the halted card");

	rig.engine.stop();
	t.cleanup();
}

	console.log("\n── freeSlots exhausted: second card waits, drains after the first completes ──");

{
	const t = setup();
	const fileA = mkCard(t.cardsDir, "aa-first", "Queued");
	const fileB = mkCard(t.cardsDir, "bb-second", "Queued");
	const rig = makeRig(t.root, t.cardsDir, t.scopedBase, { maxSlots: 1 });

	// Drain pass 1: both cards need intake (no worktrees yet).
	await rig.orch.drain();
	ok(await until(() => rig.wsMgr.hasWorkspace("aa-first") && rig.wsMgr.hasWorkspace("bb-second")), "both lifecycle workspaces created");

	// Drain pass 2: ONE slot - aa-first (id order) dispatches, bb-second stays Queued.
	await rig.orch.drain();
	await rig.pool.settleLaunches();
	ok(status(fileA) === "Executing" && rig.fake.spawnedFor("aa-first"), "first card dispatched into the single slot");
	ok(status(fileB) === "Queued", "second card stays Queued (slots exhausted)");
	ok(rig.pool.freeSlots() === 0, "no free slots while the first card runs");

	// A drain with zero slots is a no-op for the second card.
	await rig.orch.drain();
	ok(status(fileB) === "Queued", "drain with zero free slots leaves the second card Queued");

	// First worker completes (clean worktree is fine) → slot frees (exec:idle) →
	// in manual mode we call drain() again ourselves.
	rig.fake.setDone("aa-first");
	await rig.pool.sweep();
	ok(status(fileA) === "Needs Review", "first card finalized to Needs Review");
	ok(rig.pool.freeSlots() === 1, "slot freed after the first card completes");
	await rig.orch.drain();
	await rig.pool.settleLaunches();
	ok(status(fileB) === "Executing" && rig.fake.spawnedFor("bb-second"), "second card drains once a slot frees");

	rig.engine.stop();
	t.cleanup();
}

	console.log("\n── start(): event wiring - card:intake landing → wsMgr creates the workspace ──");

{
	const t = setup();
	const rig = makeRig(t.root, t.cardsDir, t.scopedBase);
	rig.orch.start(600_000); // huge sweep interval: the tick never fires during the test

	// A new card lands at Intake via a manual reconcile → card:intake → onIntake (wired by start()).
	mkCard(t.cardsDir, "whiskey", "Intake");
	rig.engine.runReconcile("sweep");
	ok(rig.emitted.some((e) => e.event === "card:intake" && e.payload.id === "whiskey"), "card:intake landing event emitted");
	ok(await until(() => rig.wsMgr.hasWorkspace("whiskey")), "start()'s wiring routed card:intake → wsMgr.onIntake (workspace created)");
	ok(fs.existsSync(join(t.scopedBase, "whiskey", "worktree", "README.md")), "real worktree created through the wiring");
	ok(rig.emitted.some((e) => e.event === "workspace:ready" && e.payload.id === "whiskey" && e.payload.workspaceId === null), "workspace:ready (workspaceId null) emitted through the wiring");

	await rig.orch.stop(); // clears the interval + disposers, reaps the pool, shuts wsMgr down
	ok(rig.wsMgr.lifecycleWorkspaces.size === 0, "orchestrator.stop() shut the workspace manager down");
	rig.engine.stop();
	t.cleanup();
}

	// ── Summary ──────────────────────────────────────────────────────────────
	console.log(`\nPass: ${pass}  Fail: ${fail}`);
	if (fail > 0) {
		console.log("❌ SOME TESTS FAILED");
		process.exit(1);
	}
	console.log("✅ ALL TESTS PASSED");
}

run().catch((err) => {
	console.error("Test runner threw:", err);
	process.exit(1);
});
