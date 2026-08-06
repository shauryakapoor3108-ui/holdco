// pi-guard.ts - holdco's Pi-native safety-policy enforcement: a Pi EXTENSION loaded
// into the WORKER pi process via `-e <this file>`. It is the Pi "enforcement shell"
// around the shared pure evaluator in policy.ts (one evaluator, N shells - the
// Claude Code adapter wraps the same evaluator in a PreToolUse hook process).
//
// Zero-dependency discipline: this file imports NO Pi types (the ExtensionAPI is
// taken as `any`) and no third-party packages - only node builtins and holdco's own
// policy module - so the worker can load it from any checkout without an install.
//
// Wiring (spec'd by the PiHarness launch command):
//   • HOLDCO_POLICY names the per-card policy JSON (a serialized SafetyPolicy) the
//     adapter wrote into the card's scoped dir at spawn.
//   • env absent  → notify "no policy - guard inert" and DO NOT hook tool_call
//     (a bare `pi -e pi-guard.ts` outside the engine stays unrestricted).
//   • env set but unreadable/malformed → FAIL CLOSED: every write/edit/bash tool
//     call is blocked with the load error as the reason (reads still pass - they
//     are never policy-relevant, and blocking them would blind the worker).
//   • on block: append a `policy-guard-log` entry and return the block with the
//     BLOCK_SUFFIX discipline so the worker reports instead of route-around retries.

import * as fs from "node:fs";
import { BLOCK_SUFFIX, evaluateToolAction, type PolicyVerdict, type ToolAction } from "./policy.ts";
import type { SafetyPolicy } from "./types.ts";

/** Map one Pi tool_call event onto the evaluator's ToolAction. Null = not a
 *  policy-relevant tool (read/grep/ls/… are NEVER blocked). */
function toToolAction(event: any): ToolAction | null {
	const name = String(event?.toolName ?? event?.type ?? "");
	if ((name === "write" || name === "edit") && typeof event?.input?.path === "string") {
		return { kind: "write", path: event.input.path };
	}
	if (name === "bash" && typeof event?.input?.command === "string") {
		return { kind: "bash", command: event.input.command };
	}
	return null;
}

/** The pure event→verdict mapping (exported for unit tests - no pi, no fs, no env).
 *  Exactly what the hooked handler runs once the policy is loaded. */
export function evaluatePiToolCall(policy: SafetyPolicy, event: any, cwd: string): PolicyVerdict {
	const action = toToolAction(event);
	if (!action) return { block: false, reason: null };
	return evaluateToolAction(policy, action, cwd);
}

/** Parse + shape-check the policy JSON. Throws on any malformation (the caller
 *  turns a throw into the fail-closed path - a half-parsed policy must not run). */
function parsePolicy(raw: string): SafetyPolicy {
	const data = JSON.parse(raw);
	if (!data || typeof data !== "object" || !Array.isArray(data.writeScopes) || !Array.isArray(data.denyCommands)) {
		throw new Error("malformed policy JSON (expected { writeScopes: string[], denyCommands: string[] })");
	}
	return {
		writeScopes: data.writeScopes.map((s: unknown) => String(s)),
		denyCommands: data.denyCommands.map((s: unknown) => String(s)),
	};
}

function blockReply(reason: string): { block: true; reason: string } {
	return { block: true, reason: `BLOCKED by holdco policy: ${reason}\n${BLOCK_SUFFIX}` };
}

export default function piGuard(pi: any): void {
	let policy: SafetyPolicy | null = null;
	let loadError: string | null = null;
	let hooked = false;

	pi.on("session_start", async (_event: any, ctx: any) => {
		const policyPath = process.env.HOLDCO_POLICY ?? "";
		if (!policyPath) {
			// Not launched by the engine - stay inert rather than inventing a policy.
			try {
				ctx?.ui?.notify?.("holdco policy-guard: no policy - guard inert (HOLDCO_POLICY unset)");
			} catch {
				/* notify is best-effort */
			}
			return; // skip hooking entirely
		}

		try {
			policy = parsePolicy(fs.readFileSync(policyPath, "utf8"));
			loadError = null;
			try {
				ctx?.ui?.notify?.(`holdco policy-guard: active (${policy.writeScopes.length} write scope(s), ${policy.denyCommands.length} denied pattern(s))`);
			} catch {
				/* best-effort */
			}
		} catch (err) {
			// FAIL CLOSED: a policy was mandated but cannot be read - write/bash tools
			// are blocked with this reason until a human fixes the launch.
			policy = null;
			loadError = `policy file unreadable (${policyPath}): ${err instanceof Error ? err.message : String(err)}`;
			try {
				ctx?.ui?.notify?.(`holdco policy-guard: ${loadError} - failing CLOSED for write/edit/bash`);
			} catch {
				/* best-effort */
			}
		}

		if (hooked) return; // a repeat session_start must not double-register the hook
		hooked = true;

		pi.on("tool_call", async (event: any, toolCtx: any) => {
			const cwd = String(toolCtx?.cwd ?? process.cwd());

			if (!policy) {
				// Fail-closed path: only the mutating tools are blocked; reads pass.
				if (!toToolAction(event)) return { block: false };
				const reason = loadError ?? "policy not loaded";
				try {
					pi.appendEntry("policy-guard-log", { tool: event?.toolName, input: event?.input, reason, action: "blocked_fail_closed" });
				} catch {
					/* log is best-effort */
				}
				return blockReply(reason);
			}

			const verdict = evaluatePiToolCall(policy, event, cwd);
			if (verdict.block) {
				try {
					pi.appendEntry("policy-guard-log", { tool: event?.toolName, input: event?.input, reason: verdict.reason, action: "blocked" });
				} catch {
					/* best-effort */
				}
				return blockReply(verdict.reason ?? "policy violation");
			}
			return { block: false };
		});
	});
}
