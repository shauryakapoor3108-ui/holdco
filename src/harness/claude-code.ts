// claude-code.ts - the Claude Code harness adapter: runs each worker as a
// headless `claude -p` process speaking stream-json on stdin/stdout.
//
// Transport mechanics owned here:
//   • spawn: write prompt.md / policy.json / settings.json into the scoped dir,
//     launch the CLI with the generated settings (PreToolUse guard hook →
//     claude-code-guard.ts, NATIVE policy enforcement), deliver the brief as the
//     first stream-json user message, and KEEP STDIN OPEN so inject() can steer.
//   • liveness/completion: every stdout line is streamed into session.jsonl
//     (the durable transcript) and parsed - result events carry usage + cost;
//     a turn is "done" when its result event lands. Headless completion is
//     protocol-level: no sentinel file needed.
//   • telemetry: usage/cost accumulate across result events; collect() extracts
//     the OUTCOME line from the final result text.
//
// The child env drops CLAUDECODE and every CLAUDE_CODE_* variable so a worker
// spawned from inside a Claude Code session does not trip the nested-session
// guard, and gains HOLDCO_POLICY (the guard's policy file) + HOLDCO_CARD_DIR.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as spawnChild } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { extractOutcome } from "../engine/executor.ts";
import type {
	Harness,
	HarnessArtifacts,
	HarnessSession,
	PollResult,
	SpawnRequest,
} from "./types.ts";

export interface ClaudeCodeHarnessOpts {
	/** CLI binary (default "claude"). Tests point this at "node". */
	claudeBin?: string;
	/** Args PREPENDED before the protocol flags (tests: path to a fake CLI script). */
	claudeArgs?: string[];
	/** Absolute path to the PreToolUse guard entrypoint. Default: the shipped
	 *  claude-code-guard.ts resolved relative to this module. */
	guardScript?: string;
	/** Reserved default per-run timeout hint for the engine's watchdog. */
	timeoutMsDefault?: number;
	/** Extra env vars for the child. Values may contain the tokens
	 *  `{scopedDir}` and `{workspaceDir}`, substituted per spawn - this is how
	 *  tests hand a per-session control-file path to a fake CLI. */
	extraEnv?: Record<string, string>;
}

interface ClaudeCodeSession extends HarnessSession {
	child: ChildProcessWithoutNullStreams;
	jsonlPath: string;
	jsonlStream: fs.WriteStream;
	lineBuf: string;
	pendingTurns: number;
	resultCount: number;
	errorCount: number;
	costUsd: number;
	tokensIn: number;
	tokensOut: number;
	lastResultText: string | null;
	lastAssistantText: string | null;
	claudeSessionId: string | null;
	lastActivityAt: number;
	exited: boolean;
	exitCode: number | null;
	spawnFailed: boolean;
	disposed: boolean;
}

const DISPOSE_GRACE_MS = 200;
const OUTPUT_TAIL_MAX = 2000;

function completionContract(workspaceDir: string): string {
	return [
		"## Completion contract",
		"",
		`- Work ONLY inside this workspace: ${workspaceDir}`,
		"- NEVER run `git commit`, `git push`, `git merge`, `git rebase`, or any history rewrite - the engine harvests your UNCOMMITTED working-tree diff after you finish.",
		"- Do not edit the card file itself.",
		"- When the task is complete, end your FINAL message with exactly one line:",
		"  `OUTCOME: <one-line summary of what you did>`",
	].join("\n");
}

function userMessageLine(text: string): string {
	return (
		JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "text", text }] },
		}) + "\n"
	);
}

export class ClaudeCodeHarness implements Harness {
	readonly name = "claude-code";

	private readonly claudeBin: string;
	private readonly claudeArgs: string[];
	private readonly guardScript: string;
	private readonly timeoutMsDefault: number;
	private readonly extraEnv: Record<string, string>;

	constructor(opts: ClaudeCodeHarnessOpts = {}) {
		this.claudeBin = opts.claudeBin ?? "claude";
		this.claudeArgs = [...(opts.claudeArgs ?? [])];
		this.guardScript =
			opts.guardScript ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-code-guard.ts");
		this.timeoutMsDefault = opts.timeoutMsDefault ?? 30 * 60 * 1000;
		this.extraEnv = { ...(opts.extraEnv ?? {}) };
	}

	async spawn(req: SpawnRequest): Promise<HarnessSession> {
		const scoped = req.workspace.scopedDir;
		fs.mkdirSync(scoped, { recursive: true });

		// ── artifacts: prompt, policy, settings ────────────────────────────────
		const promptText = [
			`# Card ${req.card.id} (${req.card.domain} / ${req.card.cardType})`,
			"",
			req.instruction,
			"",
			completionContract(req.workspace.dir),
			"",
		].join("\n");
		const promptRef = path.join(scoped, "prompt.md");
		fs.writeFileSync(promptRef, promptText);

		// Single-source constraints (knowledge layer): rendered NATIVELY as system
		// prompt injection - never a file inside the worktree (it would pollute the
		// harvested diff). The rendered form is durably referenced for conformance.
		let constraintsRef: string | null = null;
		if (req.constraints) {
			constraintsRef = path.join(scoped, "constraints-rendered.md");
			fs.writeFileSync(constraintsRef, `# Constraints (holdco knowledge layer)\n\n${req.constraints}\n`);
		}

		const policyPath = path.join(scoped, "policy.json");
		fs.writeFileSync(policyPath, JSON.stringify(req.policy, null, "\t") + "\n");

		const guardCommand = `node "${this.guardScript}"`;
		const settingsPath = path.join(scoped, "settings.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify(
				{
					hooks: {
						PreToolUse: [
							{
								matcher: "Write|Edit|MultiEdit|NotebookEdit",
								hooks: [{ type: "command", command: guardCommand }],
							},
							{ matcher: "Bash", hooks: [{ type: "command", command: guardCommand }] },
						],
					},
				},
				null,
				"\t",
			) + "\n",
		);

		// ── child env: strip nested-session markers, add holdco vars ──────────
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v === undefined) continue;
			if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
			env[k] = v;
		}
		for (const [k, v] of Object.entries(this.extraEnv)) {
			env[k] = v.replaceAll("{scopedDir}", scoped).replaceAll("{workspaceDir}", req.workspace.dir);
		}
		env.HOLDCO_POLICY = policyPath;
		env.HOLDCO_CARD_DIR = req.workspace.dir;

		const args = [
			...this.claudeArgs,
			"-p",
			"--output-format",
			"stream-json",
			"--input-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
			"--settings",
			settingsPath,
		];
		if (req.model) args.push("--model", req.model);
		if (constraintsRef) args.push("--append-system-prompt", fs.readFileSync(constraintsRef, "utf8"));

		const child = spawnChild(this.claudeBin, args, {
			cwd: req.workspace.dir,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const jsonlPath = path.join(scoped, "session.jsonl");
		const jsonlStream = fs.createWriteStream(jsonlPath, { flags: "a" });
		jsonlStream.on("error", () => {});

		const session: ClaudeCodeSession = {
			harness: this.name,
			cardId: req.workspace.cardId,
			runId: req.runId,
			promptRef,
			constraintsRef,
			startedAt: Date.now(),
			child,
			jsonlPath,
			jsonlStream,
			lineBuf: "",
			pendingTurns: 0,
			resultCount: 0,
			errorCount: 0,
			costUsd: 0,
			tokensIn: 0,
			tokensOut: 0,
			lastResultText: null,
			lastAssistantText: null,
			claudeSessionId: null,
			lastActivityAt: Date.now(),
			exited: false,
			exitCode: null,
			spawnFailed: false,
			disposed: false,
		};

		child.stdin.on("error", () => {}); // EPIPE on kill must not crash the engine
		child.stdout.on("data", (chunk: Buffer) => this.onStdout(session, chunk));
		child.stdout.on("end", () => this.flushLineBuf(session));
		child.stderr.on("data", () => {
			session.lastActivityAt = Date.now();
		});
		child.on("error", () => {
			session.spawnFailed = true;
			session.exited = true;
			session.exitCode = session.exitCode ?? -1;
		});
		child.on("exit", (code, signal) => {
			session.exited = true;
			session.exitCode = code ?? (signal ? -1 : 0);
			session.lastActivityAt = Date.now();
			this.flushLineBuf(session);
		});

		// spawn is the ONE verb allowed to throw: surface immediate launch failure.
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", (err) => reject(err));
		});

		// Deliver the brief as the first stream-json user turn; stdin stays open.
		child.stdin.write(userMessageLine(promptText));
		session.pendingTurns = 1;
		return session;
	}

	async inject(session: HarnessSession, message: string): Promise<boolean> {
		const s = session as ClaudeCodeSession;
		try {
			if (s.disposed || s.exited || !s.child.stdin.writable) return false;
			s.child.stdin.write(userMessageLine(message));
			s.pendingTurns++;
			s.lastActivityAt = Date.now();
			return true;
		} catch {
			return false;
		}
	}

	async poll(session: HarnessSession): Promise<PollResult> {
		try {
			const s = session as ClaudeCodeSession;
			if (!s || !s.child) return { state: "unknown" };
			const base = { costUsd: s.costUsd, lastActivityAt: s.lastActivityAt };
			if (s.exited) {
				if (s.exitCode === 0 && s.resultCount >= 1) return { state: "done", ...base };
				return { state: "failed", ...base };
			}
			// Alive. Multi-turn idle (all delivered turns answered) counts as done -
			// stdin is still open so inject() can start the next turn.
			if (s.pendingTurns === 0 && s.resultCount >= 1) return { state: "done", ...base };
			if (s.resultCount >= 1) return { state: "working", ...base };
			return { state: "starting", ...base };
		} catch {
			return { state: "unknown" };
		}
	}

	async collect(session: HarnessSession): Promise<HarnessArtifacts> {
		const s = session as ClaudeCodeSession;
		const finalText = s.lastResultText ?? s.lastAssistantText ?? "";
		const tail = finalText.length > OUTPUT_TAIL_MAX ? finalText.slice(-OUTPUT_TAIL_MAX) : finalText;
		return {
			outcome: extractOutcome(s.lastResultText ?? ""),
			outputTail: tail,
			usage:
				s.resultCount >= 1
					? { tokensIn: s.tokensIn, tokensOut: s.tokensOut, costUsd: s.costUsd }
					: null,
			transcriptRef: s.jsonlPath,
			promptRef: s.promptRef,
			errorCount: s.errorCount,
		};
	}

	async dispose(session: HarnessSession): Promise<void> {
		try {
			const s = session as ClaudeCodeSession;
			if (!s || s.disposed) return;
			s.disposed = true;
			try {
				s.child.stdin.end();
			} catch {
				/* already closed */
			}
			if (!s.exited) {
				try {
					s.child.kill("SIGTERM");
				} catch {
					/* already gone */
				}
				await new Promise((r) => setTimeout(r, DISPOSE_GRACE_MS));
				if (!s.exited) {
					try {
						s.child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}
			}
			this.flushLineBuf(s);
			await new Promise<void>((resolve) => {
				s.jsonlStream.end(() => resolve());
			});
		} catch {
			/* dispose never throws */
		}
	}

	/** TEST-ONLY: expose the child process so a conformance world can break the
	 *  transport underneath the adapter (SIGKILL). Not part of the Harness contract. */
	_child(session: HarnessSession): ChildProcessWithoutNullStreams | null {
		const s = session as ClaudeCodeSession;
		return s?.child ?? null;
	}

	// ── stream-json parsing ───────────────────────────────────────────────────

	private onStdout(s: ClaudeCodeSession, chunk: Buffer): void {
		s.lineBuf += chunk.toString("utf8");
		let idx: number;
		while ((idx = s.lineBuf.indexOf("\n")) >= 0) {
			const line = s.lineBuf.slice(0, idx);
			s.lineBuf = s.lineBuf.slice(idx + 1);
			this.handleLine(s, line);
		}
	}

	private flushLineBuf(s: ClaudeCodeSession): void {
		if (s.lineBuf.length > 0) {
			const line = s.lineBuf;
			s.lineBuf = "";
			this.handleLine(s, line);
		}
	}

	private handleLine(s: ClaudeCodeSession, line: string): void {
		if (line.trim().length === 0) return;
		s.lastActivityAt = Date.now();
		try {
			s.jsonlStream.write(line + "\n");
		} catch {
			/* transcript write failure must not break parsing */
		}
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return; // non-JSON noise stays in the transcript, nothing to track
		}
		if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
			s.claudeSessionId = ev.session_id;
		}
		if (ev.type === "assistant") {
			const msg = ev.message as { content?: unknown } | undefined;
			if (Array.isArray(msg?.content)) {
				for (const block of msg.content as Array<Record<string, unknown>>) {
					if (block?.type === "text" && typeof block.text === "string") s.lastAssistantText = block.text;
				}
			}
		}
		if (ev.type === "result") {
			s.resultCount++;
			s.pendingTurns = Math.max(0, s.pendingTurns - 1);
			if (typeof ev.total_cost_usd === "number") s.costUsd += ev.total_cost_usd;
			const usage = ev.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
			if (usage) {
				s.tokensIn += typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
				s.tokensOut += typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
			}
			if (typeof ev.result === "string") s.lastResultText = ev.result;
			if (ev.is_error === true) s.errorCount++;
		}
	}
}
