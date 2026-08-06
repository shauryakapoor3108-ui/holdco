// policy.ts - the pure safety-policy evaluator every harness adapter enforces
// NATIVELY (Claude Code → PreToolUse hook process; Pi → tool_call guard
// extension; Codex → sandbox config). One evaluator, N enforcement shells: the
// decision logic lives here so conformance can assert identical verdicts across
// harnesses.
//
// Model (ported from the source system's damage-control, recast from a denylist
// of protected paths to the worker allowlist the engine actually needs):
//   • file writes/edits are allowed ONLY under policy.writeScopes (the per-card
//     worktree + scoped dir). Reads are never blocked.
//   • shell commands matching a denyCommands pattern are blocked outright
//     (git push/commit/merge/… - publishing is a human gate; the harvest reads
//     the UNCOMMITTED worktree).
//   • shell commands whose WRITE TARGETS resolve outside writeScopes are
//     blocked. Only write/delete verbs trip this (redirects, tee, sed -i,
//     rm/mv/…, dd of=) - a command merely *referencing* an outside path (cat,
//     grep, ls) never does. Verbs are word-boundary matched so `used` or
//     `committee` don't masquerade as sed/tee (damage-control bug-1/3 lesson).

import * as os from "node:os";
import * as path from "node:path";
import type { SafetyPolicy } from "./types.ts";

export type ToolAction =
	| { kind: "write"; path: string }
	| { kind: "bash"; command: string };

export interface PolicyVerdict {
	block: boolean;
	reason: string | null;
}

const ALLOW: PolicyVerdict = { block: false, reason: null };

function resolveTarget(p: string, cwd: string): string {
	if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
	return path.resolve(cwd, p);
}

function underScope(resolved: string, scopes: string[], cwd: string): boolean {
	return scopes.some((s) => {
		const scope = path.resolve(cwd, s);
		return resolved === scope || resolved.startsWith(scope.endsWith(path.sep) ? scope : scope + path.sep);
	});
}

/**
 * Extract the candidate WRITE/DELETE target tokens of a shell command. Deliberately
 * conservative: it looks for the mutation verbs + redirect forms, not a full shell
 * parse. Unrecognised constructs pass through - the worktree cwd plus denyCommands
 * carry the rest of the guarantee.
 */
export function bashWriteTargets(command: string): string[] {
	const targets: string[] = [];
	const push = (m: RegExpMatchArray | null, group = 1) => {
		const t = m?.[group];
		if (t) targets.push(t.replace(/^['"]|['"]$/g, ""));
	};
	// redirects: > file, >> file (skip fd redirects like 2>&1 and /dev/*)
	for (const m of command.matchAll(/(?<![0-9&])>>?\s*(['"]?[^\s'";|&]+)/g)) push(m);
	// tee [-a] file
	for (const m of command.matchAll(/\btee\b\s+(?:-\S+\s+)*(['"]?[^\s'";|&]+)/g)) push(m);
	// sed -i ... file (last non-flag arg of the segment)
	for (const m of command.matchAll(/\bsed\b\s+-i\S*\s+(?:(?:-e\s+)?(?:'[^']*'|"[^"]*"|\S+)\s+)*?(['"]?[/~][^\s'";|&]*)/g)) push(m);
	// mutation verbs with path args: rm/rmdir/unlink/mv/cp/truncate/shred/chmod/chown/ln/mkdir/touch
	for (const m of command.matchAll(/\b(?:rm|rmdir|unlink|mv|cp|truncate|shred|chmod|chown|ln|mkdir|touch)\b((?:\s+(?:-\S+|'[^']*'|"[^"]*"|[^\s;|&]+))*)/g)) {
		for (const arg of (m[1] ?? "").trim().split(/\s+/)) {
			if (arg && !arg.startsWith("-")) targets.push(arg.replace(/^['"]|['"]$/g, ""));
		}
	}
	// dd of=file
	for (const m of command.matchAll(/\bdd\b[^|;&]*?\bof=(['"]?[^\s'";|&]+)/g)) push(m);
	return targets.filter((t) => t !== "/dev/null" && !t.startsWith("/dev/") && !t.startsWith("&"));
}

/** Evaluate one tool action against the policy. Pure - no fs, no env. */
export function evaluateToolAction(policy: SafetyPolicy, action: ToolAction, cwd: string): PolicyVerdict {
	if (action.kind === "write") {
		const resolved = resolveTarget(action.path, cwd);
		if (!underScope(resolved, policy.writeScopes, cwd)) {
			return { block: true, reason: `write outside workspace scope: ${resolved}` };
		}
		return ALLOW;
	}

	// bash
	for (const pattern of policy.denyCommands) {
		try {
			if (new RegExp(pattern).test(action.command)) {
				return { block: true, reason: `denied command pattern: ${pattern}` };
			}
		} catch {
			/* a malformed pattern must not disable the guard - skip it */
		}
	}
	for (const target of bashWriteTargets(action.command)) {
		// Only verdict absolute/homedir targets; relative ones resolve inside the
		// worktree cwd, which is in scope by construction.
		if (!target.startsWith("/") && !target.startsWith("~")) continue;
		const resolved = resolveTarget(target, cwd);
		if (!underScope(resolved, policy.writeScopes, cwd)) {
			return { block: true, reason: `shell write target outside workspace scope: ${resolved}` };
		}
	}
	return ALLOW;
}

/** The instruction appended to every block so the worker reports instead of
 *  route-around retries (verbatim discipline from damage-control). */
export const BLOCK_SUFFIX =
	"DO NOT attempt to work around this restriction. DO NOT retry with alternative commands, paths, or approaches that achieve the same result. Report this block and continue with what remains doable inside your workspace.";
