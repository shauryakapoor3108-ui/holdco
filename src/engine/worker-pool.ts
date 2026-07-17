// worker-pool.ts — N-slot execution: one isolated worker per card, driven through
// the Harness seam.
//
// The single-owner invariant: the engine stays the SOLE process owning the
// reconciler + snapshot + queue-drain and the SOLE writer of `status`. EXECUTION
// happens in workers spawned through a Harness adapter (Pi pane, Claude Code
// headless session, Codex — the pool neither knows nor cares). The pool is the
// harness-NEUTRAL machinery: slot accounting, circuit breaker, per-run budget
// kill, activity watchdog, the unified git-diff harvest, board-state writes.
// Everything transport-specific (launch commands, steer delivery, sentinels,
// completion detection, telemetry sources) lives in the adapter behind
// spawn / inject / poll / collect / dispose.
//
// Disciplines carried from the source system, all still enforced here:
//   • slot reservation is SYNCHRONOUS (freeSlots decrements before any await) —
//     a same-tick second offer cannot double-allocate (TOCTOU).
//   • every `writeStatus` is paired with a synchronous `snapshot.set`, no await
//     between them (loop-suppression: the reconciler must never re-detect the
//     engine's own write as a human move and auto-revert it).
//   • poll failures are verdicts for the watchdog, never crashes for the sweep.
//   • the diff harvest runs against the worktree's CREATION BASE, not live HEAD
//     (a worker may commit inside its worktree; a HEAD-diff would silently lose
//     the merge-back).

import * as fs from "node:fs";
import { join, relative } from "node:path";
import type { EngineHost } from "../host/host.ts";
import type { Harness, HarnessSession, SafetyPolicy } from "../harness/types.ts";
import { DEFAULT_DENY_COMMANDS } from "../harness/types.ts";
import { DEFAULT_SCOPED_BASE, scopedDirFor } from "./workspace-paths.ts";
import { readInstruction } from "./executor.ts";
import { writeStatus } from "./frontmatter.ts";
import { gitCheckEngineTouched, gitStageAndDiff } from "./git-ops.ts";
import { upsertBodySection } from "./frontmatter.ts";
import type { Reconciler } from "./reconciler.ts";
import type { WorkspaceManager } from "./workspace-manager.ts";

/** Circuit breaker: max spawns of one card per session before a HARD STOP (runaway guard). */
const MAX_DISPATCHES_PER_SESSION = 3;

export interface WorkerSlot {
	cardId: string;
	file: string;
	relPath: string;
	domain: string;
	cardType: string;
	/** The Harness adapter driving this card (per-card `worker:` field or the pool default). */
	harnessName: string;
	cwd: string; // the git worktree root (<scopedBase>/<id>/worktree)
	runId: string; // per-spawn nonce → telemetry correlation tag
	scopedDir: string; // <scopedBase>/<card-id> (metadata dir; worktree lives inside it)
	startedAt: number;
	session: HarnessSession | null; // set once spawn resolves
	launching: boolean; // true until the adapter's spawn resolves
	lastActivityAt: number; // freshest signal for the watchdog (poll may refine it)
	harvested: boolean; // idempotency guard against a double-finalize
}

export interface WorkerPoolDeps {
	host: EngineHost;
	reconciler: Reconciler;
	/** Registered adapters by name. A card's `worker:` frontmatter selects one. */
	harnesses: Record<string, Harness>;
	/** Adapter used when a card has no `worker:` field. */
	defaultHarness: string;
	maxSlots: number;
	cardBudgetUsd: number;
	watchdogMs: number;
	wsMgr?: WorkspaceManager; // lifecycle workspace manager (worktree provider)
	now?: () => number;
	/** Base dir for per-card scoped dirs. Default DEFAULT_SCOPED_BASE. */
	scopedBase?: string;
	/** Model requested from the adapter (routing lands here in a later milestone). */
	model?: string;
	/** Policy override; default = write-scoped to the worktree + scoped dir, DEFAULT_DENY_COMMANDS. */
	policyFor?: (slot: WorkerSlot) => SafetyPolicy;
}

export class WorkerPool {
	private readonly slots = new Map<string, WorkerSlot>();
	private readonly dispatchCounts = new Map<string, number>();
	private readonly launches: Promise<void>[] = [];
	private sweeping = false;
	private readonly d: WorkerPoolDeps;
	private readonly now: () => number;
	private readonly scopedBase: string;

	constructor(deps: WorkerPoolDeps) {
		this.d = deps;
		this.now = deps.now ?? (() => Date.now());
		this.scopedBase = deps.scopedBase ?? DEFAULT_SCOPED_BASE;
	}

	/** Resolve the adapter for a card — a per-card `worker:` frontmatter field wins,
	 *  else the pool default. An UNREGISTERED name returns null (dispatch escalates
	 *  loudly instead of stalling the card in Executing). */
	private harnessFor(file: string): { name: string; harness: Harness } | null {
		const field = readField(file, "worker").toLowerCase();
		const name = field || this.d.defaultHarness;
		const harness = this.d.harnesses[name];
		return harness ? { name, harness } : null;
	}

	// ── slot accounting (the gate the queue drain reads) ───────────────────────
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

	// ── dispatch (synchronous: breaker → no-brief → reserve + async spawn) ─────
	/**
	 * Called by the drain AFTER it has written the loop-suppressed
	 * `Queued → Executing` edge (snapshot-synced). The slot reservation is
	 * SYNCHRONOUS; the adapter spawn proceeds asynchronously and fills in the
	 * session on the reserved slot.
	 */
	dispatch(cardId: string, file: string, ctx?: { cwd?: string }): void {
		// Circuit breaker — a card spawned too many times this session is HARD-STOPPED
		// (suspected runaway). The counter persists across the card's lifecycle.
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
			this.d.host.notify(`🛑 circuit breaker: ${cardId} halted after ${dispatches - 1} spawns — unhalt to clear`, "warning");
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

		// Adapter resolution — an unknown `worker:` name is a LOUD failure, not a stall.
		const resolved = this.harnessFor(file);
		if (!resolved) {
			const reason = `unknown harness "${readField(file, "worker") || this.d.defaultHarness}" — no such adapter registered`;
			writeStatus(file, "Needs Review", {
				annotations: { interrupted: "true", outcome: JSON.stringify(reason), review_flag: JSON.stringify("no-harness") },
				logLine: `dispatch failed: ${reason}`,
			});
			this.d.reconciler.snapshot.set(cardId, "Needs Review");
			this.log("EXEC_NO_HARNESS", { card: cardId, reason });
			this.d.host.notify(`⛔ ${cardId}: ${reason}`, "warning");
			this.d.host.events.emit("exec:idle", {});
			return;
		}

		// HARDENING 1: when wsMgr IS present (production), a card reaching Executing
		// WITHOUT a lifecycle worktree is an isolation breach — the shared-repo
		// execution path is unreachable. QUARANTINE instead of falling back.
		const boardRoot = ctx?.cwd ?? process.cwd();
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
		const cwd: string = lifecycleWs?.worktreePath ?? boardRoot;
		const domain = readField(file, "domain") || "root";
		const cardType = readField(file, "card_type") || "";
		if (!cardType) {
			this.log("EXEC_NO_CARD_TYPE", { card: cardId, detail: "no card_type in frontmatter — defaulting to artifact contract" });
		}

		// Reserve the slot SYNCHRONOUSLY (freeSlots decrements now), then spawn async.
		const slot: WorkerSlot = {
			cardId,
			file,
			relPath: relative(boardRoot, file),
			domain,
			cardType,
			harnessName: resolved.name,
			cwd,
			runId: `${cardId}-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
			scopedDir: scopedDirFor({ scopedBase: this.scopedBase }, cardId),
			startedAt: this.now(),
			session: null,
			launching: true,
			lastActivityAt: this.now(),
			harvested: false,
		};
		this.slots.set(cardId, slot);
		this.log("EXEC_DISPATCH", { card: cardId, domain, harness: resolved.name, runId: slot.runId, file: slot.relPath, worktree: cwd });
		this.d.host.notify(`🃏 spawning ${resolved.name} worker for ${cardId} (${this.activeCount()}/${this.d.maxSlots} slots)`, "info");
		this.launches.push(this.launch(slot, resolved.harness, instruction));
	}

	/** Await every in-flight spawn (test helper + shutdown safety). */
	async settleLaunches(): Promise<void> {
		await Promise.allSettled(this.launches.splice(0));
	}

	private policyFor(slot: WorkerSlot): SafetyPolicy {
		if (this.d.policyFor) return this.d.policyFor(slot);
		return { writeScopes: [slot.cwd, slot.scopedDir], denyCommands: [...DEFAULT_DENY_COMMANDS] };
	}

	// ── spawn (async; spawn is the ONE adapter verb allowed to throw) ──────────
	private async launch(slot: WorkerSlot, harness: Harness, instruction: string): Promise<void> {
		try {
			fs.mkdirSync(slot.scopedDir, { recursive: true });
			const session = await harness.spawn({
				workspace: { cardId: slot.cardId, dir: slot.cwd, scopedDir: slot.scopedDir },
				instruction,
				card: { id: slot.cardId, domain: slot.domain, cardType: slot.cardType },
				runId: slot.runId,
				model: this.d.model,
				policy: this.policyFor(slot),
			});
			slot.session = session;
			slot.launching = false;
			slot.lastActivityAt = this.now();
			this.log("EXEC_WORKER_SPAWNED", { card: slot.cardId, harness: slot.harnessName, runId: slot.runId, promptRef: session.promptRef });
		} catch (err) {
			this.failLaunch(slot, `spawn failed (${slot.harnessName}): ${String(err)}`);
		}
	}

	/** A launch that could not establish a worker → escalate the card, free the slot. */
	private failLaunch(slot: WorkerSlot, reason: string): void {
		// SYNC board write + snapshot (loop-suppressed), then teardown.
		writeStatus(slot.file, "Needs Review", {
			annotations: { interrupted: "true", outcome: JSON.stringify(`worker launch failed: ${reason}`) },
			logLine: `worker launch failed: Executing → Needs Review (${reason})`,
		});
		this.d.reconciler.snapshot.set(slot.cardId, "Needs Review");
		this.log("EXEC_ESCALATED", { card: slot.cardId, mechanism: "launch-failure", errorClass: "terminal", reason });
		this.d.host.notify(`🛑 ${slot.cardId}: worker launch failed → Needs Review`, "warning");
		this.slots.delete(slot.cardId);
		this.d.host.events.emit("exec:idle", {});
		// The wsMgr worktree / scoped dir is NOT pruned here — the evidence survives to
		// Needs Review, pruned only at a terminal state. Only the pre-lifecycle fallback
		// (no wsMgr handle for this card) prunes its scoped dir.
		if (!this.d.wsMgr?.hasWorkspace(slot.cardId)) this.pruneScopedDir(slot.cardId);
	}

	// ── sweep (non-blocking monitor of every active slot, on the engine tick) ──
	async sweep(): Promise<void> {
		if (this.sweeping) return; // reentrancy guard — a slow tick must not overlap the next
		this.sweeping = true;
		try {
			for (const slot of [...this.slots.values()]) {
				if (slot.launching || !slot.session) continue; // still spawning — nothing to monitor yet
				await this.monitorSlot(slot);
			}
		} finally {
			this.sweeping = false;
		}
	}

	private async monitorSlot(slot: WorkerSlot): Promise<void> {
		const harness = this.d.harnesses[slot.harnessName];
		if (!harness || !slot.session) return;
		const p = await harness.poll(slot.session); // contract: never throws

		if (p.lastActivityAt && p.lastActivityAt > slot.lastActivityAt) slot.lastActivityAt = p.lastActivityAt;

		// Per-run budget: kill a worker that overspends (mid-run cost from poll).
		if (p.costUsd !== undefined && p.costUsd > this.d.cardBudgetUsd) {
			await this.budgetKill(slot, harness, p.costUsd);
			return;
		}

		if (p.state === "done") {
			await this.finalize(slot, harness);
			return;
		}
		if (p.state === "failed") {
			await this.escalateWatchdog(slot, harness, "harness reported terminal failure");
			return;
		}
		// "unknown" is a transport hiccup, not a verdict — the activity watchdog below
		// is the backstop for a worker that never answers again.
		if (this.now() - slot.lastActivityAt > this.d.watchdogMs) {
			await this.escalateWatchdog(slot, harness, `no worker activity for ${Math.round((this.now() - slot.lastActivityAt) / 1000)}s`);
		}
	}

	// ── finalize / harvest (owner is the sole board + status writer) ───────────
	private async finalize(slot: WorkerSlot, harness: Harness): Promise<void> {
		if (slot.harvested) return;
		slot.harvested = true; // commit to finalizing (idempotency)

		// Telemetry + outcome through the adapter (degrades gracefully: usage null).
		const artifacts = await harness.collect(slot.session!);
		const telemetryOk = artifacts.usage !== null;
		const cost = telemetryOk ? round6(artifacts.usage!.costUsd) : 0;
		const tokens = telemetryOk ? Math.round(artifacts.usage!.tokensIn + artifacts.usage!.tokensOut) : 0;
		const errorCount = artifacts.errorCount ?? 0;

		// UNIFIED git diff harvest. The worker's cwd IS the worktree. Stage everything,
		// diff against the worktree's CREATION BASE — NOT live HEAD (a worker may
		// `git commit` inside its worktree; a HEAD-diff would then be empty and
		// silently break the merge-back).
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
				engineTouched = gitCheckEngineTouched(diffPath);
			}
		} catch (err) {
			this.log("EXEC_DIFF_ERROR", { card: slot.cardId, error: String(err) });
		}

		// Human-readable `## Diff` section on the card body (the review surface shows
		// the real diff at Needs Review). Best-effort.
		if (diffChanged && diffPath) {
			try {
				const diffText = fs.readFileSync(diffPath, "utf8");
				const maxLen = 50_000;
				const truncated =
					diffText.length > maxLen ? diffText.slice(0, maxLen) + `\n\n... (truncated at ${maxLen} bytes, full diff at ${diffPath})` : diffText;
				const currentText = fs.readFileSync(slot.file, "utf8");
				const updated = upsertBodySection(currentText, "Diff", `\`\`\`diff\n${truncated}\n\`\`\``);
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
		const hasOutcomeLine = /^[ \t]*OUTCOME:/im.test(artifacts.outputTail);
		let outcome = artifacts.outcome;
		if (!diffChanged) outcome = `${outcome} [⚠ no change produced — worktree clean]`;
		if (engineTouched) outcome = `${outcome} [⚠ ENGINE TOUCHED — owner must reload after Filed]`;
		const durationS = Math.max(0, Math.round((this.now() - slot.startedAt) / 1000));

		const annotations: Record<string, string> = {
			cost_total: telemetryOk ? String(cost) : '"unknown (telemetry unavailable)"',
			tokens: telemetryOk ? String(tokens) : "0",
			duration_s: String(durationS),
			outcome: JSON.stringify(outcome),
			diff_status: diffStatus,
			harness: slot.harnessName,
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
				`(${slot.harnessName}, cost ${telemetryOk ? cost : "n/a"}, ${telemetryOk ? tokens : "?"} tok, ${durationS}s` +
				`, diff ${diffStatus}` +
				`${engineTouched ? ", ENGINE TOUCHED" : ""}` +
				`${flags.length ? `, FLAGGED ${flags.join("/")}` : ""})`,
		});
		this.d.reconciler.snapshot.set(slot.cardId, "Needs Review");
		this.log("EXEC_COMPLETE", {
			card: slot.cardId,
			harness: slot.harnessName,
			cost_total: telemetryOk ? cost : null,
			tokens: telemetryOk ? tokens : null,
			duration_s: durationS,
			error_count: errorCount,
			telemetry: telemetryOk ? "ok" : "unavailable",
			outcome,
			diff_status: diffStatus,
			diff_changed: diffChanged,
			engine_touched: engineTouched,
			transcript_ref: artifacts.transcriptRef,
			prompt_ref: artifacts.promptRef,
		});
		this.d.host.notify(
			`🃏 ${slot.cardId} → Needs Review · ${telemetryOk ? `$${cost} · ${tokens} tok` : "telemetry n/a"} · ${durationS}s${diffChanged ? ` · diff ${diffStatus}` : " · worktree clean"}${engineTouched ? " · ⚠ ENGINE TOUCHED" : ""}${flags.length ? ` · ⚠ ${flags.join("/")}` : ""}`,
			flags.length || engineTouched ? "warning" : "info",
		);

		// Free the slot + nudge the drain, then adapter teardown (transcript snapshot
		// + process/pane close live in dispose).
		this.slots.delete(slot.cardId);
		this.d.host.events.emit("exec:idle", {});
		await harness.dispose(slot.session!);
	}

	// ── budget kill / watchdog escalation / halt kill ──────────────────────────
	private async budgetKill(slot: WorkerSlot, harness: Harness, cost: number): Promise<void> {
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
		if (slot.session) await harness.dispose(slot.session);
	}

	private async escalateWatchdog(slot: WorkerSlot, harness: Harness, reason: string): Promise<void> {
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
		if (slot.session) await harness.dispose(slot.session);
	}

	/** halt: kill an active worker (dispose its session, free the slot, rm scoped dir).
	 *  Status is the caller's responsibility (it also sets halt:true + → Needs Review).
	 *  wsMgr.haltKill() (called by the orchestrator) removes the worktree. */
	async haltKill(cardId: string): Promise<void> {
		const slot = this.slots.get(cardId);
		if (!slot) return;
		slot.harvested = true;
		this.slots.delete(cardId);
		this.log("EXEC_HALT_KILL", { card: cardId, harness: slot.harnessName });
		this.d.host.events.emit("exec:idle", {});
		const harness = this.d.harnesses[slot.harnessName];
		if (harness && slot.session) await harness.dispose(slot.session);
		this.pruneScopedDir(slot.cardId); // halt = deliberate kill, prune immediately
	}

	/** Delete the scoped dir for a card (idempotent — one-shot existence guard). */
	pruneScopedDir(cardId: string): void {
		const scopedDir = scopedDirFor({ scopedBase: this.scopedBase }, cardId);
		try {
			if (fs.existsSync(scopedDir)) fs.rmSync(scopedDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}

	/** Shutdown: dispose ALL active worker sessions (don't strand them on exit).
	 *  Scoped dirs for non-terminal cards SURVIVE — pruned when the card reaches
	 *  a terminal state in a later session. */
	async reapAll(): Promise<void> {
		for (const slot of [...this.slots.values()]) {
			this.slots.delete(slot.cardId);
			const harness = this.d.harnesses[slot.harnessName];
			if (harness && slot.session) await harness.dispose(slot.session);
		}
	}

	// The host log sink must never crash the pool's fire-and-forget continuations —
	// same stale-safe intent as the source system's guarded append.
	private log(event: string, data: Record<string, unknown>): void {
		try {
			this.d.host.log.entry("card-engine-log", { event, ...data, ts: new Date().toISOString() });
		} catch {
			/* the log line is non-essential; the process surviving is. */
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

function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}
