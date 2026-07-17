// claude-code-guard.ts — the Claude Code PreToolUse hook entrypoint that
// enforces the holdco SafetyPolicy NATIVELY inside a Claude Code worker.
//
// Claude Code executes this file as `node <path-to-this-file>` (configured by
// the adapter's generated settings.json). Protocol:
//   • the hook payload arrives as JSON on stdin: { tool_name, tool_input, cwd, … }
//   • exit 0  → allow the tool call
//   • exit 2  → BLOCK the tool call; stderr text is fed back to the model
//
// The policy itself is read from the file named by env HOLDCO_POLICY (written
// by the adapter into the per-card scoped dir). Verdict logic lives in the
// shared evaluator (policy.ts) so every harness blocks identically.
//
// Failure posture:
//   • HOLDCO_POLICY unset       → allow (the adapter always sets it; unset
//     means this guard is running outside a holdco worker).
//   • policy file unreadable    → FAIL CLOSED for write/bash tools (exit 2):
//     a worker whose guard lost its policy must not write anywhere.
//   • unknown tool / no target  → allow (nothing to verdict).
//
// The file is both an importable module (runGuard, for unit tests) and a
// script (main, when executed directly).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolAction } from "./policy.ts";
import { BLOCK_SUFFIX, evaluateToolAction } from "./policy.ts";
import type { SafetyPolicy } from "./types.ts";

export interface GuardResult {
	exitCode: number;
	stderr: string;
}

const ALLOW: GuardResult = { exitCode: 0, stderr: "" };

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function block(reason: string): GuardResult {
	return { exitCode: 2, stderr: `BLOCKED by holdco policy: ${reason}\n${BLOCK_SUFFIX}` };
}

/** Map a PreToolUse payload to the shared ToolAction shape; null = nothing to verdict. */
function toAction(toolName: unknown, toolInput: unknown): ToolAction | null {
	const input = (toolInput ?? {}) as Record<string, unknown>;
	if (typeof toolName === "string" && WRITE_TOOLS.has(toolName)) {
		const p = input.file_path ?? input.notebook_path;
		if (typeof p === "string" && p.length > 0) return { kind: "write", path: p };
		return null;
	}
	if (toolName === "Bash") {
		const cmd = input.command;
		if (typeof cmd === "string" && cmd.length > 0) return { kind: "bash", command: cmd };
		return null;
	}
	return null;
}

/** The whole guard as a pure-ish function (fs read of the policy file only),
 *  so unit tests exercise the exact verdict path the hook process runs. */
export function runGuard(input: string, env: Record<string, string | undefined>): GuardResult {
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(input) as Record<string, unknown>;
	} catch {
		return ALLOW; // unparseable payload: cannot even tell the tool — allow
	}
	if (payload === null || typeof payload !== "object") return ALLOW;

	const action = toAction(payload.tool_name, payload.tool_input);
	if (!action) return ALLOW; // unknown tool or missing fields

	const policyPath = env.HOLDCO_POLICY;
	if (!policyPath) return ALLOW; // not running under a holdco worker

	let policy: SafetyPolicy;
	try {
		const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8")) as SafetyPolicy;
		if (!Array.isArray(parsed.writeScopes) || !Array.isArray(parsed.denyCommands)) {
			throw new Error("policy missing writeScopes/denyCommands arrays");
		}
		policy = parsed;
	} catch (err) {
		// FAIL CLOSED: a write/bash action with an unreadable policy is blocked.
		return block(`policy file unreadable (${policyPath}): ${String(err)}`);
	}

	const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
	let verdict;
	try {
		verdict = evaluateToolAction(policy, action, cwd);
	} catch (err) {
		return block(`policy evaluation failed: ${String(err)}`); // fail closed
	}
	if (verdict.block) return block(verdict.reason ?? "policy violation");
	return ALLOW;
}

async function main(): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const input = Buffer.concat(chunks).toString("utf8");
	let result: GuardResult;
	try {
		result = runGuard(input, process.env);
	} catch {
		// runGuard handles every expected failure itself; a truly unexpected
		// throw must not surface as a hook error exit code — allow.
		result = ALLOW;
	}
	if (result.stderr) process.stderr.write(result.stderr + "\n");
	process.exit(result.exitCode);
}

function isDirectExecution(): boolean {
	const argv1 = process.argv[1];
	if (!argv1) return false;
	try {
		return path.resolve(argv1) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (isDirectExecution()) {
	void main();
}
