// workspace-manager.ts — lifecycle workspace + per-card git worktree (EngineHost port).
//
// Creates a persistent herdr workspace + git worktree on card:intake, maintains an
// in-memory lifecycleWorkspaces map, enforces a maxLifecycleWorkspaces cap, and gates
// the auto-planner via workspace:ready. The workspace PERSISTS through both human gates
// (Needs Approval, Needs Review) and is closed+pruned only at a terminal state
// (Filed/Archived/Quarantine) or on haltKill().
//
// A git worktree is created at <scopedBase>/<id>/worktree on intake. The herdr
// workspace --cwd IS the worktree (not the shared main repo). The worktree is
// removed + pruned on terminal or haltKill.
//
// EngineHost port: the Pi `setPi(pi)` seam is gone — the host arrives in deps and is
// always present (events via host.events.emit, logging via host.log.entry). The herdr
// workspace creation stays here for now; it becomes the Pi-adapter surface in a later
// milestone.
//
// The workspace-manager is REGISTERED BEFORE the auto-planner so its card:intake
// handler fires first — the auto-planner gates on workspace:ready.

import * as fs from "node:fs";
import { join } from "node:path";
import type { EngineHost } from "../host/host.ts";
import { gitWorktreeAdd, gitWorktreePrune, gitWorktreeRemove } from "./git-ops.ts";
import type { HerdrAdapter } from "./herdr-adapter.ts";
import { CARD_WORKSPACE_LABEL_PREFIX, type WorkspaceHandle } from "./types.ts";
import { DEFAULT_SCOPED_BASE, scopedDirFor, worktreeDirFor } from "./workspace-paths.ts";

const DEFAULT_MAX_LIFECYCLE_WORKSPACES = 6;

function envMax(): number {
	const v = Number(process.env.MAX_LIFECYCLE_WORKSPACES);
	return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_MAX_LIFECYCLE_WORKSPACES;
}

/** Escape a string for literal use inside a RegExp (the label prefix may carry specials). */
function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface WorkspaceManagerDeps {
	host: EngineHost;
	/** OPTIONAL: the herdr transport for visible per-card workspaces (the Pi-adapter
	 *  surface). Absent → worktree-only mode: the git worktree is still the isolation
	 *  primitive; no panes, no workspace ids. The standalone daemon with a headless
	 *  harness (Claude Code) runs this way. */
	herdr?: HerdrAdapter;
	maxLifecycleWorkspaces?: number;
	now?: () => number;
	/** Base dir for per-card scoped dirs + worktrees. Default DEFAULT_SCOPED_BASE. */
	scopedBase?: string;
	/** herdr workspace label prefix. Default CARD_WORKSPACE_LABEL_PREFIX ("card-"). */
	labelPrefix?: string;
}

export class WorkspaceManager {
	public readonly lifecycleWorkspaces = new Map<string, WorkspaceHandle>();
	private readonly d: WorkspaceManagerDeps;
	private readonly max: number;
	private readonly now: () => number;
	// Deferred intakes carry the cwd from onIntake — drainOne must create the
	// deferred workspace against the SAME repo the intake targeted, not process.cwd()
	// (deliberate deviation from the source, which used process.cwd() in drainOne).
	private readonly queue: Array<{ id: string; file: string; cwd: string }> = [];
	private readonly scopedBase: string;
	private readonly labelPrefix: string;

	constructor(d: WorkspaceManagerDeps) {
		this.d = d;
		this.max = d.maxLifecycleWorkspaces ?? envMax();
		this.now = d.now ?? (() => Date.now());
		this.scopedBase = d.scopedBase ?? DEFAULT_SCOPED_BASE;
		this.labelPrefix = d.labelPrefix ?? CARD_WORKSPACE_LABEL_PREFIX;
	}

	/** `<scopedBase>/<id>` — the ONE place the scoped-dir template resolves (via the shared helper). */
	private scopedDir(id: string): string {
		return scopedDirFor({ scopedBase: this.scopedBase }, id);
	}
	/** `<scopedBase>/<id>/worktree` — the git-worktree path (via the shared helper). */
	private worktreeDir(id: string): string {
		return worktreeDirFor({ scopedBase: this.scopedBase }, id);
	}
	/** Extract the card id from a workspace label, honoring the configured prefix (null if no match). */
	private cardIdFromLabel(label: string): string | null {
		const m = label.match(new RegExp(`^${escapeRe(this.labelPrefix)}(.+)$`));
		return m ? m[1] : null;
	}

	/** Check whether a lifecycle workspace exists for a card id. */
	hasWorkspace(id: string): boolean {
		return this.lifecycleWorkspaces.has(id);
	}

	/** Get the handle for a card's lifecycle workspace, or undefined. */
	getWorkspace(id: string): WorkspaceHandle | undefined {
		return this.lifecycleWorkspaces.get(id);
	}

	// ── card:intake handler ────────────────────────────────────────────────────

	/**
	 * On card:intake: create scoped dir + herdr workspace + workspace.json +
	 * record in lifecycleWorkspaces + emit workspace:ready.
	 *
	 * If at maxLifecycleWorkspaces cap, enqueues the card and defers creation
	 * until a workspace frees (onTerminal). The auto-planner MUST gate on
	 * workspace:ready, so a queued card never triggers plan-gen.
	 */
	async onIntake(id: string, file: string, cwd: string): Promise<void> {
		// Reject path: if a lifecycle workspace already exists for this card (e.g.,
		// Needs Approval → Intake re-plan), reuse it — just emit workspace:ready.
		const existing = this.lifecycleWorkspaces.get(id);
		if (existing) {
			this.d.host.events.emit("workspace:ready", {
				id, file, workspaceId: existing.workspaceId,
				paneId: existing.paneId, scopedDir: existing.scopedDir,
			});
			return;
		}

		// Cap gate: if we're at max, enqueue and return without emitting workspace:ready.
		if (this.lifecycleWorkspaces.size >= this.max) {
			if (!this.queue.some((q) => q.id === id)) {
				this.queue.push({ id, file, cwd });
				this.log("WS_INTAKE_QUEUED", { card: id, reason: `lifecycle cap (${this.lifecycleWorkspaces.size}/${this.max})` });
			}
			return;
		}

		await this.createWorkspace(id, file, cwd);
	}

	// ── terminal handler ───────────────────────────────────────────────────────

	/**
	 * Called when a card reaches a terminal state (Filed/Archived/Quarantine) or
	 * on haltKill(). Closes the herdr workspace, removes the git worktree, prunes
	 * the scoped dir, removes from lifecycleWorkspaces, and drains the queue (up
	 * to one freed slot).
	 */
	async onTerminal(id: string, vaultPath?: string): Promise<void> {
		const ws = this.lifecycleWorkspaces.get(id);
		if (!ws) return;

		// Close the herdr workspace (when one exists — worktree-only mode has none).
		if (this.d.herdr && ws.workspaceId) {
			try {
				await this.d.herdr.workspaceClose(ws.workspaceId);
			} catch {
				/* best-effort */
			}
		}

		// Remove the git worktree.
		const repoPath = vaultPath ?? process.cwd();
		if (ws.worktreePath) {
			try {
				gitWorktreeRemove(repoPath, ws.worktreePath);
			} catch {
				/* best-effort — directory may already be gone */
			}
			try {
				gitWorktreePrune(repoPath);
			} catch {
				/* best-effort */
			}
		}

		// Prune the scoped dir.
		try {
			if (fs.existsSync(ws.scopedDir)) {
				fs.rmSync(ws.scopedDir, { recursive: true, force: true });
			}
		} catch {
			/* best-effort */
		}

		this.lifecycleWorkspaces.delete(id);
		this.log("WS_TERMINAL", { card: id });

		// Drain one entry from the deferred intake queue.
		this.drainOne(id);
	}

	// ── startup reaper ─────────────────────────────────────────────────────────

	/**
	 * Close orphan lifecycle workspaces + force-remove orphan worktrees (card-<id>)
	 * whose card is NOT in Draft→Needs Review. Called after startupRecovery has
	 * already pulled any stuck Executing card to Needs Review.
	 *
	 * Also force-removes stale git worktrees and runs git worktree prune.
	 */
	async startupReaper(cwd: string, snapshot: Map<string, string>): Promise<string[]> {
		const closed: string[] = [];
		try {
			const workspaces = this.d.herdr ? await this.d.herdr.workspaceList() : [];
			for (const ws of workspaces) {
				const cardId = this.cardIdFromLabel(ws.label);
				if (!cardId) continue;
				const status = snapshot.get(cardId);
				// Keep only if the card is in the active funnel (Draft→Needs Review, not Filed/Archived/Quarantine).
				if (status && status !== "Filed" && status !== "Archived" && status !== "Quarantine") {
					// Card is alive — re-register in the in-memory map so we track it.
					const scopedDir = this.scopedDir(cardId);
					const worktreePath = this.worktreeDir(cardId);
					if (!this.lifecycleWorkspaces.has(cardId)) {
						// Recover the worktree's creation base from workspace.json so a re-executed
						// card's harvest still diffs against the right base (a worker may git commit).
						let baseCommit = "HEAD";
						try {
							const meta = JSON.parse(fs.readFileSync(join(scopedDir, "workspace.json"), "utf8"));
							if (typeof meta?.baseCommit === "string" && meta.baseCommit) baseCommit = meta.baseCommit;
						} catch { /* best-effort — fall back to HEAD */ }
						this.lifecycleWorkspaces.set(cardId, {
							cardId,
							workspaceId: ws.workspace_id,
							paneId: null, // pane may be gone but the workspace survives
							scopedDir,
							worktreePath,
							baseCommit,
							createdAt: this.now(),
						});
					}
					continue;
				}
				// Orphan — close workspace + force-remove worktree + prune.
				await this.d.herdr!.workspaceClose(ws.workspace_id);
				const worktreePath = this.worktreeDir(cardId);
				try { gitWorktreeRemove(cwd, worktreePath); } catch { /* best-effort */ }
				try { gitWorktreePrune(cwd); } catch { /* best-effort */ }
				// Prune the scoped dir too (terminal).
				const scopedDir = this.scopedDir(cardId);
				try {
					if (fs.existsSync(scopedDir)) fs.rmSync(scopedDir, { recursive: true, force: true });
				} catch { /* best-effort */ }
				closed.push(cardId);
				this.log("WS_ORPHAN_REAPED", { card: cardId, workspace: ws.workspace_id });
			}
		} catch {
			/* best-effort — herdr may be unavailable at startup */
		}
		// Sweep for stale worktrees on disk that have no herdr workspace record.
		// Force-remove any <scopedBase>/<id>/worktree where the card is NOT in the
		// active funnel (Draft→Needs Review).
		try {
			const scopedBase = this.scopedBase;
			if (fs.existsSync(scopedBase)) {
				for (const entry of fs.readdirSync(scopedBase, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue;
					const cardId = entry.name;
					const status = snapshot.get(cardId);
					if (status && status !== "Filed" && status !== "Archived" && status !== "Quarantine") continue;
					// Orphan: card not in active funnel. Force-remove worktree.
					const wt = join(scopedBase, cardId, "worktree");
					if (fs.existsSync(wt)) {
						try { gitWorktreeRemove(cwd, wt); } catch { /* best-effort */ }
						if (!closed.includes(cardId)) closed.push(cardId);
						this.log("WS_ORPHAN_WORKTREE_REAPED", { card: cardId, worktree: wt });
					}
					// Also prune the full scoped dir if it exists.
					const sc = join(scopedBase, cardId);
					try { if (fs.existsSync(sc)) fs.rmSync(sc, { recursive: true, force: true }); } catch { /* best-effort */ }
				}
			}
			try { gitWorktreePrune(cwd); } catch { /* best-effort */ }
		} catch {
			/* best-effort */
		}
		return closed;
	}

	// ── halt ───────────────────────────────────────────────────────────────────

	/** Halt kill: close + prune immediately (no audit needed). */
	async haltKill(id: string, vaultPath?: string): Promise<void> {
		await this.onTerminal(id, vaultPath);
	}

	/** Close all lifecycle workspaces on session_shutdown. Does NOT prune scoped
	 *  dirs — cards at Draft→Needs Review survive to the next session; terminal
	 *  cards will be cleaned up by the reconstitution sweep. */
	async shutdown(): Promise<void> {
		for (const [id, ws] of [...this.lifecycleWorkspaces.entries()]) {
			if (this.d.herdr && ws.workspaceId) {
				try {
					await this.d.herdr.workspaceClose(ws.workspaceId);
				} catch { /* best-effort */ }
			}
			this.lifecycleWorkspaces.delete(id);
		}
	}

	// ── internals ──────────────────────────────────────────────────────────────

	private async createWorkspace(id: string, file: string, cwd: string): Promise<void> {
		const scopedDir = this.scopedDir(id);

		// 1. Ensure scoped dir exists.
		try {
			fs.mkdirSync(scopedDir, { recursive: true });
		} catch (err) {
			this.log("WS_CREATE_FAILED", { card: id, phase: "mkdir", error: String(err) });
			this.d.host.events.emit("workspace:failed", { id, file, reason: `scoped dir mkdir failed: ${String(err)}` });
			return;
		}

		// 2. Create the git worktree. The cwd passed to onIntake IS the shared main
		//    repo. The worktree goes inside the scoped dir.
		//
		//    Idempotent resume: after an owner restart, boot-replay re-fires card:intake
		//    for cards still in lifecycle — their worktree survives on disk and is still
		//    registered with git, so a blind `worktree add` collides ("already exists").
		//    If a readable workspace.json is present, REUSE the worktree (recover its
		//    creation base; the stale herdr ids are replaced in steps 3–4). A worktree
		//    dir without readable metadata is a half-created remnant: clear + recreate.
		const worktreePath = join(scopedDir, "worktree");
		let baseCommit = "HEAD";
		let resumedWorktree = false;
		if (fs.existsSync(worktreePath)) {
			try {
				const meta = JSON.parse(fs.readFileSync(join(scopedDir, "workspace.json"), "utf8"));
				if (typeof meta?.baseCommit === "string" && meta.baseCommit) {
					baseCommit = meta.baseCommit;
					resumedWorktree = true;
					this.log("WS_RESUMED", { card: id, worktree: worktreePath, baseCommit });
				}
			} catch { /* unreadable meta — treat as remnant below */ }
			if (!resumedWorktree) {
				try { gitWorktreeRemove(cwd, worktreePath); } catch { /* not registered */ }
				try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
			}
		}
		if (!resumedWorktree) {
			try {
				baseCommit = gitWorktreeAdd(cwd, "HEAD", worktreePath);
			} catch (err) {
				this.log("WS_CREATE_FAILED", { card: id, phase: "git-worktree-add", error: String(err) });
				this.d.host.events.emit("workspace:failed", { id, file, reason: `git worktree add failed: ${String(err)}` });
				return;
			}
		}

		// 2b. Symlink node_modules into the worktree. The worktree is a bare git checkout:
		//     node_modules is gitignored, so it is ABSENT. Without it the worker's
		//     `-e .pi/extensions/*.ts` cannot resolve their deps (e.g. `yaml`) — the worker
		//     exits before reading task.md — and any verify command the worker runs fails
		//     too. The deps live in the main checkout; symlink them so the worktree resolves
		//     exactly like main. node_modules is gitignored → the symlink never appears in
		//     the diff. Both locations are guarded by existsSync, so a repo without either
		//     dir is untouched:
		//       • <main>/.pi/node_modules (the Pi-extension layout — harmless when absent)
		//       • <main>/node_modules     (any Node repo's top-level deps)
		try {
			const srcNm = join(cwd, ".pi", "node_modules");
			const dstNm = join(worktreePath, ".pi", "node_modules");
			if (fs.existsSync(srcNm) && !fs.existsSync(dstNm)) {
				fs.symlinkSync(srcNm, dstNm, "dir");
			}
		} catch (err) {
			this.log("WS_SYMLINK_WARN", { card: id, phase: "node_modules-symlink", error: String(err) });
		}
		try {
			const srcNm = join(cwd, "node_modules");
			const dstNm = join(worktreePath, "node_modules");
			if (fs.existsSync(srcNm) && !fs.existsSync(dstNm)) {
				fs.symlinkSync(srcNm, dstNm, "dir");
			}
		} catch (err) {
			this.log("WS_SYMLINK_WARN", { card: id, phase: "node_modules-symlink", error: String(err) });
		}

		// 3. Create the herdr workspace with --cwd = the worktree (NOT the shared repo)
		//    — Pi-adapter surface only; worktree-only mode (no herdr dep) skips it.
		let workspaceId: string | null = null;
		let paneId: string | null = null;
		if (this.d.herdr) {
			try {
				const ws = await this.d.herdr.workspaceCreate(`${this.labelPrefix}${id}`, worktreePath);
				if (!ws.ok || !ws.workspaceId) {
					const err = "herdr workspace create failed (ok=false or no workspaceId)";
					this.log("WS_CREATE_FAILED", { card: id, phase: "herdr-create", error: err });
					this.d.host.events.emit("workspace:failed", { id, file, reason: err });
					return;
				}
				workspaceId = ws.workspaceId;
				paneId = ws.paneId;
			} catch (err) {
				this.log("WS_CREATE_FAILED", { card: id, phase: "herdr-create", error: String(err) });
				this.d.host.events.emit("workspace:failed", { id, file, reason: `herdr error: ${String(err)}` });
				return;
			}
		}

		// 4. Write workspace.json.
		try {
			fs.writeFileSync(
				join(scopedDir, "workspace.json"),
				JSON.stringify({ workspaceId, paneId, worktreePath, baseCommit, createdAt: new Date().toISOString() }, null, 2),
				"utf8",
			);
		} catch (err) {
			this.log("WS_CREATE_WARN", { card: id, phase: "workspace.json", error: String(err) });
			// Non-fatal: the workspace is live, we just couldn't persist metadata.
		}

		// 5. Record in lifecycleWorkspaces.
		const handle: WorkspaceHandle = {
			cardId: id,
			workspaceId,
			paneId,
			scopedDir,
			worktreePath,
			baseCommit,
			createdAt: this.now(),
		};
		this.lifecycleWorkspaces.set(id, handle);

		this.log("WS_CREATED", { card: id, workspace: workspaceId, worktree: worktreePath });

		// 6. Emit workspace:ready — the auto-planner gates on this.
		this.d.host.events.emit("workspace:ready", { id, file, workspaceId, paneId, scopedDir, worktreePath });
	}

	/** Drain one deferred card:intake from the queue (called after a workspace frees). */
	private drainOne(_freedCardId: string): void {
		if (this.queue.length === 0) return;
		if (this.lifecycleWorkspaces.size >= this.max) return; // still at cap (shouldn't happen)
		// Find the first queued entry whose workspace wasn't already created
		// (a race could queue the same card twice; skip dupes).
		while (this.queue.length > 0) {
			const next = this.queue.shift()!;
			if (this.lifecycleWorkspaces.has(next.id)) continue; // already created
			this.log("WS_QUEUE_DRAIN", { card: next.id });
			// Fire-and-forget: the auto-planner will trigger on workspace:ready.
			// Use the cwd captured at intake time — NOT process.cwd() (port deviation).
			void this.createWorkspace(next.id, next.file, next.cwd);
			return;
		}
	}

	// Stale-safe logging: a throwing host sink must never crash the engine.
	private log(event: string, data: Record<string, unknown>): void {
		try {
			this.d.host.log.entry("card-engine-log", { event, ext: "workspace-manager", ts: new Date().toISOString(), ...data });
		} catch {
			/* host sink threw */
		}
	}
}
