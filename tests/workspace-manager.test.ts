// workspace-manager.test.ts - exercises the lifecycle workspace manager under a
// FAKE herdr transport (no real herdr, no real panes) and a fake capture host.
// Run via `node tests/workspace-manager.test.ts`.
//
// Covers: card:intake workspace creation + workspace:ready emit, reject-path reuse,
// maxLifecycleWorkspaces cap enforcement, startup reaper, haltKill, shutdown,
// workspace:failed escalation, and the queue-drain-after-terminal path.
//
// Every test that creates workspaces uses a REAL git repo (required by the
// gitWorktreeAdd call inside createWorkspace). A shared helper `setup()` builds
// a bare+clone pair AND a per-test scopedBase, all under one mkdtemp dir - the
// suite is fully hermetic (no shared /tmp paths, cleanup removes the whole dir).

import { execSync, type ExecSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineHost } from "../src/host/host.ts";
import { createStandaloneHost } from "../src/host/host.ts";
import type { HerdrAdapter, WorkspaceCreateResult, WorkspaceInfo } from "../src/engine/herdr-adapter.ts";
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

/** Per-test hermetic environment: bare+clone git repo + scopedBase, one mkdtemp root. */
function setup(): { repo: string; scopedBase: string; cleanup: () => void } {
	const tmp = fs.mkdtempSync(join(tmpdir(), "wsm-test-"));
	const bare = join(tmp, "bare.git");
	const clone = join(tmp, "clone");
	const scopedBase = join(tmp, "scoped");
	execSync(`git init --bare --initial-branch=main ${bare}`, GIT);
	execSync(`git clone ${bare} ${clone}`, GIT);
	execSync(`git -C ${clone} config user.email "test@wsm.holdco"`, GIT);
	execSync(`git -C ${clone} config user.name "WSM Test"`, GIT);
	fs.writeFileSync(join(clone, "README.md"), "# WSM Test Repo\n");
	execSync(`git -C ${clone} add -A`, GIT);
	execSync(`git -C ${clone} commit -m "Init"`, GIT);
	execSync(`git -C ${clone} push origin main`, GIT);
	return {
		repo: clone,
		scopedBase,
		cleanup: () => {
			try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
		},
	};
}

// ── Fake herdr ───────────────────────────────────────────────────────────────

class FakeHerdr {
	created: Array<{ label: string; cwd?: string }> = [];
	closed: string[] = [];
	workspaces: WorkspaceInfo[] = [];
	private nextId = 1;

	async workspaceCreate(label: string, cwd?: string): Promise<WorkspaceCreateResult> {
		this.created.push({ label, cwd });
		const id = `ws-${this.nextId++}`;
		const paneId = `pane-${id}`;
		this.workspaces.push({ workspace_id: id, label });
		return { ok: true, workspaceId: id, paneId };
	}

	async workspaceList(): Promise<WorkspaceInfo[]> {
		return [...this.workspaces];
	}

	async workspaceClose(workspaceId: string): Promise<boolean> {
		this.closed.push(workspaceId);
		this.workspaces = this.workspaces.filter((w) => w.workspace_id !== workspaceId);
		return true;
	}

	// Dummy stubs (not used by workspace-manager).
	async paneList() { return []; }
	async paneRun() { return true; }
	async paneSendText() { return true; }
	async paneSendKeys() { return true; }
	async paneRead() { return ""; }
	async paneAgentStatus() { return "idle"; }

	hadCreateFor(label: string): boolean {
		return this.created.some((c) => c.label === label);
	}
}

// ── Fake host (capture pattern, see core.test.ts) ────────────────────────────

interface Capture {
	host: EngineHost;
	emitted: Array<{ event: string; payload: any }>;
	logged: Array<Record<string, unknown>>;
}
function captureHost(): Capture {
	const emitted: Array<{ event: string; payload: any }> = [];
	const logged: Array<Record<string, unknown>> = [];
	const host = createStandaloneHost({ quiet: true, sink: (_kind, data) => logged.push(data) });
	const origEmit = host.events.emit.bind(host.events);
	host.events.emit = (event, payload) => {
		emitted.push({ event, payload });
		origEmit(event, payload);
	};
	return { host, emitted, logged };
}

function emittedFor(cap: Capture, event: string): any[] {
	return cap.emitted.filter((e) => e.event === event).map((e) => e.payload);
}

// ── createWorkspaceManager helper ────────────────────────────────────────────

function createWSM(scopedBase: string, opts?: { max?: number }): {
	wsm: WorkspaceManager;
	herdr: FakeHerdr;
	cap: Capture;
} {
	const herdr = new FakeHerdr();
	const cap = captureHost();
	const wsm = new WorkspaceManager({
		host: cap.host,
		herdr: herdr as unknown as HerdrAdapter,
		maxLifecycleWorkspaces: opts?.max,
		now: () => Date.now(),
		scopedBase,
	});
	return { wsm, herdr, cap };
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

	console.log("\n── card:intake → workspace created + workspace:ready emitted ──");

{
	const t = setup();
	const { wsm, herdr, cap } = createWSM(t.scopedBase);
	await wsm.onIntake("C1", "/cards/C1.md", t.repo);
	ok(wsm.hasWorkspace("C1"), "lifecycleWorkspaces has C1 after onIntake");
	ok(herdr.hadCreateFor("card-C1"), "herdr workspace create called with label card-C1");
	const ws = wsm.getWorkspace("C1");
	ok(ws?.scopedDir === join(t.scopedBase, "C1"), "scopedDir is <scopedBase>/C1");
	ok(fs.existsSync(join(t.scopedBase, "C1")), "scoped dir created on disk");
	ok(fs.existsSync(join(t.scopedBase, "C1", "worktree")), "git worktree created inside scoped dir");
	ok(fs.existsSync(join(t.scopedBase, "C1", "worktree", "README.md")), "worktree contains repo files");
	ok(fs.existsSync(join(t.scopedBase, "C1", "workspace.json")), "workspace.json written");
	const meta = JSON.parse(fs.readFileSync(join(t.scopedBase, "C1", "workspace.json"), "utf8"));
	ok(typeof meta.workspaceId === "string" && meta.workspaceId.length > 0, "workspace.json contains workspaceId");
	ok(typeof meta.paneId === "string", "workspace.json contains paneId");
	ok(typeof meta.worktreePath === "string" && meta.worktreePath.endsWith("/worktree"), "workspace.json contains worktreePath");
	const ready = emittedFor(cap, "workspace:ready");
	ok(ready.length === 1 && ready[0].id === "C1", "workspace:ready emitted with id=C1");
	ok(ready[0].scopedDir === join(t.scopedBase, "C1"), "workspace:ready carries scopedDir");
	ok(ready[0].worktreePath != null, "workspace:ready carries worktreePath");
	// Cleanup
	await wsm.onTerminal("C1", t.repo);
	t.cleanup();
}

	console.log("\n── reject path: repeated card:intake reuses existing workspace ──");

{
	const t = setup();
	const { wsm, herdr, cap } = createWSM(t.scopedBase);
	await wsm.onIntake("C2", "/cards/C2.md", t.repo);
	const firstId = wsm.getWorkspace("C2")!.workspaceId;
	const createCount = herdr.created.length;
	// Second card:intake (re-plan) should reuse, not re-create.
	await wsm.onIntake("C2", "/cards/C2.md", t.repo);
	ok(herdr.created.length === createCount, "no second workspaceCreate for re-plan");
	ok(wsm.hasWorkspace("C2"), "workspace still exists");
	ok(wsm.getWorkspace("C2")!.workspaceId === firstId, "same workspaceId retained");
	// workspace:ready should be emitted for the re-intake too (for the auto-planner).
	const ready = emittedFor(cap, "workspace:ready");
	ok(ready.length === 2, "workspace:ready emitted twice (initial + re-intake)");
	// Cleanup
	await wsm.onTerminal("C2", t.repo);
	t.cleanup();
}

	console.log("\n── maxLifecycleWorkspaces cap enforcement (MAX=2) ──");

{
	const t = setup();
	const { wsm, herdr, cap } = createWSM(t.scopedBase, { max: 2 });
	await wsm.onIntake("A1", "/cards/A1.md", t.repo);
	await wsm.onIntake("A2", "/cards/A2.md", t.repo);
	ok(wsm.lifecycleWorkspaces.size === 2, "2 workspaces live at cap");
	// 3rd card:intake should queue, NOT create.
	await wsm.onIntake("A3", "/cards/A3.md", t.repo);
	ok(wsm.lifecycleWorkspaces.size === 2, "still 2 workspaces (A3 queued)");
	ok(!wsm.hasWorkspace("A3"), "A3 not in lifecycleWorkspaces");
	ok(herdr.created.length === 2, "only 2 herdr creates (A3 deferred)");
	const ready = emittedFor(cap, "workspace:ready");
	ok(ready.every((r) => r.id !== "A3"), "no workspace:ready for A3 (queued)");
	// Free one workspace by terminating A1 → A3 should drain. The drain uses the
	// cwd captured at intake time (t.repo), NOT process.cwd() - port deviation.
	await wsm.onTerminal("A1", t.repo);
	// drainOne fires createWorkspace fire-and-forget; give it a tick to finish.
	await new Promise((r) => setTimeout(r, 200));
	ok(wsm.lifecycleWorkspaces.size === 2, "A1 freed, A3 drained → 2 workspaces again");
	ok(wsm.hasWorkspace("A3"), "A3 now has a workspace");
	ok(herdr.hadCreateFor("card-A3"), "herdr create called for A3 after drain");
	ok(fs.existsSync(join(t.scopedBase, "A3", "worktree", "README.md")), "A3 worktree created against the intake repo (queued cwd)");
	const ready2 = emittedFor(cap, "workspace:ready");
	const a3Ready = ready2.filter((r) => r.id === "A3");
	ok(a3Ready.length === 1, "workspace:ready emitted for A3 after drain");
	// Cleanup
	await wsm.onTerminal("A2", t.repo);
	await wsm.onTerminal("A3", t.repo);
	t.cleanup();
}

	console.log("\n── onTerminal closes workspace + prunes worktree + scoped dir ──");

{
	const t = setup();
	const { wsm, herdr } = createWSM(t.scopedBase);
	await wsm.onIntake("T1", "/cards/T1.md", t.repo);
	// herdr-mode: the workspaceId is a real string (null only in worktree-only mode).
	const wsId = wsm.getWorkspace("T1")!.workspaceId;
	ok(wsId !== null, "herdr-mode workspace has a real workspaceId");
	// Write a dummy file to scoped dir.
	fs.writeFileSync(join(t.scopedBase, "T1", "dummy.txt"), "data", "utf8");
	await wsm.onTerminal("T1", t.repo);
	ok(wsId !== null && herdr.closed.includes(wsId), "workspace closed on terminal");
	ok(!wsm.hasWorkspace("T1"), "removed from lifecycleWorkspaces");
	ok(!fs.existsSync(join(t.scopedBase, "T1")), "scoped dir (incl. worktree) pruned");
	// Verify worktree removed from git metadata.
	const list = execSync(`git -C ${t.repo} worktree list`, GIT).toString();
	ok(!list.includes(join(t.scopedBase, "T1")), "worktree no longer listed by git worktree list");
	t.cleanup();
}

	console.log("\n── haltKill closes + prunes immediately ──");

{
	const t = setup();
	const { wsm, herdr } = createWSM(t.scopedBase);
	await wsm.onIntake("HK1", "/cards/HK1.md", t.repo);
	const wsId = wsm.getWorkspace("HK1")!.workspaceId;
	fs.writeFileSync(join(t.scopedBase, "HK1", "evidence.txt"), "keep", "utf8");
	await wsm.haltKill("HK1", t.repo);
	ok(wsId !== null && herdr.closed.includes(wsId), "workspace closed by haltKill");
	ok(!fs.existsSync(join(t.scopedBase, "HK1")), "scoped dir pruned by haltKill");
	ok(!wsm.hasWorkspace("HK1"), "removed from lifecycleWorkspaces");
	t.cleanup();
}

	console.log("\n── startup reaper closes orphan workspaces + prunes orphan worktrees ──");

{
	const t = setup();
	const { wsm, herdr } = createWSM(t.scopedBase);
	const snapshot = new Map<string, string>();
	// Add orphan workspaces to the fake herdr list.
	herdr.workspaces = [
		{ workspace_id: "ws-orphan", label: "card-ORPHAN" },
		{ workspace_id: "ws-alive", label: "card-ALIVE" },
		{ workspace_id: "ws-filed", label: "card-FILED" },
	];
	// CARDS: ALIVE is in the active funnel, ORPHAN is missing from snapshot, FILED is terminal.
	snapshot.set("ALIVE", "Needs Approval");
	snapshot.set("FILED", "Filed");
	// Create a stale worktree on disk for ORPHAN (simulating a crash leak).
	const orphanWt = join(t.scopedBase, "ORPHAN", "worktree");
	fs.mkdirSync(orphanWt, { recursive: true });
	fs.writeFileSync(join(orphanWt, "stale.txt"), "orphaned\n");
	const filedWt = join(t.scopedBase, "FILED", "worktree");
	fs.mkdirSync(filedWt, { recursive: true });
	fs.writeFileSync(join(filedWt, "stale.txt"), "filed-terminal\n");
	const closed = await wsm.startupReaper(t.repo, snapshot);
	ok(closed.includes("ORPHAN"), "orphan workspace (missing from snapshot) reaped");
	ok(closed.includes("FILED"), "terminal-card workspace (Filed) reaped");
	ok(!closed.includes("ALIVE"), "active-card workspace preserved");
	ok(herdr.closed.includes("ws-orphan"), "orphan ws closed via herdr");
	ok(herdr.closed.includes("ws-filed"), "filed ws closed via herdr");
	ok(wsm.hasWorkspace("ALIVE"), "ALIVE re-registered in lifecycleWorkspaces");
	// Verify orphan worktrees cleaned up on disk.
	ok(!fs.existsSync(join(t.scopedBase, "ORPHAN")), "orphan scoped dir pruned");
	ok(!fs.existsSync(join(t.scopedBase, "FILED")), "filed scoped dir pruned");
	// ALIVE wasn't on disk so nothing to verify there.
	t.cleanup();
}

	console.log("\n── shutdown closes all workspaces, does NOT prune scoped dirs ──");

{
	const t = setup();
	const { wsm, herdr } = createWSM(t.scopedBase);
	await wsm.onIntake("S1", "/cards/S1.md", t.repo);
	await wsm.onIntake("S2", "/cards/S2.md", t.repo);
	fs.writeFileSync(join(t.scopedBase, "S1", "keep.txt"), "important", "utf8");
	const ws1 = wsm.getWorkspace("S1")!.workspaceId;
	const ws2 = wsm.getWorkspace("S2")!.workspaceId;
	await wsm.shutdown();
	ok(ws1 !== null && ws2 !== null && herdr.closed.includes(ws1) && herdr.closed.includes(ws2), "both workspaces closed");
	ok(wsm.lifecycleWorkspaces.size === 0, "map cleared");
	// Scoped dirs MUST survive shutdown.
	ok(fs.existsSync(join(t.scopedBase, "S1", "keep.txt")), "S1 scoped dir survives shutdown");
	ok(fs.existsSync(join(t.scopedBase, "S2")), "S2 scoped dir survives shutdown");
	t.cleanup();
}

	console.log("\n── workspace creation failure escalates via workspace:failed ──");

{
	const t = setup();
	const herdr = new FakeHerdr();
	// Sabotage: workspaceCreate returns ok:false.
	(herdr as any).workspaceCreate = async (_label: string, _cwd?: string) => {
		return { ok: false, workspaceId: null, paneId: null };
	};
	const cap = captureHost();
	const wsm = new WorkspaceManager({
		host: cap.host,
		herdr: herdr as unknown as HerdrAdapter,
		now: () => Date.now(),
		scopedBase: t.scopedBase,
	});
	await wsm.onIntake("FAIL", "/cards/FAIL.md", t.repo);
	ok(!wsm.hasWorkspace("FAIL"), "FAIL not registered after herdr failure");
	const failed = emittedFor(cap, "workspace:failed");
	ok(failed.length === 1 && failed[0].id === "FAIL", "workspace:failed emitted");
	ok(failed[0].reason.includes("herdr"), "reason explains herdr failure");
	// The stranded worktree (herdr failed but git worktree was already created)
	// lives under the hermetic mkdtemp root - cleanup removes it wholesale.
	t.cleanup();
}

	console.log("\n── double terminal is idempotent ──");

{
	const t = setup();
	const { wsm, herdr } = createWSM(t.scopedBase);
	await wsm.onIntake("DT", "/cards/DT.md", t.repo);
	const wsId = wsm.getWorkspace("DT")!.workspaceId;
	await wsm.onTerminal("DT", t.repo);
	await wsm.onTerminal("DT", t.repo); // second call
	ok(herdr.closed.filter((c) => c === wsId).length === 1, "workspace closed exactly once");
	t.cleanup();
}

	console.log("\n── worktree-only mode: no herdr dep - the git worktree IS the isolation ──");

{
	const t = setup();
	const cap = captureHost();
	// NO herdr in deps: the standalone daemon with a headless harness runs this way.
	const wsm = new WorkspaceManager({ host: cap.host, now: () => Date.now(), scopedBase: t.scopedBase });

	// onIntake: scoped dir + REAL git worktree + workspace.json, workspace:ready with null ids.
	await wsm.onIntake("W1", "/cards/W1.md", t.repo);
	ok(wsm.hasWorkspace("W1"), "lifecycleWorkspaces has W1 after onIntake (no herdr)");
	ok(fs.existsSync(join(t.scopedBase, "W1")), "scoped dir created on disk");
	ok(fs.existsSync(join(t.scopedBase, "W1", "worktree", "README.md")), "real git worktree created inside scoped dir");
	ok(fs.existsSync(join(t.scopedBase, "W1", "workspace.json")), "workspace.json written");
	const meta = JSON.parse(fs.readFileSync(join(t.scopedBase, "W1", "workspace.json"), "utf8"));
	ok(meta.workspaceId === null && meta.paneId === null, "workspace.json carries null herdr ids (worktree-only)");
	ok(typeof meta.baseCommit === "string" && meta.baseCommit.length > 0, "workspace.json records the worktree's creation base");
	const handle = wsm.getWorkspace("W1")!;
	ok(handle.workspaceId === null && handle.paneId === null, "handle workspaceId/paneId are null in worktree-only mode");
	const ready = emittedFor(cap, "workspace:ready");
	ok(ready.length === 1 && ready[0].id === "W1", "workspace:ready emitted");
	ok(ready[0].workspaceId === null, "workspace:ready carries workspaceId null");
	ok(typeof ready[0].worktreePath === "string" && ready[0].worktreePath.endsWith("/worktree"), "workspace:ready carries the worktree path");

	// onTerminal: prunes the worktree + scoped dir (no herdr close to make).
	await wsm.onTerminal("W1", t.repo);
	ok(!wsm.hasWorkspace("W1"), "removed from lifecycleWorkspaces on terminal");
	ok(!fs.existsSync(join(t.scopedBase, "W1")), "scoped dir (incl. worktree) pruned on terminal");
	const list = execSync(`git -C ${t.repo} worktree list`, GIT).toString();
	ok(!list.includes(join(t.scopedBase, "W1")), "worktree no longer listed by git worktree list");

	// shutdown: clears the map without touching herdr (there is none), scoped dirs survive.
	await wsm.onIntake("W2", "/cards/W2.md", t.repo);
	await wsm.onIntake("W3", "/cards/W3.md", t.repo);
	await wsm.shutdown();
	ok(wsm.lifecycleWorkspaces.size === 0, "shutdown clears the map (no herdr to touch)");
	ok(fs.existsSync(join(t.scopedBase, "W2", "worktree")) && fs.existsSync(join(t.scopedBase, "W3")), "scoped dirs survive shutdown");
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
