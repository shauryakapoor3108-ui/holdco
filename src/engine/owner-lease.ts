// owner-lease.ts - D8 Component 2: the single-owner lease guard (engine-layer leader election).
//
// Two interactive `pi` REPLs on the same vault each build a Reconciler + snapshot and then
// auto-revert each other (the bug-2 / 12h revert-storm incident). The fix is a lease the ENGINE
// acquires at init: exactly one owner per vault arms the reconciler; a second loads INERT.
//
// This module is PURE policy + thin fs/proc I/O - it NEVER writes card `status`, never touches a
// snapshot, never reconciles. `index.ts` calls `acquireLease` once in `session_start` (before the
// `if (!reconciler)` construction block) and `releaseLease` in `session_shutdown`.
//
// FAIL-SAFE INVARIANT: the only tolerated error mode is REFUSING when we could have acquired -
// never a false ACQUIRE that lets two live owners both run. Every ambiguous probe result that
// could mean "a live owner exists" resolves to REFUSE.

import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";

/** The on-disk lease record. `pid`+`startedAt`+the cmdline reuse-check fully cover PID-reuse;
 *  no `nonce` (an undocumented field is debt - spec Item-11). */
export interface Lease {
	pid: number;
	startedAt: string; // ISO
	host: string;
}

/** Outcome of an acquire attempt. `owner:true` → this instance arms the engine. */
export type LeaseOutcome =
	| { owner: true; action: "acquired" | "reclaimed-dead" | "reclaimed-reused" | "self"; lease: Lease; log?: string }
	| { owner: false; action: "refused"; holderPid: number; log: string };

/** Injected probes (real impls below) so the self-test can simulate dead / live-pi / reused /
 *  EACCES pids deterministically without spawning real processes. */
export interface LeaseProbe {
	/** EXISTS? `process.kill(pid,0)` → true on success OR EPERM; false on ESRCH (dead). */
	alive: (pid: number) => boolean;
	/** Read `/proc/<pid>/cmdline`. ok→the raw (NUL-joined) string; otherwise the reason. */
	cmdline: (pid: number) => { ok: true; value: string } | { ok: false; reason: "ENOENT" | "EACCES" | "OTHER" };
}

// ── lease path (cwd-INVARIANT - keyed to the vault, not the launch dir) ─────────────────────────
// Derive from the RESOLVED absolute cards dir so two `pi` instances pointing at the same vault
// from different cwds contend on the SAME lock; genuinely different vaults get different locks.
export function leasePathFor(cardsDir: string): string {
	return resolve(join(dirname(resolve(cardsDir)), ".pi", "card-engine-owner.lock"));
}

// ── the "is this pid a pi engine process" matcher (sub-decision 1, pi-verified) ─────────────────
// PERMISSIVE toward "is pi": a false "yes" only ever causes a (safe) REFUSE; a false "no" could
// double-own, so we err toward yes. On this deployment a pi REPL's cmdline is `pi`; launched as
// `node …/pi-coding-agent/dist/cli.js` it carries the package path.
export function looksLikePi(cmdline: string): boolean {
	const tokens = cmdline.split("\0").filter(Boolean);
	if (tokens.some((t) => t.split("/").pop() === "pi")) return true;
	if (cmdline.includes("pi-coding-agent")) return true;
	if (cmdline.includes("/cli.js") && tokens.some((t) => t.split("/").pop() === "node")) return true;
	return false;
}

// ── real probes ────────────────────────────────────────────────────────────────────────────────
export const realProbe: LeaseProbe = {
	alive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true; // signal delivered → alive
		} catch (err: any) {
			if (err?.code === "EPERM") return true; // exists, not ours to signal → alive
			return false; // ESRCH (or anything else) → treat as dead
		}
	},
	cmdline(pid: number) {
		try {
			return { ok: true as const, value: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8") };
		} catch (err: any) {
			const code = err?.code;
			if (code === "ENOENT") return { ok: false as const, reason: "ENOENT" as const };
			if (code === "EACCES" || code === "EPERM") return { ok: false as const, reason: "EACCES" as const };
			return { ok: false as const, reason: "OTHER" as const };
		}
	},
};

function readLease(leasePath: string): { lease: Lease } | { corrupt: true } | null {
	let raw: string;
	try {
		raw = fs.readFileSync(leasePath, "utf8");
	} catch {
		return null; // no lease file
	}
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
			return { lease: { pid: parsed.pid, startedAt: String(parsed.startedAt ?? ""), host: String(parsed.host ?? "") } };
		}
		return { corrupt: true };
	} catch {
		return { corrupt: true }; // unparseable byte(s) - crash-mid-write or external clobber
	}
}

function writeLease(leasePath: string, pid: number): Lease {
	const lease: Lease = { pid, startedAt: new Date().toISOString(), host: os.hostname() };
	fs.mkdirSync(dirname(leasePath), { recursive: true });
	fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2), "utf8");
	return lease;
}

/**
 * Resolve lease state and (if we win) write our lease. Pure decision tree + the single
 * winning write. Never writes card status. See tasks/phase-d8-c2-lease-subdecisions.md.
 */
export function acquireLease(leasePath: string, selfPid: number = process.pid, probe: LeaseProbe = realProbe): LeaseOutcome {
	const existing = readLease(leasePath);

	// No lease file → acquire.
	if (existing === null) {
		return { owner: true, action: "acquired", lease: writeLease(leasePath, selfPid) };
	}

	// Corrupt/unparseable lock → we cannot probe an owner. A torn write during a live owner's
	// lease creation, however rare, means overwriting could double-own → FAIL SAFE → REFUSE.
	// Recovery is a human deleting the (clearly broken) lock file - visible and trivial. Strict
	// (refuse) is the default precisely because invariant (c) forbids any false acquire.
	if ("corrupt" in existing) {
		return { owner: false, action: "refused", holderPid: 0, log: "lease file is corrupt/unparseable - refusing (fail-safe). Delete .pi/card-engine-owner.lock to recover if no owner is running." };
	}

	const lease = existing.lease;

	// CRITICAL self-idempotency: Pi emits session_start >1× per REPL and /reload rebuilds the
	// factory in the SAME process (same pid). Recognise our own pid; never refuse ourselves.
	if (lease.pid === selfPid) {
		return { owner: true, action: "self", lease };
	}

	// Held by another pid: is it alive?
	if (!probe.alive(lease.pid)) {
		// ESRCH - the dead-owner case (the 12h incident). Reclaim.
		return { owner: true, action: "reclaimed-dead", lease: writeLease(leasePath, selfPid), log: `reclaimed stale owner lease (dead pid ${lease.pid})` };
	}

	// Alive + not us → disambiguate PID-reuse via /proc/<pid>/cmdline (fails SAFE).
	const cm = probe.cmdline(lease.pid);
	if (!cm.ok) {
		if (cm.reason === "ENOENT") {
			// pid vanished between the alive-check and the read → gone → cannot double-own → reclaim.
			return { owner: true, action: "reclaimed-dead", lease: writeLease(leasePath, selfPid), log: `reclaimed stale owner lease (pid ${lease.pid} vanished during probe)` };
		}
		// EACCES (live process, other user) or OTHER → fail SAFE → refuse.
		return { owner: false, action: "refused", holderPid: lease.pid, log: `another process holds pid ${lease.pid} and its cmdline is unreadable (${cm.reason}) - refusing (fail-safe)` };
	}

	// An EMPTY/whitespace cmdline (zombie, kernel thread, or a process mid-exec) is NOT an
	// unambiguous "not pi" signal → fail SAFE → refuse (the only confident reclaim signal is a
	// readable, non-empty cmdline that does not look like pi).
	if (cm.value.replace(/\0/g, "").trim() === "") {
		return { owner: false, action: "refused", holderPid: lease.pid, log: `pid ${lease.pid} is alive with an empty cmdline (indeterminate) - refusing (fail-safe)` };
	}

	if (looksLikePi(cm.value)) {
		// A real, live second pi owner → REFUSE.
		return { owner: false, action: "refused", holderPid: lease.pid, log: `another live pi owner holds the lease (pid ${lease.pid})` };
	}
	// Live pid, but it's some OTHER program → the pid was reused → reclaim.
	return { owner: true, action: "reclaimed-reused", lease: writeLease(leasePath, selfPid), log: `reclaimed lease: pid ${lease.pid} was reused by a non-pi process` };
}

/**
 * Release on shutdown - delete the lease ONLY when the on-disk pid is ours. An INERT second
 * owner (different pid) thus never deletes the real owner's lease. A /reload fires shutdown
 * (release) then session_start (re-acquire, same pid) → clean.
 */
export function releaseLease(leasePath: string, selfPid: number = process.pid): boolean {
	const existing = readLease(leasePath);
	if (existing === null || "corrupt" in existing) return false;
	if (existing.lease.pid !== selfPid) return false;
	try {
		fs.unlinkSync(leasePath);
		return true;
	} catch {
		return false;
	}
}
