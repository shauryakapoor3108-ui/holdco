// pi.ts — the Pi harness adapter: the worker-pool's Pi worker mechanics carved out
// behind the five-verb Harness contract (spawn / inject / poll / collect / dispose).
//
// What moved here from src/engine/worker-pool.ts (the engine keeps everything
// harness-neutral — slots, breaker, budget kill, watchdog, diff harvest, board
// writes; this adapter owns TRANSPORT only):
//   • task.md construction (buildWorkerTask) with the CARDID-placeholder sentinel
//     discipline — the concrete `<<CARD-DONE:<id>>>>` string must never appear in
//     task.md or the steer, or the pane echo would false-match completion.
//   • the launch command (execution-only `pi --no-extensions -e pi-guard …` with the
//     obs env + HOLDCO_POLICY wiring), shell-quoted end to end.
//   • ready-wait (paneAgentStatus idle, SOFT timeout), steer baseline capture, and
//     the submit+verify loop (Enter can be DROPPED if pi's input line isn't ready —
//     resend until the worker demonstrably leaves idle; bounded poll COUNTS, not a
//     wall-clock verify, so a frozen test clock terminates).
//   • sentinel polling by STABLE pane label (pane ids RENUMBER when a sibling
//     closes — herdr fact) with the leave-idle guard, and the obs telemetry harvest.
//
// poll() NEVER throws (contract rule 1): the whole body is fenced, and the
// pane-gone verdict distinguishes a NON-EMPTY pane list missing our label
// ("failed" — genuine omission) from an EMPTY list ("unknown" — the herdr adapter
// returns [] on a transport timeout too, which must not read as death).

import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cockpit } from "../engine/cockpit.ts";
import { extractOutcome } from "../engine/executor.ts";
import type { HerdrAdapter } from "../engine/herdr-adapter.ts";
import type { ObsClient } from "../engine/obs-client.ts";
import type {
	Harness,
	HarnessArtifacts,
	HarnessSession,
	HarnessUsage,
	PollResult,
	SessionState,
	SpawnRequest,
} from "./types.ts";

/** Regex matching ONLY a worker's own concrete completion sentinel (never the
 *  placeholder echo). The ONE definition repo-wide — it moved here when the
 *  engine's worker pool went harness-neutral (sentinels are a Pi-pane transport
 *  detail, not an engine concept). */
export function sentinelFor(cardId: string): RegExp {
	const esc = cardId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`<<CARD-DONE:${esc}>>>`);
}

/** How many recent pane lines to read when polling / snapshotting output. */
const PANE_READ_LINES = 60;
/** Worker REPL readiness poll budget (the worker pi must boot before the steer). */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1_000;
/** v3 guard against partial-text submission: wait between send-text and Enter. */
const STEER_SUBMIT_DELAY_MS = 300;
/** The kickoff Enter can be DROPPED if pi's input line isn't ready (the 300ms race)
 *  → the steer sits typed-but-unsubmitted. After each Enter, VERIFY the worker left
 *  idle; if not, resend — bounded attempts, SOFT on exhaustion (sentinel + engine
 *  watchdog backstop a truly-stuck worker). */
const STEER_SUBMIT_MAX_ATTEMPTS = 4;
/** Verify polls per attempt — a BOUNDED count, NOT a wall-clock deadline (a frozen
 *  test clock would never advance past a `while (now() < deadline)` verify). */
const STEER_VERIFY_POLLS = 5;
const STEER_VERIFY_POLL_MS = 200;

/** A worker's stable pane label (renumber-safe addressing — see cockpit.ts). */
export function piWorkerLabel(cardId: string): string {
	return `worker:${cardId}`;
}

/** The adapter's private session state (the engine treats it as an opaque token). */
export interface PiHarnessSession extends HarnessSession {
	paneLabel: string;
	/** Last-known pane id — a CACHE only; every use re-resolves by paneLabel first. */
	paneId: string | null;
	/** obs runtime session id, resolved lazily via the `run:<runId>` tag. */
	sessionId: string | null;
	/** Pane output captured at steer injection (the leave-idle guard's baseline). */
	steerBaseline: string;
	/** Worker confirmed to have left its initial state (task picked up). */
	leftIdle: boolean;
	/** The pane output observed at completion (OUTCOME + transcript source). */
	lastKnownOutput: string;
	/** The per-card scoped dir (task.md, policy.json, pane-output.txt). */
	scopedDir: string;
	/** The per-card git worktree (the worker's cwd + write scope). */
	worktreeDir: string;
}

export interface PiHarnessDeps {
	herdr: HerdrAdapter;
	obs: ObsClient;
	obsToken: string;
	obsServerUrl: string;
	/** The project's SHARED cockpit instance (workers are split panes of it). */
	cockpit: Cockpit;
	/** Absolute path of the guard extension the worker loads via `-e`.
	 *  Default: the pi-guard.ts shipped beside this module. */
	piGuardPath?: string;
	/** Extra absolute `-e` extension paths (e.g. an observability extension). */
	extensions?: string[];
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export class PiHarness implements Harness {
	readonly name = "pi";
	private readonly herdr: HerdrAdapter;
	private readonly obs: ObsClient;
	private readonly obsToken: string;
	private readonly obsServerUrl: string;
	private readonly cockpit: Cockpit;
	private readonly piGuardPath: string;
	private readonly extensions: string[];
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(d: PiHarnessDeps) {
		this.herdr = d.herdr;
		this.obs = d.obs;
		this.obsToken = d.obsToken;
		this.obsServerUrl = d.obsServerUrl;
		this.cockpit = d.cockpit;
		this.piGuardPath = d.piGuardPath ?? fileURLToPath(new URL("./pi-guard.ts", import.meta.url));
		this.extensions = d.extensions ?? [];
		this.now = d.now ?? (() => Date.now());
		this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	// ── spawn (the ONE verb allowed to throw) ──────────────────────────────────
	async spawn(req: SpawnRequest): Promise<HarnessSession> {
		const ws = req.workspace;

		// 1. Prompt + policy artifacts into the scoped dir (durable spawn evidence).
		fs.mkdirSync(ws.scopedDir, { recursive: true });
		const promptRef = join(ws.scopedDir, "task.md");
		fs.writeFileSync(promptRef, buildWorkerTask(req), "utf8");
		const policyPath = join(ws.scopedDir, "policy.json");
		fs.writeFileSync(policyPath, JSON.stringify(req.policy, null, "\t") + "\n", "utf8");

		// 2. COCKPIT placement: a labelled split pane whose cwd is the worktree.
		const paneLabel = piWorkerLabel(ws.cardId);
		const pane = await this.cockpit.place(paneLabel, "working", ws.dir);
		if (!pane) throw new Error(`cockpit placement failed for ${paneLabel} (herdr split/create)`);

		const session: PiHarnessSession = {
			harness: this.name,
			cardId: ws.cardId,
			runId: req.runId,
			promptRef,
			// Pi renders constraints as task.md context injection (buildWorkerTask
			// embeds them), so the prompt artifact IS the rendered constraints ref.
			constraintsRef: req.constraints ? promptRef : null,
			startedAt: this.now(),
			paneLabel,
			paneId: pane,
			sessionId: null,
			steerBaseline: "",
			leftIdle: false,
			lastKnownOutput: "",
			scopedDir: ws.scopedDir,
			worktreeDir: ws.dir,
		};

		// 3. Launch the execution-only worker (--no-extensions disables discovery;
		//    only the explicit -e guard + extras load).
		const launched = await this.herdr.paneRun(pane, this.buildLaunchCommand(session, policyPath));
		if (!launched) {
			try {
				await this.cockpit.close(paneLabel); // don't strand a dead pane
			} catch {
				/* best-effort */
			}
			throw new Error(`herdr pane run failed (worker did not launch) for ${ws.cardId}`);
		}

		// 4. Ready-wait, then steer. Re-resolve the pane by its STABLE label first —
		//    a sibling teardown during waitForReady renumbers pane ids (herdr fact).
		await this.waitForReady(session);
		const live = (await this.cockpit.resolve(paneLabel)) ?? pane;
		session.paneId = live;
		session.steerBaseline = await this.herdr.paneRead(live, "recent", PANE_READ_LINES);
		await this.herdr.paneSendText(live, buildSteer(ws.scopedDir));
		await this.submitAndVerify(live);

		return session;
	}

	// ── inject (mid-run steer/correction) ──────────────────────────────────────
	async inject(session: HarnessSession, message: string): Promise<boolean> {
		const s = session as PiHarnessSession;
		try {
			const pane = await this.cockpit.resolve(s.paneLabel);
			if (!pane) return false; // pane gone — cannot deliver
			s.paneId = pane;
			const sent = await this.herdr.paneSendText(pane, message);
			if (!sent) return false;
			// Same submit+verify as the kickoff steer; SOFT on unconfirmed submission
			// (delivery happened — the sentinel/watchdog backstop a stuck worker).
			await this.submitAndVerify(pane);
			return true;
		} catch {
			return false;
		}
	}

	// ── poll (NEVER throws — contract rule 1) ──────────────────────────────────
	async poll(session: HarnessSession): Promise<PollResult> {
		const s = session as PiHarnessSession;
		try {
			// Re-resolve by stable label. Adapter rule: gone from a NON-EMPTY list is a
			// genuine omission → "failed"; an EMPTY list is a transport hiccup (the herdr
			// adapter returns [] on timeout too) → "unknown", let the watchdog decide.
			const { paneId, listNonEmpty } = await this.cockpit.locate(s.paneLabel);
			if (!paneId) return { state: listNonEmpty ? "failed" : "unknown" };
			s.paneId = paneId;

			// Opportunistic telemetry (cost for the engine's budget kill; activity for
			// its watchdog). Best-effort: obs down just omits the fields.
			let costUsd: number | undefined;
			let lastActivityAt: number | undefined;
			if (!s.sessionId) s.sessionId = await this.obs.resolveSessionIdByTag(`run:${s.runId}`);
			if (s.sessionId) {
				const { ok, stats } = await this.obs.getStats(s.sessionId);
				if (ok && stats) {
					costUsd = stats.total_cost;
					if (stats.latest_ts) {
						const t = Date.parse(stats.latest_ts);
						if (Number.isFinite(t)) lastActivityAt = t;
					}
				}
			}

			// Completion sentinel + the leave-idle guard: only output that has moved off
			// the steer baseline can complete (defeats the task-echo false positive).
			const output = await this.herdr.paneRead(paneId, "recent", PANE_READ_LINES);
			if (output && output !== s.steerBaseline) s.leftIdle = true;
			if (s.leftIdle && sentinelFor(s.cardId).test(output)) {
				s.lastKnownOutput = output;
				return { state: "done", costUsd, lastActivityAt };
			}

			const state: SessionState = s.leftIdle ? "working" : "starting";
			return { state, costUsd, lastActivityAt };
		} catch {
			return { state: "unknown" }; // a transport surprise is NOT a verdict
		}
	}

	// ── collect (telemetry harvest; degrades gracefully mid-run) ───────────────
	async collect(session: HarnessSession): Promise<HarnessArtifacts> {
		const s = session as PiHarnessSession;

		// Usage rollup from obs. getStats exposes only total_tokens — there is no
		// input/output split in the stats route — so the WHOLE total is reported as
		// tokensOut with tokensIn 0 (a documented convention, not a claim that input
		// was free; the engine sums tokensIn+tokensOut for its rollup either way).
		let usage: HarnessUsage | null = null;
		let errorCount: number | undefined;
		try {
			if (!s.sessionId) s.sessionId = await this.obs.resolveSessionIdByTag(`run:${s.runId}`);
			if (s.sessionId) {
				const { ok, stats } = await this.obs.getStats(s.sessionId);
				if (ok && stats) {
					usage = { tokensIn: 0, tokensOut: stats.total_tokens, costUsd: stats.total_cost };
					errorCount = stats.error_count;
				}
			}
		} catch {
			usage = null; // obs down → telemetry genuinely unavailable (flagged upstream)
		}

		// Output: prefer the completion snapshot poll() stored; else a fresh pane read
		// (the mid-run/escalation path — best-effort, the pane may already be gone).
		let text = s.lastKnownOutput;
		if (!text) {
			try {
				const pane = await this.cockpit.resolve(s.paneLabel);
				if (pane) text = await this.herdr.paneRead(pane, "recent", PANE_READ_LINES);
			} catch {
				/* best-effort */
			}
		}

		// Durable transcript artifact: the pane snapshot into the scoped dir.
		let transcriptRef: string | null = null;
		try {
			const p = join(s.scopedDir, "pane-output.txt");
			fs.writeFileSync(p, text, "utf8");
			transcriptRef = p;
		} catch {
			transcriptRef = null;
		}

		return {
			outcome: extractOutcome(text),
			outputTail: text,
			usage,
			transcriptRef,
			promptRef: s.promptRef,
			errorCount,
		};
	}

	// ── dispose (idempotent, never throws) ─────────────────────────────────────
	async dispose(session: HarnessSession): Promise<void> {
		const s = session as PiHarnessSession;
		try {
			await this.cockpit.report(s.paneLabel, "idle"); // paint the chip idle
		} catch {
			/* best-effort */
		}
		try {
			// Snapshot the pane output if collect() hasn't already persisted one —
			// evidence must survive teardown (conformance: transcript-survives-dispose).
			const pane = await this.cockpit.resolve(s.paneLabel);
			if (pane) {
				const p = join(s.scopedDir, "pane-output.txt");
				if (!fs.existsSync(p)) {
					const out = await this.herdr.paneRead(pane, "recent", PANE_READ_LINES);
					fs.writeFileSync(p, out, "utf8");
				}
			}
		} catch {
			/* best-effort — pane may already be gone */
		}
		try {
			await this.cockpit.close(s.paneLabel); // idempotent: a missing label no-ops
		} catch {
			/* best-effort */
		}
	}

	// ── carved mechanics ───────────────────────────────────────────────────────

	/** Poll the worker pane until its agent_status reports idle (herdr-injected pi
	 *  state). SOFT timeout: proceed to steer anyway — the worker is most likely up
	 *  but not reporting; the sentinel + engine watchdog backstop a dead one. */
	private async waitForReady(s: PiHarnessSession): Promise<void> {
		const deadline = this.now() + READY_TIMEOUT_MS;
		while (this.now() < deadline) {
			if (s.paneId && (await this.herdr.paneAgentStatus(s.paneId)) === "idle") return;
			await this.sleep(READY_POLL_MS);
		}
	}

	/** Press Enter to submit the typed text, then VERIFY the worker actually left
	 *  idle (pi is running it). A dropped Enter strands the worker with the steer
	 *  typed-but-unsubmitted — resend up to STEER_SUBMIT_MAX_ATTEMPTS times.
	 *  Returns true when the worker demonstrably left idle; false = unconfirmed
	 *  (SOFT — the caller proceeds and the sentinel/watchdog backstop). */
	private async submitAndVerify(paneId: string): Promise<boolean> {
		for (let attempt = 1; attempt <= STEER_SUBMIT_MAX_ATTEMPTS; attempt++) {
			await this.sleep(STEER_SUBMIT_DELAY_MS);
			await this.herdr.paneSendKeys(paneId, "Enter");
			for (let poll = 0; poll < STEER_VERIFY_POLLS; poll++) {
				// A submitted steer drives pi out of "idle" (working/blocked); "idle"/
				// "unknown" ⇒ still sitting in the input box → keep trying.
				const status = await this.herdr.paneAgentStatus(paneId);
				if (status === "working" || status === "blocked") return true;
				await this.sleep(STEER_VERIFY_POLL_MS);
			}
		}
		return false;
	}

	/** The execution-only worker launch command (run inside the herdr pane).
	 *  HOLDCO_POLICY → the pi-guard's policy file; HOLDCO_CARD_DIR → the worktree. */
	private buildLaunchCommand(s: PiHarnessSession, policyPath: string): string {
		const extras = this.extensions.map((e) => `-e ${shellQuote(e)} `).join("");
		const sessionDir = join(s.scopedDir, ".session");
		return (
			`cd ${shellQuote(s.worktreeDir)} && ` +
			`OBS_AUTH_TOKEN=${shellQuote(this.obsToken)} OBS_SERVER_URL=${shellQuote(this.obsServerUrl)} ` +
			`HOLDCO_POLICY=${shellQuote(policyPath)} HOLDCO_CARD_DIR=${shellQuote(s.worktreeDir)} ` +
			`pi --no-extensions -e ${shellQuote(this.piGuardPath)} ${extras}` +
			`--o-name ${shellQuote(`card-${s.cardId}`)} --o-tag ${shellQuote(`card:${s.cardId}`)} --o-tag ${shellQuote(`run:${s.runId}`)} ` +
			`--session-dir ${shellQuote(sessionDir)}`
		);
	}
}

// ── prompt construction (module-level, pure) ──────────────────────────────────

/** The short kickoff steer typed into the worker REPL (points at task.md). MUST
 *  never contain the concrete sentinel — only task.md's placeholder form exists
 *  outside the worker's own final message. */
function buildSteer(scopedDir: string): string {
	return `Read and execute the task in ${join(scopedDir, "task.md")} now, end to end. Follow its completion contract exactly.`;
}

/**
 * The worker's task.md (read by the worker, NOT echoed as a chat input). The
 * completion sentinel is described with a PLACEHOLDER (`CARDID`) the worker must
 * substitute with the real id — so neither the steer nor a `read` of this file
 * ever emits the *concrete* sentinel poll() matches (defeats the echo false
 * positive; the leave-idle guard backs it).
 *
 * The worker's cwd is a per-card git worktree; both code and artifact cards edit
 * files INSIDE it — the engine's unified git-diff harvest is the output channel.
 */
function buildWorkerTask(req: SpawnRequest): string {
	const { instruction } = req;
	const { id, domain, cardType } = req.card;
	const domainCtx = `domains/${domain}/CONTEXT.md`;
	// Single-source constraints (knowledge layer), rendered as task context —
	// Pi's native injection surface. Placed ahead of the instruction so they
	// read as ground rules, not afterthoughts.
	const constraintsBlock = req.constraints ? `## Constraints (holdco knowledge layer)\n${req.constraints}\n\n` : "";
	const safetyRules =
		`CRITICAL SAFETY RULES:\n` +
		`- NEVER run git commit / git push / git commit --amend / git merge. Leave your edits UNCOMMITTED in the working tree — the owner captures your diff and applies it after approval. (push/commit/merge are also hard-blocked by the policy guard.)\n` +
		`- NEVER edit anything outside this worktree (BLOCKED by the policy guard).\n` +
		`- NEVER write the card's frontmatter or status — the owner owns that.\n\n`;
	const completionContract = (outcomeHint: string, closing: string): string =>
		`## Completion contract (follow EXACTLY)\n` +
		`End your FINAL assistant message with these two lines:\n` +
		"```\n" +
		`OUTCOME: ${outcomeHint}\n` +
		`<<CARD-DONE:CARDID>>>\n` +
		"```\n" +
		`Replace the token CARDID with this card's id, which is \`${id}\`, so the final line reads the marker for this card. Do NOT print the literal word CARDID. ${closing}\n`;

	const isCodeCard = cardType === "ops" || cardType === "maintenance";
	if (isCodeCard) {
		return (
			`# Worker task — card \`${id}\` (domain: ${domain}, type: CODE)\n\n` +
			`You are an execution-only worker running inside a PER-CARD GIT WORKTREE.\n` +
			`Your cwd IS the worktree root — a clean checkout of the main repo at HEAD.\n` +
			`Your edits inside this worktree will produce a git diff that IS your output.\n\n` +
			safetyRules +
			constraintsBlock +
			`## Instruction\n${instruction}\n\n` +
			`## Load context first (read-only)\n` +
			`- Read \`${domainCtx}\` and the refs/ it points to, as the task needs.\n` +
			`- Read \`knowledge/FILING.md\` for filing conventions (the owner uses it; you will NOT write an artifact).\n\n` +
			`## Do the work\n` +
			`- Apply the edits to the named files INSIDE this worktree. Run the verify command(s).\n` +
			`- Make substantive changes — whitespace-only or idempotent edits may produce an empty diff.\n` +
			`- Your diff is the build-review artifact — the owner applies it after human approval.\n\n` +
			completionContract("<files changed + verify result>", "Do NOT change the card's status — the owner moves it to Needs Review.")
		);
	}
	// ARTIFACT contract (default for research, content, strategy, or unknown card_type):
	return (
		`# Worker task — card \`${id}\` (domain: ${domain})\n\n` +
		`You are an execution-only worker running inside a PER-CARD GIT WORKTREE.\n` +
		`Your cwd IS the worktree root — a clean checkout of the main repo at HEAD.\n` +
		`Write your durable artifact(s) to the REAL knowledge paths INSIDE this worktree\n` +
		`(e.g. \`domains/${domain}/refs/my-analysis.md\` for domain artifacts,\n` +
		`or \`knowledge/decisions/my-decision.md\` for cross-domain artifacts).\n` +
		`Your edits to these paths will produce a git diff that IS your output —\n` +
		`the owner applies the diff after human approval.\n\n` +
		safetyRules +
		`## Instruction\n${instruction}\n\n` +
		`## Load context first (read-only)\n` +
		`- Read \`${domainCtx}\` and the refs/ it points to, as the task needs.\n` +
		`- Read \`knowledge/FILING.md\` — your artifact MUST carry the frontmatter + kebab-case filename it describes.\n\n` +
		`## Do the work\n` +
		`- Execute the instruction and write the resulting durable artifact(s) to their knowledge paths inside this worktree (e.g. \`domains/${domain}/refs/<kebab>.md\`). Use the write or edit tool with absolute paths.\n` +
		`- Produce real artifacts with the FILING.md frontmatter; do not merely describe what you would do.\n\n` +
		completionContract(
			"<one-line summary of what you produced and where you wrote it>",
			"Do NOT change the card's status — the owner moves it to Needs Review and files your artifact.",
		)
	);
}

/** Single-quote a string for safe embedding in a `sh -c` command. */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
