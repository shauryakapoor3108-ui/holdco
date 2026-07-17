// executor.ts — Phase 4 inline execution dispatcher (EngineHost port of the
// card-engine executor, Seam 3 + 4).
//
// Turns an APPROVED card into a completed one. D1: the dispatch trigger moved off
// the detected `→ Executing` edge (humans no longer drag straight to Executing) —
// the engine's `queue:next` handler now writes `Queued → Executing` and calls
// `dispatch` directly (gate already confirmed slot-free + idle + still-Queued). The
// single host process then executes the task INLINE (blocking single-REPL — the
// shell IS the REPL, there is no spawn) with observability already loaded; on
// completion the engine transitions `Executing → Needs Review` and writes a
// derived cost rollup (cost_total, tokens, duration_s, tool_calls, outcome) to
// the card frontmatter.
//
// This is the EngineHost port: the Pi ExtensionAPI coupling is replaced by the
// `ExecutorDeps` seam — `host` (events/log/notify via the EngineHost interface)
// and `send` (fires the inline execution turn; the Pi shell passes
// pi.sendUserMessage, a daemon passes a harness send).
//
// Loop-suppression discipline (same as the reconciler's writes): every status
// write the executor makes is paired with a SYNCHRONOUS snapshot.set BEFORE
// control returns to the event loop, so the reconciler never re-detects the
// engine's own write as a human delta (which would otherwise auto-revert the
// agent/engine-only `Executing → Needs Review` edge).
//
// Completion correlation (settled in the spec's "Plan-verifier exchange"):
//   - `agent_end` is the completion hook (fired ONCE per run, last event of the
//     run). `turn_end` fires per-turn (many per run) so it is NOT the completion
//     signal — usage is ACCUMULATED per turn_end and FINALIZED once on agent_end.
//   - Raw per-message usage is nested: `usage.cost?.total` + `usage.totalTokens`
//     (camelCase) + `usage.input` / `usage.output`. The flat `cost_total` shape
//     is the obs extension's normalized type, not the raw event payload.
//   - `agent_end` with an EMPTY slot is a front-door/chat turn → ignored.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { join, relative } from "node:path";
import type { EngineHost } from "../host/host.ts";
import { readRawField, writeStatus } from "./frontmatter.ts";
import type { Reconciler } from "./reconciler.ts";

/** Write a checkpoint heartbeat every N tool calls (or ≥60s — see CHECKPOINT_MS). */
const CHECKPOINT_EVERY_N_TOOLS = 5;
const CHECKPOINT_MS = 60_000;
/** Outcome fallback truncation when no explicit `OUTCOME:` line is present. */
const OUTCOME_FALLBACK_MAX = 240;
/** Never-idle narration throttle (spec §8 D7): at most one progress line per run / NARRATE_MS. */
const NARRATE_MS = 10_000;
/** Circuit breaker: max dispatches of one card per session before a HARD STOP (runaway guard). */
const MAX_DISPATCHES_PER_SESSION = 3;

/** Escalation mechanism + error class (spec §7 instrumentation — "ship both, measure both"). */
type EscalationMechanism = "agent_end-aborted" | "watchdog";
type ErrorClass = "transient" | "terminal";

/** The single in-flight execution slot. Sprint 1 = blocking single-REPL → one is correct. */
interface ExecSlot {
	id: string;
	file: string; // absolute path to the card
	relPath: string; // path relative to cwd (for steer + display)
	domain: string;
	cardType: string;
	cwd: string;
	startedAt: number;
	instruction: string;
	// accumulated per turn_end / tool_execution_end / message_end:
	cost: number;
	tokens: number;
	input: number;
	output: number;
	toolCalls: number;
	lastAssistantText: string;
	lastCheckpoint: number;
	lastNarrate: number; // D7 never-idle narration throttle
	// filing verification (new-artifact detection scoped to the domain's filing dir):
	filingDir: string;
	filesBefore: Set<string>;
}

export interface ExecutorDeps {
	host: EngineHost;
	reconciler: Reconciler;
	/** Fires the inline execution turn (the Pi shell passes pi.sendUserMessage; a daemon passes a harness send). */
	send: (text: string) => void;
}

export class Executor {
	private slot: ExecSlot | null = null;
	/** Per-card dispatch counter for the circuit breaker (this session only). */
	private readonly dispatchCounts = new Map<string, number>();
	private readonly host: EngineHost;
	private readonly reconciler: Reconciler;
	private readonly send: (text: string) => void;

	constructor(deps: ExecutorDeps) {
		this.host = deps.host;
		this.reconciler = deps.reconciler;
		this.send = deps.send;
	}

	/** True while an execution is in flight (used by the engine to gate dispatch). */
	get busy(): boolean {
		return this.slot !== null;
	}

	/** Clear the circuit-breaker counter for a card (called by /unhalt after a hard stop). */
	clearDispatchCount(cardId: string): void {
		this.dispatchCounts.delete(cardId);
	}

	// ── Dispatch (the drain trigger: queue:next → Queued → Executing) ─────────
	/**
	 * Called by the engine's `queue:next` handler after it has written
	 * `Queued → Executing` (snapshot-synced) for the head card. Guards idle (defence
	 * in depth — the handler already checked), reads the executable instruction, sets
	 * the slot, and fires the
	 * execution turn (fire-and-return, no await). If there is no instruction, the
	 * card is moved straight to Needs Review with an explanatory outcome (never run
	 * an empty execution).
	 */
	dispatch(cardId: string, file: string, ctx?: { cwd?: string; isIdle?: () => boolean }): void {
		// 1. Idle guard — never inject a turn mid-stream. The dispatch fires from the
		//    sweep, which ticks independently of the shell's turn state. If the shell is
		//    busy (a /capture restatement, or — already — this very execution), DEFER:
		//    leave the card in Executing, do not dispatch this tick.
		//    KNOWN Sprint-1 limitation (documented in the spec): a deferred card is
		//    not re-dispatched automatically (snapshot already matches disk), so only
		//    one card may be in Executing at a time. herdr multi-pane removes this in
		//    Sprint 2 — same trigger, so seam-compatible.
		if (this.slot) {
			this.host.notify(`🃏 busy executing ${this.slot.id} — ${cardId} stays in Executing until it finishes`, "warning");
			return;
		}
		if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) {
			this.host.log.entry("card-engine-log", {
				event: "EXEC_DEFERRED",
				card: cardId,
				reason: "shell not idle at dispatch tick (Sprint-1 single-slot limitation: card stays Executing)",
				ts: new Date().toISOString(),
			});
			return;
		}

		const cwd: string = ctx?.cwd ?? process.cwd();
		const domain = readField(file, "domain") || "root";
		const cardType = readField(file, "card_type") || "";
		const instruction = readInstruction(file);

		// 2. No executable instruction → never run empty; file straight to review.
		if (!instruction) {
			this.finalizeNoBrief(cardId, file);
			this.host.notify(`🃏 ${cardId} had no brief — moved to Needs Review (nothing to execute)`, "warning");
			return;
		}

		// 2b. CIRCUIT BREAKER (hard cap on runaway re-execution). A card should be
		//     dispatched at most a handful of times per session (a human may legitimately
		//     re-run via Needs Review → … → approve). If it exceeds the cap, something is
		//     re-creating Executing in a loop (a ghost reconciler, a 2nd engine on the dir) —
		//     HARD STOP it: halt:true + Needs Review, no execution, no more token burn.
		//     /unhalt clears both the flag and this counter.
		const dispatches = (this.dispatchCounts.get(cardId) ?? 0) + 1;
		this.dispatchCounts.set(cardId, dispatches);
		if (dispatches > MAX_DISPATCHES_PER_SESSION) {
			const reason = `circuit breaker: ${dispatches - 1} dispatches in one session — halted (suspected re-execution loop)`;
			writeStatus(file, "Needs Review", {
				annotations: { halt: "true", interrupted: "true", outcome: JSON.stringify(reason) },
				logLine: `CIRCUIT BREAKER: halted after ${dispatches - 1} dispatches → Needs Review, halt:true`,
			});
			this.reconciler.snapshot.set(cardId, "Needs Review");
			this.host.log.entry("card-engine-log", {
				event: "EXEC_CIRCUIT_BREAKER",
				card: cardId,
				dispatches: dispatches - 1,
				ts: new Date().toISOString(),
			});
			this.host.notify(`🛑 circuit breaker: ${cardId} halted after ${dispatches - 1} runs this session — /unhalt ${cardId} to clear`, "warning");
			this.host.events.emit("exec:idle", {});
			return;
		}

		// 3. Set the slot + snapshot the filing dir (for new-artifact verification).
		const filingDir = resolveFilingDir(cwd, domain);
		const relPath = relative(cwd, file);
		this.slot = {
			id: cardId,
			file,
			relPath,
			domain,
			cardType,
			cwd,
			startedAt: Date.now(),
			instruction,
			cost: 0,
			tokens: 0,
			input: 0,
			output: 0,
			toolCalls: 0,
			lastAssistantText: "",
			lastCheckpoint: Date.now(),
			lastNarrate: Date.now(),
			filingDir,
			filesBefore: listMarkdown(filingDir),
		};

		this.host.log.entry("card-engine-log", {
			event: "EXEC_DISPATCH",
			card: cardId,
			domain,
			file: relPath,
			ts: new Date().toISOString(),
		});
		this.host.notify(`🃏 Executing ${cardId} — busy, watch obs for live progress`, "info");

		// 4. Fire the execution turn and RETURN (no await). The agent runs inline;
		//    obs records it live. Completion is finalized on agent_end.
		this.send(this.buildSteer(this.slot));
	}

	// ── Accumulate per turn_end / tool_execution_end / message_end ────────────

	/** Accumulate usage from a completed turn (proven nested path). Slot-gated. */
	onTurnEnd(event: any): void {
		if (!this.slot) return;
		const u = event?.message?.usage;
		if (!u) return;
		this.slot.cost += u.cost?.total ?? 0;
		this.slot.tokens += u.totalTokens ?? 0;
		this.slot.input += u.input ?? 0;
		this.slot.output += u.output ?? 0;
	}

	/** Count a finalized tool call + trigger the checkpoint heartbeat. Slot-gated. */
	onToolExecutionEnd(_event: any): void {
		if (!this.slot) return;
		this.slot.toolCalls += 1;
		const now = Date.now();
		if (this.slot.toolCalls % CHECKPOINT_EVERY_N_TOOLS === 0 || now - this.slot.lastCheckpoint >= CHECKPOINT_MS) {
			this.checkpoint(now);
		}
	}

	/**
	 * Never-idle narration (spec §8 D7). On each `tool_execution_start`, emit a
	 * THROTTLED (≤ once / NARRATE_MS) progress line to the log so a long async run
	 * never looks dead. Slot-gated; NEVER writes `status` (no delta).
	 */
	onToolExecutionStart(_event: any): void {
		if (!this.slot) return;
		const now = Date.now();
		if (now - this.slot.lastNarrate < NARRATE_MS) return;
		this.slot.lastNarrate = now;
		this.host.log.entry("card-engine-log", {
			event: "EXEC_NARRATE",
			card: this.slot.id,
			tools: this.slot.toolCalls,
			ts: new Date(now).toISOString(),
		});
	}

	/** Store the latest assistant message text (for OUTCOME extraction). Slot-gated. */
	onMessageEnd(event: any): void {
		if (!this.slot) return;
		if (event?.message?.role !== "assistant") return;
		const text = extractText(event.message.content);
		if (text) this.slot.lastAssistantText = text;
	}

	// ── Finalize on agent_end ─────────────────────────────────────────────────
	/**
	 * The completion edge. Fired once per run; finalize ONLY when the slot is set
	 * (an empty slot = a front-door/chat agent_end → ignored). Derives the rollup,
	 * verifies the filed artifact, writes `Executing → Needs Review` + the rollup
	 * in a single field-preserving call, syncs the snapshot, and clears the slot.
	 */
	onAgentEnd(event: any, ctx?: { signal?: { aborted?: boolean } }): void {
		const slot = this.slot;
		if (!slot) return; // correlation rule: not our run.

		const durationS = Math.max(0, Math.round((Date.now() - slot.startedAt) / 1000));
		const cost = round6(slot.cost);
		const tokens = Math.round(slot.tokens);

		// D1 escalation mechanism 1: an aborted signal at agent_end ⇒ the run was
		// interrupted (the shell exposes no fatal-error event; ctx.signal is the abort
		// signal). This IS the Tier-2 escalation destination — the card lands at Needs
		// Review for the human, annotated, and is classed `transient` (an abort is retryable).
		const aborted = ctx?.signal?.aborted === true;

		// Outcome: prefer an explicit `OUTCOME:` line; fall back to last assistant text
		// (this event's messages[] as a last resort), truncated.
		const lastText = slot.lastAssistantText || lastAssistantFrom(event?.messages) || "";
		let outcome = extractOutcome(lastText);

		// Filing verification: branch by card type (code vs artifact).
		const isCodeCard = slot.cardType === "ops" || slot.cardType === "maintenance";
		let diffChanged = false;
		let diffDetail = "no diff data";
		const newFiles: string[] = [];
		if (isCodeCard) {
			// CODE card: verify the working tree has a non-empty diff.
			try {
				const out = execSync("git -C " + shellQuote(slot.cwd) + " status --porcelain", { encoding: "utf8", timeout: 5000 });
				const lines = out.trim();
				diffChanged = lines.length > 0;
				diffDetail = diffChanged ? lines.split("\n").length + " uncommitted file(s)" : "working tree clean";
			} catch {
				diffDetail = "git check unavailable";
			}
			if (!diffChanged) {
				outcome = `${outcome} [⚠ no code change produced — ${diffDetail}]`;
			}
		} else {
			// ARTIFACT card: did a new artifact appear in the domain's filing dir?
			const filedNow = listMarkdown(slot.filingDir);
			for (const f of filedNow) if (!slot.filesBefore.has(f)) newFiles.push(relative(slot.cwd, f));
			if (newFiles.length === 0) {
				outcome = `${outcome} [⚠ no new artifact found under ${relative(slot.cwd, slot.filingDir)} — filing not verified]`;
			}
		}
		const abortReason = "execution aborted (ctx.signal) before normal completion";
		if (aborted) outcome = `${outcome} [⚠ ${abortReason}]`;

		const annotations: Record<string, string> = {
			cost_total: String(cost), // bare number — Dataview-aggregatable
			tokens: String(tokens),
			duration_s: String(durationS),
			tool_calls: String(slot.toolCalls),
			outcome: JSON.stringify(outcome), // quoted scalar — free text is YAML-safe
		};
		if (aborted) annotations.interrupted = "aborted";

		writeStatus(slot.file, "Needs Review", {
			annotations,
			logLine:
				`execution complete: Executing → Needs Review ` +
				`(cost ${cost}, ${tokens} tok, ${durationS}s, ${slot.toolCalls} tools` +
				(isCodeCard
					? (diffChanged ? ", diff produced" : ", no diff")
					: (newFiles.length ? `, filed ${newFiles.join(", ")}` : ", no artifact filed")) +
				`${aborted ? ", ABORTED" : ""})`,
		});
		// CRITICAL loop-suppression: sync the snapshot synchronously so the reconciler
		// does not see Executing → Needs Review as a (human) delta and auto-revert it.
		this.reconciler.snapshot.set(slot.id, "Needs Review");

		this.host.log.entry("card-engine-log", {
			event: "EXEC_COMPLETE",
			card: slot.id,
			cost_total: cost,
			tokens,
			duration_s: durationS,
			tool_calls: slot.toolCalls,
			filed: newFiles,
			outcome,
			ts: new Date().toISOString(),
		});
		this.host.notify(
			`🃏 ${slot.id} → Needs Review · $${cost} · ${tokens} tok · ${durationS}s · ${slot.toolCalls} tools${aborted ? " · ABORTED" : ""}`,
			newFiles.length && !aborted ? "info" : "warning",
		);

		// Escalation instrumentation (spec §7): only on the ABORTED path is this an
		// escalation (a normal/filing-miss completion is not). Class `transient`.
		if (aborted) this.escalate(slot.id, "agent_end-aborted", "transient", abortReason);

		this.slot = null;
		// Latency hint: the slot just cleared — let the drain offer the next head now.
		this.host.events.emit("exec:idle", {});
	}

	// ── internals ─────────────────────────────────────────────────────────────

	/** Heartbeat checkpoint: additive annotations, status unchanged (no delta). */
	private checkpoint(now: number): void {
		if (!this.slot) return;
		this.slot.lastCheckpoint = now;
		writeStatus(this.slot.file, "Executing", {
			annotations: {
				last_checkpoint: new Date(now).toISOString(),
				tool_calls_so_far: String(this.slot.toolCalls),
			},
		});
		// Status is still Executing; snapshot already holds Executing → no delta.
	}

	/** No-instruction path: move straight to Needs Review, snapshot-synced. */
	private finalizeNoBrief(cardId: string, file: string): void {
		writeStatus(file, "Needs Review", {
			annotations: {
				cost_total: "0",
				tokens: "0",
				duration_s: "0",
				tool_calls: "0",
				outcome: JSON.stringify("no brief — nothing to execute"),
			},
			logLine: "execution skipped: no brief — Executing → Needs Review",
		});
		this.reconciler.snapshot.set(cardId, "Needs Review");
		this.host.log.entry("card-engine-log", {
			event: "EXEC_NO_BRIEF",
			card: cardId,
			ts: new Date().toISOString(),
		});
		// Latency hint: nothing ran (slot never set) — free the drain to advance.
		this.host.events.emit("exec:idle", {});
	}

	// ── Runtime error watchdog (spec §7 mechanism 2) ──────────────────────────
	/**
	 * The runtime analogue of `startupRecovery`. A card in `Executing` whose
	 * `last_checkpoint` is older than `watchdogMs` **and** with no live slot
	 * (`!this.busy`) ⇒ a run that ended without finalizing (a crash/abort that
	 * skipped `agent_end`, which the shell has no event for). Escalate to
	 * `Needs Review` (loop-suppressed), classify `terminal`, and free the drain
	 * (`exec:idle`).
	 *
	 * No-op while busy: a live slot means the run is healthy or finalizing normally.
	 * The threshold MUST exceed the checkpoint cadence (5 tools / 60s) so a healthy
	 * long run (fresh checkpoints) is never escalated. A card with NO measurable
	 * checkpoint is left to boot-time `startupRecovery` — this watchdog only acts on
	 * a stale-but-present checkpoint, the case the missing fatal-error event drops.
	 */
	watchdog(watchdogMs: number): void {
		if (this.busy) return;
		const now = Date.now();
		for (const [id, cur] of this.reconciler.scan()) {
			if (this.reconciler.snapshot.get(id) !== "Executing") continue;
			const cpRaw = readRawField(cur.file, "last_checkpoint");
			if (!cpRaw) continue; // no measurable checkpoint → startupRecovery owns that case
			const cpMs = Date.parse(cleanScalar(cpRaw));
			if (!Number.isFinite(cpMs)) continue;
			const ageMs = now - cpMs;
			if (ageMs <= watchdogMs) continue; // fresh checkpoint → healthy long run
			const reason = `execution ended without completion (watchdog: no checkpoint for ${Math.round(ageMs / 1000)}s)`;
			writeStatus(cur.file, "Needs Review", {
				annotations: { interrupted: "true", outcome: JSON.stringify(reason) },
				logLine: `watchdog: Executing → Needs Review (${reason})`,
			});
			// Loop-suppression: sync snapshot synchronously (same discipline as onAgentEnd).
			this.reconciler.snapshot.set(id, "Needs Review");
			this.escalate(id, "watchdog", "terminal", reason);
			// Free the drain to advance the queue (the dead slot is gone).
			this.host.events.emit("exec:idle", {});
		}
	}

	/**
	 * Escalation instrumentation (spec §7 — "ship both, measure both"). Records WHICH
	 * mechanism fired (`agent_end-aborted` vs `watchdog`) and an error class
	 * (`transient`/retryable vs `terminal`/escalate, the Cloudflare resilience signal)
	 * so abort/error rates and the two-mechanism trade-off are measurable from the log.
	 * D1 only classifies + escalates — retry/fallback actions are a later phase.
	 */
	private escalate(card: string, mechanism: EscalationMechanism, errorClass: ErrorClass, reason: string): void {
		this.host.log.entry("card-engine-log", {
			event: "EXEC_ESCALATED",
			card,
			mechanism,
			errorClass,
			reason,
			ts: new Date().toISOString(),
		});
	}

	/** The execution steer (Seam 4 turn). Carries the card, domain context, the
	 *  instruction, the FILING requirement, and the completion contract. */
	private buildSteer(slot: ExecSlot): string {
		const domainCtx = `domains/${slot.domain}/CONTEXT.md`;
		const isCodeCard = slot.cardType === "ops" || slot.cardType === "maintenance";
		const filingTarget =
			slot.domain === "root"
				? "cross-domain artifacts → knowledge/ (per FILING.md placement rules)"
				: `domain artifacts → domains/${slot.domain}/refs/`;
		if (isCodeCard) {
			return (
				`🃏 EXECUTE approved card \`${slot.id}\` (domain: ${slot.domain}, type: CODE).\n\n` +
				`This card was just approved (Needs Approval → Executing). Carry it out now, inline, end to end.\n\n` +
				`INSTRUCTION:\n${slot.instruction}\n\n` +
				`LOAD CONTEXT FIRST:\n` +
				`- Read ${domainCtx} and load the refs/ it points to as the task needs.\n` +
				`- Read knowledge/FILING.md for filing conventions (though you will NOT write a markdown artifact).\n\n` +
				`DO THE WORK:\n` +
				`- Apply the edits to the named files. Run the verify command(s).\n` +
				`- Do NOT write a spec, design doc, or any knowledge/ or refs/ artifact — your output is the CODE CHANGE ITSELF.\n\n` +
				`COMPLETION CONTRACT (follow exactly):\n` +
				`- End your FINAL message with one line: \`OUTCOME: <files changed + verify result>\`.\n` +
				`- Do NOT change this card's status — the engine moves it to Needs Review when you finish.\n` +
				`- Do NOT edit the card file ${slot.relPath}.`
			);
		}
		// ARTIFACT contract (default for research, content, strategy, or missing/unknown card_type):
		return (
			`🃏 EXECUTE approved card \`${slot.id}\` (domain: ${slot.domain}).\n\n` +
			`This card was just approved (Needs Approval → Executing). Carry it out now, inline, end to end.\n\n` +
			`INSTRUCTION:\n${slot.instruction}\n\n` +
			`LOAD CONTEXT FIRST:\n` +
			`- Read ${domainCtx} and load the refs/ it points to as the task needs.\n` +
			`- Read knowledge/FILING.md — every artifact you write MUST follow it (required frontmatter, kebab-case filename, correct placement: ${filingTarget}).\n\n` +
			`DO THE WORK:\n` +
			`- Execute the instruction and FILE the resulting durable artifact(s) per FILING.md. Produce real artifacts; do not merely describe what you would do.\n\n` +
			`COMPLETION CONTRACT (follow exactly):\n` +
			`- End your FINAL message with one line: \`OUTCOME: <one-line summary of what you produced and where it was filed>\`.\n` +
			`- Do NOT change this card's status — the engine moves it to Needs Review when you finish.\n` +
			`- Do NOT edit the card file ${slot.relPath} — the engine writes the cost rollup there. File your work elsewhere per FILING.md.`
		);
	}
}

// ── module-level helpers (file parsing / filing) ─────────────────────────────

const FM_RE = /^---\n([\s\S]*?)\n---/;

function safeRead(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** Strip surrounding quotes and a trailing ` # comment` from a scalar value. */
function cleanScalar(raw: string): string {
	let v = raw.trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	const hash = v.search(/\s#/);
	if (hash >= 0) v = v.slice(0, hash).trim();
	return v;
}

/** Read a frontmatter scalar field from a card file ("" if absent). */
function readField(file: string, key: string): string {
	const text = safeRead(file);
	const m = text.match(FM_RE);
	if (!m) return "";
	const fm = m[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
	return fm ? cleanScalar(fm[1]) : "";
}

/** Read a `## <header>` body section's content ("" if absent/empty). */
function readSection(text: string, header: string): string {
	const lines = text.split("\n");
	const hi = lines.findIndex((l) => l.trim() === `## ${header}`);
	if (hi === -1) return "";
	let next = lines.length;
	for (let i = hi + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			next = i;
			break;
		}
	}
	return lines
		.slice(hi + 1, next)
		.join("\n")
		.trim();
}

/**
 * The executable instruction for a card. Priority (Sprint 1 = human-filled brief):
 *   1. a `## Brief` body section, 2. the `brief:` frontmatter scalar,
 *   3. the `## Restatement` body, 4. the `## Intent` body. "" if none.
 *
 * CRITICAL: `## Restatement` is the HUMAN'S latest correction (reject-with-reason). When a brief
 * exists it must ACCOMPANY the brief verbatim, never be shadowed by it — the planner's paraphrase
 * has already dropped a human constraint once (round-2 README rebuilt with the exact frontmatter
 * the human rejected, 2026-07-13). The worker always sees the human's own words.
 */
export function readInstruction(file: string): string {
	const text = safeRead(file);
	const restatement = readSection(text, "Restatement");
	const briefBody = readSection(text, "Brief");
	if (briefBody) return withHumanConstraints(briefBody, restatement);
	const m = text.match(FM_RE);
	if (m) {
		const fm = m[1].match(/^brief:[ \t]*(.*)$/m);
		const brief = fm ? cleanScalar(fm[1]) : "";
		if (brief) return withHumanConstraints(brief, restatement);
	}
	if (restatement) return restatement;
	return readSection(text, "Intent");
}

/** Append the human's ## Restatement to an instruction as explicit hard constraints. */
function withHumanConstraints(instruction: string, restatement: string): string {
	if (!restatement) return instruction;
	return `${instruction}\n\n## Human corrections — HARD constraints (verbatim; these override anything above)\n${restatement}`;
}

/** Where a domain's artifacts are filed (FILING.md): domain → refs/, root → knowledge/. */
export function resolveFilingDir(cwd: string, domain: string): string {
	return domain === "root" ? join(cwd, "knowledge") : join(cwd, "domains", domain, "refs");
}

/** Recursively list .md files under dir (absolute paths). Empty if dir missing. */
export function listMarkdown(dir: string): Set<string> {
	const out = new Set<string>();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			for (const f of listMarkdown(full)) out.add(f);
		} else if (e.isFile() && e.name.endsWith(".md")) {
			out.add(full);
		}
	}
	return out;
}

/** Concatenate text blocks of an assistant message content array. */
function extractText(content: any): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") text += block.text + "\n";
	}
	return text.trim();
}

/** Last assistant message's text from an agent_end messages[] array. */
function lastAssistantFrom(messages: any): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			const t = extractText(messages[i].content);
			if (t) return t;
		}
	}
	return "";
}

/** Pull the `OUTCOME:` line; else fall back to truncated last assistant text. */
export function extractOutcome(text: string): string {
	if (!text) return "completed (no OUTCOME line emitted)";
	const m = text.match(/^[ \t]*OUTCOME:[ \t]*(.+)$/im);
	if (m) return m[1].trim();
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > OUTCOME_FALLBACK_MAX ? `${flat.slice(0, OUTCOME_FALLBACK_MAX).trimEnd()}…` : flat;
}

function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

/** Single-quote a string for safe embedding in a shell command. */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
