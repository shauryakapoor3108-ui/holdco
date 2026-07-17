// store.ts — the unified knowledge layer: ONE governed dir per board that every
// agent on every harness reads and writes through.
//
// The split this exists to kill: coding-harness memory (per-tool config files)
// on one side, engine knowledge (vault/refs) on the other — two brains that
// drift. Here there is one store:
//
//   knowledge/
//     FILING.md          — the filing standard workers follow (seeded, human-owned)
//     constraints.md     — single-source constraints; each harness adapter RENDERS
//                          this natively into its worker (Claude Code → system
//                          prompt injection; Pi → task.md context injection).
//                          Conformance-tested: an adapter must prove the text
//                          reached its worker's delivered context.
//     permissions.json   — single-source safety policy; adapters ENFORCE it
//                          natively (Claude Code → PreToolUse hook; Pi →
//                          tool_call guard). `{worktree}`/`{scopedDir}` tokens
//                          resolve per card at dispatch.
//     messages/<id>.jsonl— per-card APPEND-ONLY message log: the shared channel
//                          every agent participating in a card writes to (v1
//                          substrate for v2 role-based agent teams).
//     decisions/ refs/ … — filed artifacts, per FILING.md.
//
// Loaders are tolerant in shape but LOUD + fail-safe in effect: a malformed
// permissions.json never widens authority — the engine falls back to the
// default deny posture and warns.

import * as fs from "node:fs";
import { join } from "node:path";
import type { EngineHost } from "../host/host.ts";
import type { SafetyPolicy } from "../harness/types.ts";
import { DEFAULT_DENY_COMMANDS } from "../harness/types.ts";

/** Schema version stamped into seeded files; JSON Schemas in schema/ validate them. */
export const KNOWLEDGE_SCHEMA_VERSION = 1;

export interface MessageEntry {
	ts: string;
	/** Who wrote it: "engine", "human", or an agent id like "claude-code:worker". */
	author: string;
	kind: "status" | "note" | "steer" | "outcome";
	text: string;
	/** Optional artifact refs (paths, run ids). */
	refs?: Record<string, string>;
}

/** permissions.json shape (version + policy template). Scope entries may use
 *  the tokens {worktree} and {scopedDir}, resolved per card at dispatch. */
export interface PermissionsFile {
	version: number;
	writeScopes: string[];
	denyCommands: string[];
}

const SEED_FILING = `# Filing standard

Every durable artifact a worker produces is FILED, not chatted:
- kebab-case filenames, one artifact per file
- domain artifacts → \`domains/<domain>/refs/\`
- cross-domain artifacts → \`knowledge/decisions/\` (decisions) or \`knowledge/refs/\`
- an artifact states what it is, why it exists, and what produced it
`;

const SEED_CONSTRAINTS = `---
version: ${KNOWLEDGE_SCHEMA_VERSION}
---
# Constraints (single source — rendered into every worker, every harness)

- Work ONLY inside your assigned worktree. Your uncommitted diff is your output.
- Never run git commit / push / merge / rebase — publishing is a human gate.
- Never edit the card file or its status — the engine owns board state.
- File durable artifacts per knowledge/FILING.md; do not leave results in chat.
- End your final message with one line: \`OUTCOME: <what you produced and where>\`.
`;

function seedPermissions(): PermissionsFile {
	return {
		version: KNOWLEDGE_SCHEMA_VERSION,
		writeScopes: ["{worktree}", "{scopedDir}"],
		denyCommands: [...DEFAULT_DENY_COMMANDS],
	};
}

export class KnowledgeStore {
	readonly root: string;
	private readonly host: EngineHost | null;

	constructor(boardRoot: string, host?: EngineHost) {
		this.root = join(boardRoot, "knowledge");
		this.host = host ?? null;
	}

	/** Scaffold the governed dir (idempotent — existing files are never overwritten). */
	ensure(): void {
		fs.mkdirSync(join(this.root, "messages"), { recursive: true });
		fs.mkdirSync(join(this.root, "decisions"), { recursive: true });
		fs.mkdirSync(join(this.root, "refs"), { recursive: true });
		const seed = (file: string, content: string) => {
			const p = join(this.root, file);
			if (!fs.existsSync(p)) fs.writeFileSync(p, content, "utf8");
		};
		seed("FILING.md", SEED_FILING);
		seed("constraints.md", SEED_CONSTRAINTS);
		seed("permissions.json", JSON.stringify(seedPermissions(), null, "\t") + "\n");
	}

	// ── constraints (single source, rendered per harness) ──────────────────────

	/** The constraints text (frontmatter stripped) — what adapters must deliver
	 *  into every worker's context. "" when the file is absent. */
	loadConstraints(): string {
		try {
			const raw = fs.readFileSync(join(this.root, "constraints.md"), "utf8");
			return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
		} catch {
			return "";
		}
	}

	// ── permissions (single source, enforced per harness) ──────────────────────

	/**
	 * Resolve the safety policy for one card. Malformed/missing file → the
	 * DEFAULT deny posture (worktree-scoped, standard deny list) + a warning;
	 * a config error must narrow authority, never widen it.
	 */
	policyFor(scope: { worktree: string; scopedDir: string }): SafetyPolicy {
		const fallback: SafetyPolicy = {
			writeScopes: [scope.worktree, scope.scopedDir],
			denyCommands: [...DEFAULT_DENY_COMMANDS],
		};
		let file: PermissionsFile;
		try {
			const raw = JSON.parse(fs.readFileSync(join(this.root, "permissions.json"), "utf8"));
			if (
				!raw ||
				typeof raw !== "object" ||
				!Array.isArray(raw.writeScopes) ||
				!Array.isArray(raw.denyCommands) ||
				!raw.writeScopes.every((s: unknown) => typeof s === "string") ||
				!raw.denyCommands.every((s: unknown) => typeof s === "string")
			) {
				throw new Error("permissions.json: expected { version, writeScopes: string[], denyCommands: string[] }");
			}
			file = raw as PermissionsFile;
		} catch (err) {
			this.warn(`permissions.json unusable (${String(err)}) — falling back to the default deny posture`);
			return fallback;
		}
		const resolve = (s: string) => s.replace(/\{worktree\}/g, scope.worktree).replace(/\{scopedDir\}/g, scope.scopedDir);
		const writeScopes = file.writeScopes.map(resolve).filter((s) => s.startsWith("/"));
		if (writeScopes.length === 0) {
			this.warn("permissions.json resolved to zero absolute write scopes — falling back to the default deny posture");
			return fallback;
		}
		return { writeScopes, denyCommands: file.denyCommands };
	}

	// ── per-card message log (append-only; the v2 team substrate) ───────────────

	private messagePath(cardId: string): string {
		// Card ids are [A-Za-z0-9._-]; strip anything else so a hostile id can't escape.
		return join(this.root, "messages", `${cardId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
	}

	/** Append one entry to a card's message log. Never throws (the log is
	 *  load-bearing for humans, not for control flow). */
	appendMessage(cardId: string, entry: Omit<MessageEntry, "ts"> & { ts?: string }): void {
		try {
			fs.mkdirSync(join(this.root, "messages"), { recursive: true });
			const full: MessageEntry = { ts: entry.ts ?? new Date().toISOString(), author: entry.author, kind: entry.kind, text: entry.text, ...(entry.refs ? { refs: entry.refs } : {}) };
			const p = this.messagePath(cardId);
			// Heal the line boundary: a crash mid-append can leave an unterminated
			// line; appending straight onto it would corrupt THIS entry too. One
			// leading newline quarantines the damage to the already-lost line.
			let needsNewline = false;
			try {
				const size = fs.statSync(p).size;
				if (size > 0) {
					const fd = fs.openSync(p, "r");
					const buf = Buffer.alloc(1);
					fs.readSync(fd, buf, 0, 1, size - 1);
					fs.closeSync(fd);
					needsNewline = buf.toString("utf8") !== "\n";
				}
			} catch {
				/* no file yet */
			}
			fs.appendFileSync(p, (needsNewline ? "\n" : "") + JSON.stringify(full) + "\n", "utf8");
		} catch (err) {
			this.warn(`message log append failed for ${cardId}: ${String(err)}`);
		}
	}

	/** Read a card's full message log (empty when none). Tolerant of a trailing
	 *  partial line (a crash mid-append must not poison the reader). */
	readMessages(cardId: string): MessageEntry[] {
		try {
			const raw = fs.readFileSync(this.messagePath(cardId), "utf8");
			const out: MessageEntry[] = [];
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					out.push(JSON.parse(line));
				} catch {
					/* trailing partial line — skip */
				}
			}
			return out;
		} catch {
			return [];
		}
	}

	private warn(msg: string): void {
		try {
			this.host?.notify(`knowledge: ${msg}`, "warning");
			this.host?.log.entry("card-engine-log", { event: "KNOWLEDGE_WARN", detail: msg, ts: new Date().toISOString() });
		} catch {
			/* never throw from a warning */
		}
	}
}
