// worker-pool.ts — D2 execution: N ephemeral, isolated herdr worker workspaces, one per card.
// (EngineHost port: the Pi ExtensionAPI dep is replaced by the EngineHost seam — logging via
// host.log.entry, events via host.events.emit, notifications via host.notify — and the ctx
// params collapse to the board root cwd on dispatch.)
//
// The single-owner invariant (ADR D2): the card-engine stays the SOLE process owning the
// reconciler + snapshot + queue-drain and the SOLE writer of `status`. EXECUTION moves OUT of
// the owner's REPL into execution-only Pi workers (`pi --no-extensions -e damage-control -e
// pi-observability -e worker-guard`) — never a card-engine/reconciler/drain, so the bug-2 /
// reload-ghost class is closed by construction. This pool is the owner-side machinery that
// spawns, monitors (by output-sentinel polling), harvests (obs telemetry + git worktree diff),
// writes board state, and tears the workspace down.
//
// D1 → D2: the single `busy` boolean becomes an N-slot model (`freeSlots()`); inline
// `sendUserMessage` dispatch becomes `spawn a worker`; the `agent_end` inline completion
// becomes a sweep-driven harvest. The circuit breaker, /halt-kill, watchdog, and the
// loop-suppression discipline (every `writeStatus` paired with a synchronous `snapshot.set`,
// no `await` between them) all carry forward, generalised to N workers.
//
// Slice 3: workers run in per-card git worktrees (created by the workspace-manager at
// intake). The unified harvest produces a `card.diff` via gitStageAndDiff — one path for
// both code and artifact cards. The old code-card vs artifact-card branch + fileArtifacts()
// are collapsed into ONE unified git diff harvest.

import * as fs from "node:fs";
import { join, relative } from "node:path";
import type { EngineHost } from "../host/host.ts";
import { DEFAULT_SCOPED_BASE, scopedDirFor } from "./workspace-paths.ts";
import { extractOutcome, readInstruction } from "./executor.ts";
import { writeStatus } from "./frontmatter.ts";
import { gitCheckEngineTouched, gitStageAndDiff } from "./git-ops.ts";
import { upsertBodySection } from "./frontmatter.ts";
import { Cockpit, cockpitLabelFor } from "./cockpit.ts";
import type { HerdrAdapter } from "./herdr-adapter.ts";
import type { ObsClient } from "./obs-client.ts";
import type { Reconciler } from "./reconciler.ts";
import type { WorkspaceManager } from "./workspace-manager.ts";

/** Circuit breaker: max spawns of one card per session before a HARD STOP (runaway guard). */
const MAX_DISPATCHES_PER_SESSION = 3;
/** Bounded session_id resolution at completion (sweep-cadence retries before the obs-down fallback). */
const MAX_RESOLVE_ATTEMPTS = 5;
/** How many recent pane lines to read when polling for the completion sentinel. */
const PANE_READ_LINES = 60;
/** Worker REPL readiness poll budget (the worker pi must boot before we inject the steer). */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1_000;
/** v3 guard against partial-text submission: wait between send-text and the Enter key. */
const STEER_SUBMIT_DELAY_MS = 300;
/** The kickoff Enter can be DROPPED if pi's input line isn't ready when we press it (the 300ms
 *  race) → the worker sits with the steer typed-but-unsubmitted until the watchdog escalates.
 *  After each Enter we VERIFY the worker left idle (pi is running the steer); if not, resend. */
const STEER_SUBMIT_MAX_ATTEMPTS = 4;
/** Verify polls per attempt — a BOUNDED count (NOT a wall-clock deadline: the test clock is
 *  frozen, so a `while (now() < deadline)` verify would never terminate under it). */
const STEER_VERIFY_POLLS = 5;
const STEER_VERIFY_POLL_MS = 200;

export interface WorkerSlot {
	cardId: string;
	file: string;
	relPath: string;
	domain: string;
	cardType: string;
	/** P6: which executor drives this card. "pi" = the execution-only Pi worker (obs + sweep-sentinel
	 *  completion, the default). "claude" = a `claude` REPL pane peer (no obs; `herdr wait output`
	 *  completion). A claude slot is SKIPPED by the sweep — launchClaudeWorker owns its full lifecycle. */
	driver: "pi" | "claude";
	cwd: string; // the git worktree root (Slice 3: <scopedBase>/<id>/worktree)
	runId: string; // per-spawn nonce → the obs `run:<runId>` correlation tag
	scopedDir: string; // <scopedBase>/<card-id> (metadata dir; worktree lives inside it)
	startedAt: number;
	workspaceId: string | null;
	paneId: string | null;
	sessionId: string | null; // resolved lazily from obs via the run tag
	launching: boolean; // true until the herdr workspace + worker are up and the steer is sent
	steerBaseline: string; // pane output captured at steer injection (leave-idle guard)
	leftIdle: boolean; // worker confirmed to have left its initial state (task picked up)
	done: boolean; // completion sentinel observed (finalize pending)
	completionOutput: string; // the pane output at completion (OUTCOME source)
	resolveAttempts: number; // bounded session_id resolution counter
	harvested: boolean; // idempotency guard against a double-finalize
}

export interface WorkerPoolDeps {
	host: EngineHost;
	reconciler: Reconciler;
	herdr: HerdrAdapter;
	obs: ObsClient;
	obsToken: string;
	obsServerUrl: string;
	maxSlots: number;
	cardBudgetUsd: number;
	watchdogMs: number;
	wsMgr?: WorkspaceManager; // Slice 2: lifecycle workspace manager
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Base dir for per-card scoped dirs (ProjectConfig.scopedBase). Default DEFAULT_SCOPED_BASE. */
	scopedBase?: string;
	/** Dir the worker `-e` extensions load from (ProjectConfig.engineRoot). Default ".pi/extensions"
	 *  (relative → today's byte-for-byte launch command). The owner passes an absolute engineRoot. */
	engineRoot?: string;
	/** obs pool for `--o-pool` on worker launch (ProjectConfig.obs.pool). Default undefined → no flag. */
	pool?: string;
	/** COCKPIT: project slug → the `cockpit-<slug>` workspace workers split (ProjectConfig.slug). */
	slug?: string;
	/** P6: the project's worker model (ProjectConfig.models.worker). The sentinel value "claude" makes
	 *  `claude` the DEFAULT driver for every card in this project (a per-card `worker:` frontmatter field
	 *  still overrides either way). Any other value (a model name / null) keeps the default Pi worker. */
	workerModel?: string | null;
}

/** Regex matching ONLY a worker's own concrete completion sentinel (never the placeholder echo). */
export function sentinelFor(cardId: string): RegExp {
	const esc = cardId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`<<CARD-DONE:${esc}>>>`);
}

/** P6: a claude worker's plain-text completion sentinel — the literal string `herdr wait output --match`
 *  scans for (level-triggered). The claude prompt describes it with a PLACEHOLDER so this concrete
 *  string never appears in the launch prompt (which would false-match the initial prompt echo); it
 *  lands in pane text ONLY when the worker's final `echo` runs. Card ids are `[A-Za-z0-9._-]+`
 *  (regex-inert), so the literal is a safe substring match. */
export function claudeSentinelFor(cardId: string): string {
	return `FLEET_DONE_${cardId}`;
}

/** COCKPIT: a worker's stable pane label (renumber-safe addressing — see cockpit.ts). */
export function workerLabel(cardId: string): string {
	return `worker:${cardId}`;
}

export class WorkerPool {
	private readonly slots = new Map<string, WorkerSlot>();
	private readonly dispatchCounts = new Map<string, number>();
	private readonly launches: Promise<void>[] = [];
	private sweeping = false;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly scopedBase: string;
	private readonly engineRoot: string;
	private readonly pool?: string;
	/** P6: true when ProjectConfig.models.worker === "claude" → claude is this project's default driver. */
	private readonly claudeWorker: boolean;
	/** COCKPIT: the project's single visible workspace (owner + workers as split panes). Lazily
	 *  built so its --cwd (recreate) is the vault captured at first dispatch. */
	private cockpit: Cockpit | null = null;
	private projectRoot: string | null = null;
	private readonly d: WorkerPoolDeps;

	constructor(d: WorkerPoolDeps) {
		this.d = d;
		this.now = d.now ?? (() => Date.now());
		this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.scopedBase = d.scopedBase ?? DEFAULT_SCOPED_BASE;
		this.engineRoot = d.engineRoot ?? ".pi/extensions";
		this.pool = d.pool;
		this.claudeWorker = d.workerModel === "claude";
	}

	/** P6: resolve the executor for a card — a per-card `worker:` frontmatter field wins (claude|pi),
	 *  else the project default (models.worker === "claude" ⇒ claude), else the Pi worker. */
	private driverFor(file: string): "pi" | "claude" {
		const field = readField(file, "worker").toLowerCase();
		if (field === "claude") return "claude";
		if (field === "pi") return "pi";
		return this.claudeWorker ? "claude" : "pi";
	}

	/** The shared ensure-cockpit surface (find-or-create the `cockpit-<slug>` workspace). ONE
	 *  instance per pool so the resolved workspace id is cached across dispatches. */
	private getCockpit(): Cockpit {
		if (!this.cockpit) {
			this.cockpit = new Cockpit({
				herdr: this.d.herdr,
				label: cockpitLabelFor(this.d.slug),
				cwd: this.projectRoot ?? process.cwd(),
				log: (event, data) => this.log(event, data),
			});
		}
		return this.cockpit;
	}

	// ── slot accounting (the N-slot gate the queue:next handler reads) ─────────
	freeSlots(): number {
		return Math.max(0, this.d.maxSlots - this.slots.size);
	}
	activeCount(): number {
		return this.slots.size;
	}
	hasSlot(cardId: string): boolean {
		return this.slots.has(cardId);
	}
	clearDispatchCount(cardId: string): void {
		this.dispatchCounts.delete(cardId);
	}

	// ── dispatch (synchronous: breaker → no-brief → reserve + async launch) ────
	/**
	 * Called by the card-engine's `queue:next` handler AFTER it has written the
	 * loop-suppressed `Queued → Executing` edge (snapshot-synced) and dropped the card
	 * from the queue. The slot reservation is SYNCHRONOUS (it decrements `freeSlots`
	 * before any `await`), so a same-tick second offer cannot double-allocate the slot
	 * (the TOCTOU discipline carried from D1). The herdr workspace + worker launch then
	 * proceed asynchronously and fill in `workspace_id`/`pane_id` on the reserved slot.
	 *
	 * Slice 3: the worker cwd is the per-card git worktree (from the workspace-manager),
	 * NOT the shared main repo.
	 */
	dispatch(cardId: string, file: string, ctx?: { cwd?: string }): void {
		// Circuit breaker — a card spawned too many times this session is HARD-STOPPED
		// (suspected runaway). A watchdog-escalated card that is re-queued + re-dispatched
		// counts toward this cap (the dispatch counter persists across the card's lifecycle).
		const dispatches = (this.dispatchCounts.get(cardId) ?? 0) + 1;
		this.dispatchCounts.set(cardId, dispatches);
		if (dispatches > MAX_DISPATCHES_PER_SESSION) {
			const reason = `circuit breaker: ${dispatches - 1} spawns in one session — halted (suspected re-execution loop)`;
			writeStatus(file, "Needs Review", {
				annotations: { halt: "true", interrupted: "true", outcome: JSON.stringify(reason) },
				logLine: `CIRCUIT BREAKER: halted after ${dispatches - 1} spawns → Needs Review, halt:true`,
			});
			this.d.reconciler.snapshot.set(cardId, "Needs Review");
			this.log("EXEC_CIRCUIT_BREAKER", { card: cardId, dispatches: dispatches - 1 });
			this.d.host.notify(`🛑 circuit breaker: ${cardId} halted after ${dispatches - 1} spawns — /unhalt ${cardId} to clear`, "warning");
			this.d.host.events.emit("exec:idle", {});
			return;
		}

		const instruction = readInstruction(file);
		if (!instruction) {
			// Never spawn an empty worker — file straight to review (snapshot-synced).
			writeStatus(file, "Needs Review", {
				annotations: { cost_total: "0", tokens: "0", duration_s: "0", outcome: JSON.stringify("no brief — nothing to execute") },
				logLine: "execution skipped: no brief — Executing → Needs Review",
			});
			this.d.reconciler.snapshot.set(cardId, "Needs Review");
			this.log("EXEC_NO_BRIEF", { card: cardId });
			this.d.host.events.emit("exec:idle", {});
			return;
		}

		// Reserve the slot SYNCHRONOUSLY (freeSlots decrements now), then launch async.
		// Slice 3: the worker cwd is the per-card git worktree — MUST come from wsMgr
		// when the lifecycle workspace-manager is present.
		// HARDENING 1: when wsMgr IS present (production), a card reaching Executing
		// WITHOUT a lifecycle worktree is an isolation breach — the shared-repo
		// execution path is unreachable. QUARANTINE instead of falling back.
		// When wsMgr is absent (pre-lifecycle path, tests), the vault fallback is
		// still permitted as the ephemeral workspace path.
		const vault = ctx?.cwd ?? process.cwd();
		this.projectRoot ??= vault; // COCKPIT: the vault is the cockpit recreate --cwd
		const lifecycleWs = this.d.wsMgr?.getWorkspace(cardId);
		if (this.d.wsMgr && !lifecycleWs?.worktreePath) {
			const reason = "isolation breach: card reached Executing without a lifecycle worktree — the shared-repo execution path is unreachable";
			writeStatus(file, "Needs Review", {
				annotations: { interrupted: "true", outcome: JSON.stringify(reason), review_flag: JSON.stringify("isolation-breach") },
				logLine: `isolation breach: Executing → Needs Review (no lifecycle worktree — quarantined)`,
			});
			this.d.reconciler.snapshot.set(cardId, "Needs Review");
			this.log("EXEC_ISOLATION_BREACH", { card: cardId, reason });
			this.d.host.notify(`⛔ ${cardId}: isolation breach — no lifecycle worktree at Executing → quarantined to Needs Review`, "warning");
			this.d.host.events.emit("exec:idle", {});
			return;
		}
		const cwd: string = lifecycleWs?.worktreePath ?? vault;
		const domain = readField(file, "domain") || "root";
		const cardType = readField(file, "card_type") || "";
		if (!cardType) {
			this.log("EXEC_NO_CARD_TYPE", { card: cardId, detail: "no card_type in frontmatter — defaulting to artifact contract" });
		}
		const scopedDir = scopedDirFor({ scopedBase: this.scopedBase }, cardId);
		const driver = this.driverFor(file);
		const slot: WorkerSlot = {
			cardId,
			file,
			relPath: relative(vault, file),
			domain,
			cardType,
			driver,
			cwd,
			runId: `${cardId}-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
			scopedDir,
			startedAt: this.now(),
			workspaceId: null,
			paneId: null,
			sessionId: null,
			launching: true,
			steerBaseline: "",
			leftIdle: false,
			done: false,
			completionOutput: "",
			resolveAttempts: 0,
			harvested: false,
		};
		this.slots.set(cardId, slot);
		this.log("EXEC_DISPATCH", { card: cardId, domain, driver, runId: slot.runId, file: slot.relPath, worktree: cwd });
		this.d.host.notify(`🃏 spawning ${driver} worker for ${cardId} (${this.activeCount()}/${this.d.maxSlots} slots)`, "info");
		// P6: a claude card takes the pane-peer launch path (launchClaudeWorker owns its full lifecycle
		// incl. the blocking sentinel wait + finalize); the default Pi worker takes the sweep-monitored
		// launch(). Both share cockpit placement, the worktree cwd, task.md, and the diff harvest.
		this.launches.push(driver === "claude" ? this.launchClaudeWorker(slot, instruction) : this.launch(slot, instruction));
	}

	/** Await every in-flight launch (test helper + session_shutdown safety). */
	async settleLaunches(): Promise<void> {
		await Promise.allSettled(this.launches.splice(0));
	}

	// ── launch (async: scoped dir → COCKPIT split → worker → steer) ────────────
	private async launch(slot: WorkerSlot, instruction: string): Promise<void> {
		try {
			// 1. Ensure the scoped dir exists, then write the task.md.
			fs.mkdirSync(slot.scopedDir, { recursive: true });
			fs.writeFileSync(join(slot.scopedDir, "task.md"), this.buildWorkerTask(slot, instruction), "utf8");

			// 2. COCKPIT: place a worker pane by SPLITTING the project's one cockpit workspace
			//    (owner→right for the first, stack down after; overflow to the bench tab past 4
			//    panes). The pane's --cwd is the per-card worktree. place() find-or-CREATES the
			//    cockpit if it is gone at dispatch (shared ensure-cockpit), then renames the pane
			//    `worker:<id>` + report-agent working. There is NO per-card workspace anymore.
			const cockpit = this.getCockpit();
			const paneLabel = workerLabel(slot.cardId);
			const pane = await cockpit.place(paneLabel, "working", slot.cwd);
			if (!pane) {
				this.failLaunch(slot, "cockpit placement failed (herdr split/create)");
				return;
			}
			slot.paneId = pane;
			slot.workspaceId = cockpit.id;
			this.log("EXEC_COCKPIT_PLACED", { card: slot.cardId, workspace: cockpit.id, pane });

			// 3. Launch the execution-only worker (obs token propagated; --no-extensions
			//    disables discovery so NO card-engine loads — only the explicit -e paths).
			const launched = await this.d.herdr.paneRun(slot.paneId, this.buildLaunchCommand(slot));
			if (!launched) {
				this.failLaunch(slot, "herdr pane run failed (worker did not launch)");
				return;
			}

			// 4. Wait for the worker REPL to be ready, capture the baseline, inject the steer.
			//    Re-resolve the pane by its label first: a sibling teardown during waitForReady
			//    RENUMBERS pane ids (herdr fact), so the id from place() may already be stale.
			await this.waitForReady(slot);
			const live = await cockpit.resolve(paneLabel);
			if (live) slot.paneId = live;
			slot.steerBaseline = await this.d.herdr.paneRead(slot.paneId, "recent", PANE_READ_LINES);
			await this.d.herdr.paneSendText(slot.paneId, this.buildSteer(slot));
			await this.submitSteer(slot);

			slot.launching = false;
			this.log("EXEC_WORKER_SPAWNED", { card: slot.cardId, workspace: slot.workspaceId, pane: slot.paneId, runId: slot.runId });
		} catch (err) {
			this.failLaunch(slot, `launch error: ${String(err)}`);
		}
	}

	/** Poll the worker pane until its agent_status reports idle (herdr-injected pi state). */
	private async waitForReady(slot: WorkerSlot): Promise<void> {
		const deadline = this.now() + READY_TIMEOUT_MS;
		while (this.now() < deadline) {
			if (slot.paneId && (await this.d.herdr.paneAgentStatus(slot.paneId)) === "idle") return;
			await this.sleep(READY_POLL_MS);
		}
		// Ready-timeout is SOFT: proceed to inject the steer anyway (the worker is most likely
		// up but not reporting agent_status); the sentinel/watchdog backstop a truly-dead worker.
		this.log("EXEC_WORKER_READY_TIMEOUT", { card: slot.cardId, pane: slot.paneId });
	}

	/** Press Enter to submit the typed steer, then VERIFY the worker actually left idle (pi is
	 *  running the steer). A dropped Enter would otherwise strand the worker with the steer sitting
	 *  unsubmitted in its input line until the watchdog escalates — the 5th launch bug. Resend up
	 *  to STEER_SUBMIT_MAX_ATTEMPTS times. SOFT on exhaustion: proceed and let the completion
	 *  sentinel + watchdog backstop a truly-stuck worker. Uses bounded poll COUNTS (not a
	 *  wall-clock deadline) so it terminates under the frozen test clock. */
	private async submitSteer(slot: WorkerSlot): Promise<void> {
		if (!slot.paneId) return;
		for (let attempt = 1; attempt <= STEER_SUBMIT_MAX_ATTEMPTS; attempt++) {
			await this.sleep(STEER_SUBMIT_DELAY_MS);
			await this.d.herdr.paneSendKeys(slot.paneId, "Enter");
			for (let poll = 0; poll < STEER_VERIFY_POLLS; poll++) {
				// A submitted steer drives pi out of "idle" (working/blocked). "idle"/"unknown"
				// ⇒ the input is still sitting in the box (or herdr isn't reporting) → keep trying.
				const status = await this.d.herdr.paneAgentStatus(slot.paneId);
				if (status === "working" || status === "blocked") {
					if (attempt > 1) this.log("EXEC_STEER_RESUBMITTED", { card: slot.cardId, pane: slot.paneId, attempt });
					return; // steer accepted — pi is running it
				}
				await this.sleep(STEER_VERIFY_POLL_MS);
			}
			this.log("EXEC_STEER_RESUBMIT", { card: slot.cardId, pane: slot.paneId, attempt, reason: "worker still idle after Enter" });
		}
		// SOFT: submission never confirmed — proceed; the sentinel/watchdog backstop a stuck worker.
		this.log("EXEC_STEER_SUBMIT_UNCONFIRMED", { card: slot.cardId, pane: slot.paneId });
	}

	/** A launch that could not establish a worker → escalate the card + close its cockpit pane. */
	private failLaunch(slot: WorkerSlot, reason: string): void {
		// SYNC board write + snapshot (loop-suppressed), then async reap.
		writeStatus(slot.file, "Needs Review", {
			annotations: { interrupted: "true", outcome: JSON.stringify(`worker launch failed: ${reason}`) },
			logLine: `worker launch failed: Executing → Needs Review (${reason})`,
		});
		this.d.reconciler.snapshot.set(slot.cardId, "Needs Review");
		this.log("EXEC_ESCALATED", { card: slot.cardId, mechanism: "launch-failure", errorClass: "terminal", reason });
		this.d.host.notify(`🛑 ${slot.cardId}: worker launch failed → Needs Review`, "warning");
		this.slots.delete(slot.cardId);
		this.d.host.events.emit("exec:idle", {});
		// COCKPIT: close any partial worker pane (best-effort; no per-card workspace to reap).
		// HARDENING 2 carries forward: the wsMgr worktree / scoped dir is NOT pruned here — the
		// evidence survives to Needs Review, pruned only at a terminal state. Only the
		// pre-lifecycle fallback (no wsMgr handle for this card) prunes its scoped dir.
		void this.getCockpit().close(workerLabel(slot.cardId));
		if (!this.d.wsMgr?.hasWorkspace(slot.cardId)) this.pruneScopedDir(slot.cardId);
	}

	// ── claude pane-peer launch path (P6) ──────────────────────────────────────
	/**
	 * Launch a `claude` REPL as a visible cockpit pane peer instead of a Pi worker, then BLOCK on the
	 * plain-text completion sentinel via `herdr wait output` (level-scan) and harvest the worktree diff
	 * exactly like the Pi path (a direct finalize()). This is a PARALLEL launcher beside launch(), not a
	 * replacement — it reuses cockpit placement, the per-card worktree cwd, task.md, and finalize()'s
	 * unified diff harvest + teardown. The whole lifecycle lives in this one promise (pushed to
	 * this.launches): dispatch stays synchronous, and the sweep skips claude slots (driver guard).
	 *
	 * `claude -p` (print/headless) is BANNED for an interactive pane — the REPL is launched with the
	 * task as its initial-prompt positional arg (`claude --dangerously-skip-permissions "<prompt>"`,
	 * the simplest form the CLI supports; probed live). --dangerously-skip-permissions is the pane
	 * autonomy boundary: there is no human to approve tool calls, and the per-card git worktree is the
	 * isolation boundary (the same scope the Pi worker's worker-guard enforces, here by contract).
	 */
	private async launchClaudeWorker(slot: WorkerSlot, instruction: string): Promise<void> {
		try {
			// 1. Scoped dir + task.md (parity with the Pi path — a durable record + the diff/pane-output
			//    harvest target; claude reads its task from the inline prompt, not this file).
			fs.mkdirSync(slot.scopedDir, { recursive: true });
			fs.writeFileSync(join(slot.scopedDir, "task.md"), this.buildWorkerTask(slot, instruction), "utf8");

			// 2. COCKPIT: place the pane exactly like a Pi worker (owner→right/stack-down; bench overflow).
			const cockpit = this.getCockpit();
			const paneLabel = workerLabel(slot.cardId);
			const pane = await cockpit.place(paneLabel, "working", slot.cwd);
			if (!pane) {
				this.failLaunch(slot, "cockpit placement failed (claude — herdr split/create)");
				return;
			}
			slot.paneId = pane;
			slot.workspaceId = cockpit.id;
			this.log("EXEC_COCKPIT_PLACED", { card: slot.cardId, driver: "claude", workspace: cockpit.id, pane });

			// 3. Launch the claude REPL in the pane (initial-prompt arg; no obs, no -e — a peer, not a Pi).
			const launched = await this.d.herdr.paneRun(slot.paneId, this.buildClaudeLaunchCommand(slot, instruction));
			if (!launched) {
				this.failLaunch(slot, "herdr pane run failed (claude did not launch)");
				return;
			}
			slot.launching = false;
			this.log("EXEC_CLAUDE_SPAWNED", { card: slot.cardId, workspace: slot.workspaceId, pane: slot.paneId, runId: slot.runId });

			// 4. Block on the sentinel (level-scan). Re-resolve the pane by its STABLE label first: a
			//    sibling teardown RENUMBERS pane ids (herdr fact), so the id from place() may be stale.
			const sentinel = claudeSentinelFor(slot.cardId);
			const live = await cockpit.resolve(paneLabel);
			if (live) slot.paneId = live;
			const matched = await this.d.herdr.waitOutput(slot.paneId!, sentinel, this.d.watchdogMs);

			if (matched) {
				// Sentinel seen → capture the pane tail (OUTCOME source) + harvest the worktree diff.
				const live2 = await cockpit.resolve(paneLabel);
				if (live2) slot.paneId = live2;
				slot.completionOutput = slot.paneId ? await this.d.herdr.paneRead(slot.paneId, "recent", PANE_READ_LINES) : "";
				slot.done = true;
				await this.finalize(slot);
			} else {
				// Timeout / herdr-down / crashed pane — the one watchdog escalation path (same as the Pi path).
				await this.escalateWatchdog(slot, `claude worker did not signal done within ${Math.round(this.d.watchdogMs / 1000)}s (herdr wait output)`);
			}
		} catch (err) {
			this.failLaunch(slot, `claude launch error: ${String(err)}`);
		}
	}

	// ── sweep (non-blocking monitor of every active slot, on the 2s tick) ──────
	async sweep(): Promise<void> {
		if (this.sweeping) return; // reentrancy guard — a slow tick must not overlap the next
		this.sweeping = true;
		try {
			for (const slot of [...this.slots.values()]) {
				if (slot.launching) continue; // still setting up — nothing to monitor yet
				// P6: claude slots self-manage via launchClaudeWorker's blocking `herdr wait output`
				// (completion + timeout + crash all resolve there), so the sweep never touches them.
				if (slot.driver === "claude") continue;
				await this.monitorSlot(slot);
			}
		} finally {
			this.sweeping = false;
		}
	}

	private async monitorSlot(slot: WorkerSlot): Promise<void> {
		// COCKPIT: re-resolve this worker's pane by its STABLE label before any pane read — a
		// sibling teardown RENUMBERS pane ids (herdr fact), so slot.paneId can be stale.
		const paneLabel = workerLabel(slot.cardId);
		const { paneId: live, listNonEmpty } = await this.getCockpit().locate(paneLabel);
		if (live) slot.paneId = live;

		// Phase A — a completion was already detected: drive the bounded harvest/finalize.
		if (slot.done) {
			await this.finalize(slot);
			return;
		}

		// Phase A′ — dead-pane watchdog: the worker's labelled pane vanished from a NON-EMPTY
		// cockpit pane list (crash / external close). An EMPTY list is a transient herdr read
		// failure (the adapter returns [] on timeout too) → do NOT escalate; the next tick +
		// the sentinel / stale-obs backstops self-correct.
		if (!live && listNonEmpty) {
			await this.escalateWatchdog(slot, "worker pane gone from cockpit (not resolvable by label)");
			return;
		}

		// Opportunistic session_id resolution (so the budget check can run mid-run).
		if (!slot.sessionId) {
			slot.sessionId = await this.d.obs.resolveSessionIdByTag(`run:${slot.runId}`);
		}

		// Phase B — per-run budget (BenAI): kill a worker that overspends.
		if (slot.sessionId) {
			const { ok, stats } = await this.d.obs.getStats(slot.sessionId);
			if (ok && stats && stats.total_cost > this.d.cardBudgetUsd) {
				await this.budgetKill(slot, stats.total_cost);
				return;
			}
		}

		// Phase C — completion sentinel (primary signal) + the v3 leave-idle-then-done guard.
		if (slot.paneId) {
			const output = await this.d.herdr.paneRead(slot.paneId, "recent", PANE_READ_LINES);
			if (output && output !== slot.steerBaseline) slot.leftIdle = true;
			if (slot.leftIdle && sentinelFor(slot.cardId).test(output)) {
				slot.done = true;
				slot.completionOutput = output;
				await this.finalize(slot);
				return;
			}
		}

		// Phase D — watchdog (hard backstop): a dead pane or stale obs ⇒ escalate + reap.
		await this.watchdogSlot(slot);
	}

	private async watchdogSlot(slot: WorkerSlot): Promise<void> {
		// (Dead-pane detection moved to monitorSlot — it re-resolves the worker's cockpit pane by
		// label every tick and escalates a genuine omission, with the same transient-empty guard.)
		// Stale telemetry: obs last activity older than the watchdog threshold → escalate.
		if (slot.sessionId) {
			const { ok, stats } = await this.d.obs.getStats(slot.sessionId);
			if (ok && stats?.latest_ts) {
				const age = this.now() - Date.parse(stats.latest_ts);
				if (Number.isFinite(age) && age > this.d.watchdogMs) {
					await this.escalateWatchdog(slot, `obs latest_ts stale for ${Math.round(age / 1000)}s`);
					return;
				}
			}
		}
	}

	// ── finalize / harvest (owner is the sole vault + status writer) ───────────
	private async finalize(slot: WorkerSlot): Promise<void> {
		if (slot.harvested) return;

		// Bounded session_id resolution at completion (the worker pushes its first event
		// shortly after start; a brief null window is expected). After MAX attempts → the
		// obs-down fallback (OUTCOME-only rollup) — never hard-block on telemetry.
		// P6: a claude worker emits NO obs telemetry (it is not a pi process), and the sweep does not
		// re-tick a claude slot to retry — so skip the resolution dance entirely and finalize in this
		// single direct call with telemetry marked unavailable. The diff harvest (below) is the payload.
		if (!slot.sessionId && slot.driver !== "claude") {
			slot.sessionId = await this.d.obs.resolveSessionIdByTag(`run:${slot.runId}`);
			if (!slot.sessionId) {
				slot.resolveAttempts += 1;
				if (slot.resolveAttempts < MAX_RESOLVE_ATTEMPTS) return; // retry next sweep tick
			}
		}

		slot.harvested = true; // commit to finalizing (idempotency)

		// Telemetry (best-effort). Every obs call already carries the Bearer token.
		let telemetryOk = false;
		let cost = 0;
		let tokens = 0;
		let errorCount = 0;
		if (slot.sessionId) {
			const { ok, stats } = await this.d.obs.getStats(slot.sessionId);
			if (ok && stats) {
				telemetryOk = true;
				cost = stats.total_cost;
				tokens = stats.total_tokens;
				errorCount = stats.error_count;
			}
		}

		// Slice 3: UNIFIED git diff harvest (replaces the old code-card vs artifact-card branch).
		// The worker's cwd IS the worktree. Stage everything, produce a staged diff against the
		// worktree's CREATION BASE — NOT live HEAD. A worker may `git commit` inside its worktree
		// (moving HEAD onto its own commit); a HEAD-diff would then be empty and silently break
		// the merge-back. The base is recorded on the lifecycle handle at worktree creation.
		let diffStatus = "git diff unavailable";
		let diffChanged = false;
		let diffPath = "";
		let engineTouched = false;
		try {
			const base = this.d.wsMgr?.getWorkspace(slot.cardId)?.baseCommit ?? "HEAD";
			const diff = gitStageAndDiff(slot.cwd, base);
			diffPath = join(slot.scopedDir, "card.diff");
			fs.writeFileSync(diffPath, diff, "utf8");
			if (diff.trim().length === 0) {
				diffStatus = "clean";
				this.log("EXEC_DIFF_EMPTY", { card: slot.cardId });
			} else {
				const fileCount = diff.split("\n").filter((l) => l.startsWith("diff --git")).length;
				diffChanged = true;
				diffStatus = `changed (${fileCount} file(s))`;
				// Slice 4: check whether the diff touches the card-engine or other owner-loaded extensions.
				engineTouched = gitCheckEngineTouched(diffPath);
			}
		} catch (err) {
			this.log("EXEC_DIFF_ERROR", { card: slot.cardId, error: String(err) });
		}

		// Slice 4: write a human-readable `## Diff` section to the card body so the
		// Obsidian surface renders the real diff at Needs Review. If no diff is
		// available (git error), write a note explaining why.
		if (diffChanged && diffPath) {
			try {
				const diffText = fs.readFileSync(diffPath, "utf8");
				// Truncate to a reasonable size for Obsidian rendering (50KB / ~1000 lines).
				const maxLen = 50_000;
				const truncated = diffText.length > maxLen
					? diffText.slice(0, maxLen) + `\n\n... (truncated at ${maxLen} bytes, full diff at ${diffPath})`
					: diffText;
				const diffSection = `\`\`\`diff\n${truncated}\n\`\`\``;
				const currentText = fs.readFileSync(slot.file, "utf8");
				const updated = upsertBodySection(currentText, "Diff", diffSection);
				if (updated !== currentText) fs.writeFileSync(slot.file, updated, "utf8");
			} catch {
				/* best-effort — the card.diff is still on disk */
			}
		} else if (!diffChanged) {
			try {
				const currentText = fs.readFileSync(slot.file, "utf8");
				const updated = upsertBodySection(currentText, "Diff", "_(worktree clean — no changes produced)_");
				if (updated !== currentText) fs.writeFileSync(slot.file, updated, "utf8");
			} catch {
				/* best-effort */
			}
		}

		// Outcome + escalate-by-exception flags.
		const hasOutcomeLine = /^[ \t]*OUTCOME:/im.test(slot.completionOutput);
		let outcome = extractOutcome(slot.completionOutput);
		if (!diffChanged) outcome = `${outcome} [⚠ no change produced — worktree clean]`;
		if (engineTouched) outcome = `${outcome} [⚠ ENGINE TOUCHED — owner must /reload after Filed]`;
		const durationS = Math.max(0, Math.round((this.now() - slot.startedAt) / 1000));

		const annotations: Record<string, string> = {
			cost_total: telemetryOk ? String(round6(cost)) : '"unknown (telemetry unavailable)"',
			tokens: telemetryOk ? String(Math.round(tokens)) : "0",
			duration_s: String(durationS),
			outcome: JSON.stringify(outcome),
			diff_status: diffStatus,
		};
		if (engineTouched) annotations.reload_required = "true";
		if (!telemetryOk) annotations.telemetry = "unavailable";
		const flags: string[] = [];
		if (telemetryOk && errorCount > 0) flags.push(`errors:${errorCount}`);
		if (!hasOutcomeLine) flags.push("no-outcome-line");
		if (flags.length) annotations.review_flag = JSON.stringify(flags.join(", "));

		// SYNC board write + snapshot (loop-suppressed — no await between these two).
		writeStatus(slot.file, "Needs Review", {
			annotations,
			logLine:
				`worker complete: Executing → Needs Review ` +
				`(cost ${telemetryOk ? round6(cost) : "n/a"}, ${telemetryOk ? Math.round(tokens) : "?"} tok, ${durationS}s` +
				`, diff ${diffStatus}` +
				`${engineTouched ? ", ENGINE TOUCHED" : ""}` +
				`${flags.length ? `, FLAGGED ${flags.join("/")}` : ""})`,
		});
		this.d.reconciler.snapshot.set(slot.cardId, "Needs Review");
		const logExtras: Record<string, unknown> = { card: slot.cardId, cost_total: telemetryOk ? round6(cost) : null, tokens: telemetryOk ? Math.round(tokens) : null, duration_s: durationS, error_count: errorCount, telemetry: telemetryOk ? "ok" : "unavailable", outcome, diff_status: diffStatus, diff_changed: diffChanged, engine_touched: engineTouched };
		this.log("EXEC_COMPLETE", logExtras);
		this.d.host.notify(`🃏 ${slot.cardId} → Needs Review · ${telemetryOk ? `$${round6(cost)} · ${Math.round(tokens)} tok` : "telemetry n/a"} · ${durationS}s${diffChanged ? ` · diff ${diffStatus}` : " · worktree clean"}${engineTouched ? " · ⚠ ENGINE TOUCHED — /reload required after Filed" : ""}${flags.length ? ` · ⚠ ${flags.join("/")}` : ""}`, (flags.length || engineTouched) ? "warning" : "info");

		// Free the slot + nudge the drain, then COCKPIT teardown: paint the chip idle, snapshot
		// the pane output for the human, and CLOSE the worker's pane (not the workspace — the
		// cockpit persists). Freeing the pane keeps the cockpit showing only live workers; the
		// card + its diff/pane-output.txt carry the evidence to Needs Review.
		this.slots.delete(slot.cardId);
		this.d.host.events.emit("exec:idle", {});
		await this.teardownPane(slot);
	}

	// ── budget kill / watchdog escalation / halt kill ──────────────────────────
	private async budgetKill(slot: WorkerSlot, cost: number): Promise<void> {
		if (slot.harvested) return;
		slot.harvested = true;
		const reason = `budget exceeded ($${round6(cost)} > cap $${this.d.cardBudgetUsd})`;
		writeStatus(slot.file, "Needs Review", {
			annotations: { cost_total: String(round6(cost)), interrupted: "true", outcome: JSON.stringify(reason), review_flag: JSON.stringify("budget") },
			logLine: `BUDGET KILL: Executing → Needs Review (${reason})`,
		});
		this.d.reconciler.snapshot.set(slot.cardId, "Needs Review");
		this.log("EXEC_BUDGET_EXCEEDED", { card: slot.cardId, cost_total: round6(cost), cap: this.d.cardBudgetUsd });
		this.d.host.notify(`🛑 ${slot.cardId}: ${reason} — killed → Needs Review`, "warning");
		this.slots.delete(slot.cardId);
		this.d.host.events.emit("exec:idle", {});
		await this.teardownPane(slot); // COCKPIT: close the over-budget worker's pane (frees the cockpit slot)
	}

	private async escalateWatchdog(slot: WorkerSlot, reason: string): Promise<void> {
		if (slot.harvested) return;
		slot.harvested = true;
		writeStatus(slot.file, "Needs Review", {
			annotations: { interrupted: "true", outcome: JSON.stringify(`execution escalated (watchdog: ${reason})`), review_flag: JSON.stringify("watchdog") },
			logLine: `watchdog: Executing → Needs Review (${reason})`,
		});
		this.d.reconciler.snapshot.set(slot.cardId, "Needs Review");
		this.log("EXEC_ESCALATED", { card: slot.cardId, mechanism: "watchdog", errorClass: "terminal", reason });
		this.d.host.notify(`🛑 watchdog: ${slot.cardId} → Needs Review (${reason})`, "warning");
		this.slots.delete(slot.cardId);
		this.d.host.events.emit("exec:idle", {});
		await this.teardownPane(slot); // COCKPIT: close the escalated worker's pane (frees the cockpit slot)
	}

	/** /halt: kill an active worker (close its cockpit pane, free the slot, rm scoped dir). Status
	 *  is the caller's (index.ts /halt) responsibility (it also sets halt:true + → Needs Review).
	 *  wsMgr.haltKill() (called from index.ts) removes the worktree; this closes the pane. */
	async haltKill(cardId: string): Promise<void> {
		const slot = this.slots.get(cardId);
		if (!slot) return;
		slot.harvested = true;
		this.slots.delete(cardId);
		this.log("EXEC_HALT_KILL", { card: cardId, workspace: slot.workspaceId });
		this.d.host.events.emit("exec:idle", {});
		await this.getCockpit().close(workerLabel(cardId)); // COCKPIT: close the worker's pane
		this.pruneScopedDir(slot.cardId); // halt = deliberate kill, prune immediately
	}

	// ── reapers (teardown integrity) ───────────────────────────────────────────
	/** COCKPIT teardown for one slot: paint the chip idle, snapshot the pane output for the
	 *  human, then CLOSE the worker's pane (never the shared cockpit workspace). All best-effort
	 *  — a renumbered/gone pane resolves to a no-op. */
	private async teardownPane(slot: WorkerSlot): Promise<void> {
		const paneLabel = workerLabel(slot.cardId);
		const cockpit = this.getCockpit();
		try { await cockpit.report(paneLabel, "idle"); } catch { /* best-effort */ }
		if (slot.paneId) {
			try {
				const paneOutput = await this.d.herdr.paneRead(slot.paneId, "recent", PANE_READ_LINES);
				fs.writeFileSync(join(slot.scopedDir, "pane-output.txt"), paneOutput, "utf8");
			} catch { /* best-effort — pane may already be gone */ }
		}
		try { await cockpit.close(paneLabel); } catch { /* best-effort */ }
	}

	/** Delete the scoped dir for a card (idempotent — one-shot existence guard).
	 *  Public so the post-terminal subscribers in index.ts can call it. */
	pruneScopedDir(cardId: string): void {
		const scopedDir = scopedDirFor({ scopedBase: this.scopedBase }, cardId);
		try {
			if (fs.existsSync(scopedDir)) fs.rmSync(scopedDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}

	/**
	 * Startup reaper (the workspace analogue of startupRecovery): close every
	 * `card-<id>`-labelled workspace whose card is NOT `Executing` in the freshly-seeded
	 * snapshot — an orphan left by an owner crash. (startupRecovery already moves a stuck
	 * Executing card to Needs Review, so after it runs no card is Executing and ALL
	 * card-* workspaces are orphans to reap.)
	 */
	async startupReaper(): Promise<void> {
		const workspaces = await this.d.herdr.workspaceList();
		for (const ws of workspaces) {
			const m = ws.label.match(/^card-(.+)$/);
			if (!m) continue;
			const cardId = m[1];
			if (this.d.reconciler.snapshot.get(cardId) === "Executing") continue; // a live (just-recovered) card keeps its ws
			await this.d.herdr.workspaceClose(ws.workspace_id);
			this.log("EXEC_WORKSPACE_REAPED", { card: cardId, workspace: ws.workspace_id, where: "startup" });
			this.d.host.notify(`🃏 reaped orphan worker workspace card-${cardId}`, "info");
		}
	}

	/** session_shutdown: close ALL active worker PANES (don't strand them on reload/exit). The
	 *  cockpit workspace itself persists (the owner-launcher recreates a clean one next boot).
	 *  Scoped dirs for non-terminal cards SURVIVE — pruned when the card reaches
	 *  Filed/Archived/Quarantine on the next owner session. */
	async reapAll(): Promise<void> {
		const cockpit = this.getCockpit();
		for (const slot of [...this.slots.values()]) {
			this.slots.delete(slot.cardId);
			await cockpit.close(workerLabel(slot.cardId));
		}
	}

	// ── worker prompt construction ─────────────────────────────────────────────
	/**
	 * The worker's task.md (read by the worker, NOT echoed as a chat input). The completion
	 * sentinel is described with a PLACEHOLDER (`CARDID`) the worker must substitute with the
	 * real id — so neither the steer nor a `read` of this file ever emits the *concrete*
	 * sentinel the owner matches (defeats the echo false-positive; the leave-idle guard backs it).
	 *
	 * Slice 3: the worker's cwd is a per-card git worktree. Both code and artifact cards edit
	 * files INSIDE the worktree — the diff IS the harvest artifact.
	 */
	private buildWorkerTask(slot: WorkerSlot, instruction: string): string {
		const domainCtx = `domains/${slot.domain}/CONTEXT.md`;
		const isCodeCard = slot.cardType === "ops" || slot.cardType === "maintenance";
		if (isCodeCard) {
			return (
				`# Worker task — card \`${slot.cardId}\` (domain: ${slot.domain}, type: CODE)\n\n` +
				`You are an execution-only worker running inside a PER-CARD GIT WORKTREE.\n` +
				`Your cwd IS the worktree root — a clean checkout of the main repo at HEAD.\n` +
				`Your edits inside this worktree will produce a git diff that IS your output.\n\n` +
				`CRITICAL SAFETY RULES:\n` +
				`- NEVER run git commit / git push / git commit --amend / git merge. Leave your edits UNCOMMITTED in the working tree — the owner captures your diff and applies it after approval. (push/amend/merge are also hard-blocked by worker-guard.)\n` +
				`- NEVER edit anything outside this worktree (BLOCKED by worker-guard).\n` +
				`- NEVER write the card's frontmatter or status — the owner owns that.\n\n` +
				`## Instruction\n${instruction}\n\n` +
				`## Load context first (read-only)\n` +
				`- Read \`${domainCtx}\` and the refs/ it points to, as the task needs.\n` +
				`- Read \`knowledge/FILING.md\` for filing conventions (the owner uses it; you will NOT write an artifact).\n\n` +
				`## Do the work\n` +
				`- Apply the edits to the named files INSIDE this worktree. Run the verify command(s).\n` +
				`- Make substantive changes — whitespace-only or idempotent edits may produce an empty diff.\n` +
				`- Your diff is the build-review artifact — the owner applies it after human approval.\n\n` +
				`## Completion contract (follow EXACTLY)\n` +
				`End your FINAL assistant message with these two lines:\n` +
				"```\n" +
				`OUTCOME: <files changed + verify result>\n` +
				`<<CARD-DONE:CARDID>>>\n` +
				"```\n" +
				`Replace the token CARDID with this card's id, which is \`${slot.cardId}\`, so the final line reads the marker for this card. Do NOT print the literal word CARDID. Do NOT change the card's status — the owner moves it to Needs Review.\n`
			);
		}
		// ARTIFACT contract (default for research, content, strategy, or missing/unknown card_type):
		return (
			`# Worker task — card \`${slot.cardId}\` (domain: ${slot.domain})\n\n` +
			`You are an execution-only worker running inside a PER-CARD GIT WORKTREE.\n` +
			`Your cwd IS the worktree root — a clean checkout of the main repo at HEAD.\n` +
			`Write your durable artifact(s) to the REAL knowledge paths INSIDE this worktree\n` +
			`(e.g. \`domains/${slot.domain}/refs/my-analysis.md\` for domain artifacts,\n` +
			`or \`knowledge/decisions/my-decision.md\` for cross-domain artifacts).\n` +
			`Your edits to these paths will produce a git diff that IS your output —\n` +
			`the owner applies the diff after human approval.\n\n` +
			`CRITICAL SAFETY RULES:\n` +
			`- NEVER run git commit / git push / git commit --amend / git merge. Leave your edits UNCOMMITTED in the working tree — the owner captures your diff and applies it after approval. (push/amend/merge are also hard-blocked by worker-guard.)\n` +
			`- NEVER edit anything outside this worktree (BLOCKED by worker-guard).\n` +
			`- NEVER write the card's frontmatter or status — the owner owns that.\n\n` +
			`## Instruction\n${instruction}\n\n` +
			`## Load context first (read-only)\n` +
			`- Read \`${domainCtx}\` and the refs/ it points to, as the task needs.\n` +
			`- Read \`knowledge/FILING.md\` — your artifact MUST carry the frontmatter + kebab-case filename it describes.\n\n` +
			`## Do the work\n` +
			`- Execute the instruction and write the resulting durable artifact(s) to their knowledge paths inside this worktree (e.g. \`domains/${slot.domain}/refs/<kebab>.md\`). Use the write or edit tool with absolute paths.\n` +
			`- Produce real artifacts with the FILING.md frontmatter; do not merely describe what you would do.\n\n` +
			`## Completion contract (follow EXACTLY)\n` +
			`End your FINAL assistant message with these two lines:\n` +
			"```\n" +
			`OUTCOME: <one-line summary of what you produced and where you wrote it>\n` +
			`<<CARD-DONE:CARDID>>>\n` +
			"```\n" +
			`Replace the token CARDID with this card's id, which is \`${slot.cardId}\`, so the final line reads the marker for this card. Do NOT print the literal word CARDID. Do NOT change the card's status — the owner moves it to Needs Review and files your artifact.\n`
		);
	}

	/** The short kickoff steer injected into the worker REPL (points at task.md). */
	private buildSteer(slot: WorkerSlot): string {
		return `Read and execute the task in ${join(slot.scopedDir, "task.md")} now, end to end. Follow its completion contract exactly.`;
	}

	/** The execution-only worker launch command (run inside the herdr pane). */
	private buildLaunchCommand(slot: WorkerSlot): string {
		const vault = shellQuote(slot.cwd); // Slice 3: slot.cwd IS the git worktree
		const sessionDir = `${slot.scopedDir}/.session`;
		// The three worker extensions load from engineRoot (default ".pi/extensions" → the same
		// relative paths as before, byte-for-byte; the owner passes an ABSOLUTE engineRoot so a
		// worker in a per-card worktree loads the OWNER's canonical extensions, not the worktree copy).
		const dc = join(this.engineRoot, "damage-control.ts");
		const obsExt = join(this.engineRoot, "pi-observability.ts");
		const wg = join(this.engineRoot, "worker-guard/index.ts");
		// obs pool routing — only when a pool is configured (no flag → byte-for-byte today).
		const poolArg = this.pool ? `--o-pool ${shellQuote(this.pool)} ` : "";
		// --no-extensions disables discovery (NO card-engine); the explicit -e paths still load.
		// HOLDCO_CARD_DIR = the worktree root — worker-guard scopes writes to the worktree.
		return (
			`cd ${vault} && OBS_AUTH_TOKEN=${shellQuote(this.d.obsToken)} OBS_SERVER_URL=${shellQuote(this.d.obsServerUrl)} HOLDCO_CARD_DIR=${shellQuote(slot.cwd)} ` +
			`pi --no-extensions ` +
			`-e ${dc} -e ${obsExt} -e ${wg} ` +
			`--o-name card-${slot.cardId} --o-tag card:${slot.cardId} --o-tag run:${slot.runId} ${poolArg}` +
			`--session-dir ${shellQuote(sessionDir)}`
		);
	}

	// ── claude worker prompt + launch command (P6) ─────────────────────────────
	/**
	 * The claude worker's INLINE initial prompt (self-contained — passed as the `claude` positional arg,
	 * so claude needs no read of a file outside its worktree cwd). Mirrors the Pi task's safety contract
	 * (claude has NO worker-guard — the rules here + the worktree cwd are the only scope boundary), then
	 * the completion contract: print an `OUTCOME:` line, then run the echo sentinel as the FINAL action.
	 *
	 * SENTINEL SAFETY: the concrete match string (`FLEET_DONE_<id>`) must NEVER appear verbatim in this
	 * prompt — `herdr wait output` level-scans the pane, and the initial-prompt echo would false-match
	 * before any work runs. So the marker prefix and the id are given SEPARATELY (a `<CARDID>`
	 * placeholder), and only the worker's own `echo` assembles + emits the concrete string.
	 */
	private buildClaudePrompt(slot: WorkerSlot, instruction: string): string {
		const domainCtx = `domains/${slot.domain}/CONTEXT.md`;
		const isCodeCard = slot.cardType === "ops" || slot.cardType === "maintenance";
		const kind = isCodeCard ? "CODE" : "ARTIFACT";
		const workLine = isCodeCard
			? `Apply the edits to the named files INSIDE this worktree, then run the verify command(s). Make substantive changes — a whitespace-only edit produces an empty diff.`
			: `Write your durable artifact(s) to their real knowledge paths INSIDE this worktree (e.g. \`domains/${slot.domain}/refs/<kebab>.md\`, or \`knowledge/decisions/<kebab>.md\` for cross-domain) with the FILING.md frontmatter. Do not merely describe what you would do.`;
		return (
			`You are an execution-only Claude worker for card \`${slot.cardId}\` (domain: ${slot.domain}, type: ${kind}).\n` +
			`Your cwd IS a per-card git worktree — a clean checkout of the project repo. Your edits here produce a git diff that IS your output; the owner applies it after human approval.\n\n` +
			`CRITICAL SAFETY RULES (there is no worker-guard here — obey them):\n` +
			`- NEVER run git commit / git push / git commit --amend / git merge / git apply. Leave every edit UNCOMMITTED in the working tree.\n` +
			`- NEVER edit anything OUTSIDE this worktree directory.\n` +
			`- NEVER edit the card's frontmatter or status — the owner engine owns that.\n\n` +
			`## Instruction\n${instruction}\n\n` +
			`## Load context first (read-only)\n` +
			`- Read \`${domainCtx}\` and the refs/ it points to, as the task needs.\n` +
			`- Read \`knowledge/FILING.md\` for filing conventions.\n\n` +
			`## Do the work\n- ${workLine}\n\n` +
			`## Completion contract (follow EXACTLY)\n` +
			`Your card id is: ${slot.cardId}\n` +
			`When the work is done: (1) print one line starting \`OUTCOME:\` summarising what you produced and where; (2) as your VERY LAST action, use the Bash tool to run this exact command, substituting <CARDID> with the card id above:\n` +
			`    echo FLEET_DONE_<CARDID>\n` +
			`so the echoed line is the marker \`FLEET_DONE_\` immediately followed by ${slot.cardId}. Do NOT print that combined marker anywhere before that final echo, and do NOT change the card's status.\n`
		);
	}

	/** The claude worker launch command run inside the herdr pane: `cd <worktree> && claude … "<prompt>"`.
	 *  REPL (never `-p`/--print); --dangerously-skip-permissions makes it autonomous in the pane (the
	 *  worktree is the isolation boundary). The prompt is single-quoted, so its newlines + quotes survive
	 *  as ONE positional initial-prompt arg. */
	private buildClaudeLaunchCommand(slot: WorkerSlot, instruction: string): string {
		const wt = shellQuote(slot.cwd);
		const prompt = shellQuote(this.buildClaudePrompt(slot, instruction));
		return `cd ${wt} && claude --dangerously-skip-permissions ${prompt}`;
	}

	// Stale-safe: pool.sweep()/startupReaper() are fired fire-and-forget (`void pool.sweep()`)
	// and await obs/herdr network calls (100ms–4s) before reaching here. A host whose log sink
	// is torn down mid-continuation (the Pi /reload case) could throw from entry() → unhandled
	// promise rejection → process exit (Node ≥15). The try/catch swallows that; the log line is
	// non-essential, the process surviving is.
	private log(event: string, data: Record<string, unknown>): void {
		try {
			this.d.host.log.entry("card-engine-log", { event, ...data, ts: new Date().toISOString() });
		} catch {
			/* host sink threw */
		}
	}
}

// ── module-level helpers ──────────────────────────────────────────────────────

const FM_RE = /^---\n([\s\S]*?)\n---/;

function readField(file: string, key: string): string {
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
	const m = text.match(FM_RE);
	if (!m) return "";
	const fm = m[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
	if (!fm) return "";
	let v = fm[1].trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
	return v;
}

/** Single-quote a string for safe embedding in a `sh -c` command. */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}
