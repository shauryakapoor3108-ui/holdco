// cockpit.ts — the ONE herdr workspace per project ("cockpit") where everything runs
// visibly: the owner pi in the root pane, workers + model (rpc) calls as SPLIT PANES of
// the same tab. The owner sits in the left column; workers stack down the right column.
// Once the cockpit tab holds COCKPIT_TAB_CAP panes (owner + 3 workers) the next worker
// overflows into a "bench" tab of the SAME workspace.
// (EngineHost port: Pi-free already — near-verbatim; constructor parameter property
// expanded to an explicit field per the strip-only TypeScript rule.)
//
// The single ensure-cockpit helper is SHARED (not duplicated) by the worker-pool (workers)
// and fleet/plan/lib/rpc.ts (model calls); the owner-launcher (fleet owner-start) creates
// the cockpit in bash and the pool RE-creates it here if it is gone at dispatch.
//
// LIVE HERDR FACTS (herdr 0.5.10, probed this session):
//   • pane_ids are POSITIONAL — closing ANY pane RENUMBERS every higher-id pane in the
//     workspace (`pane get <old-id>` → pane_not_found). A cached pane_id therefore goes
//     stale the moment a sibling closes. Everything here addresses panes by their STABLE
//     LABEL (owner:/worker:/rpc:) and re-resolves the concrete pane_id at each use via
//     `pane list --workspace`.
//   • herdr AUTO-CLOSES a tab when its last pane closes — so the bench tab needs no
//     explicit `tab close`; closing the last worker pane reaps it.

import type { AgentState, HerdrAdapter } from "./herdr-adapter.ts";

/** owner + up to 3 workers = 4 panes in the cockpit tab; the 4th worker overflows to bench. */
export const COCKPIT_TAB_CAP = 4;
/** The overflow tab's label (one per workspace). */
export const BENCH_TAB_LABEL = "bench";
/** report-agent --source for every cockpit-painted chip. */
export const COCKPIT_AGENT_SOURCE = "cockpit";

/** The cockpit workspace label for a project slug: `cockpit-<slug>` (or `cockpit` when unslugged). */
export function cockpitLabelFor(slug: string | undefined): string {
	return slug ? `cockpit-${slug}` : "cockpit";
}
/** The owner pane label for a slug: `owner:<slug>` (or `owner`). */
export function ownerLabelFor(slug: string | undefined): string {
	return slug ? `owner:${slug}` : "owner";
}
/** True for any cockpit workspace label (`cockpit` or `cockpit-*`). */
export function isCockpitLabel(label: string): boolean {
	return label === "cockpit" || label.startsWith("cockpit-");
}
/** True for the owner/anchor pane label (`owner` or `owner:*`). */
export function isOwnerLabel(label: string | undefined): boolean {
	return label === "owner" || (!!label && label.startsWith("owner:"));
}
/** Derive the owner pane label from a cockpit workspace label (`cockpit-x` → `owner:x`). */
export function ownerLabelFromCockpitLabel(label: string): string {
	if (label.startsWith("cockpit-")) return `owner:${label.slice("cockpit-".length)}`;
	return "owner";
}

export interface CockpitDeps {
	herdr: HerdrAdapter;
	/** exact cockpit workspace label to find-or-create (cockpit-<slug>). */
	label: string;
	/** project root — the --cwd for a re-created cockpit workspace. */
	cwd: string;
	/** structured log sink (best-effort). */
	log?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * A handle to the project's single cockpit workspace. Instances CACHE the resolved
 * workspace id but NEVER cache worker/rpc pane ids (they renumber — see file header).
 */
export class Cockpit {
	private workspaceId: string | null = null;
	/** Coalesce concurrent ensure() callers so N simultaneous launches create ONE cockpit. */
	private ensuring: Promise<string | null> | null = null;
	/** Serialize place() so concurrent launches stack cleanly (no split-race / cap over-fill). */
	private placeLock: Promise<unknown> = Promise.resolve();
	private readonly d: CockpitDeps;

	constructor(d: CockpitDeps) {
		this.d = d;
	}

	/** The resolved cockpit workspace id (null until find/ensure succeeds). */
	get id(): string | null {
		return this.workspaceId;
	}

	/**
	 * Adopt an EXISTING cockpit (no create) — used by rpc.ts, which routes through the
	 * cockpit only when one is already present. Returns null when no cockpit exists.
	 */
	static async adopt(herdr: HerdrAdapter, cwd: string, log?: CockpitDeps["log"]): Promise<Cockpit | null> {
		const c = new Cockpit({ herdr, label: "cockpit", cwd, log });
		return (await c.find()) ? c : null;
	}

	/** Find the cockpit workspace by exact label, else any `cockpit*` workspace. Caches + returns
	 *  its id (and adopts its actual label), or null when absent. */
	async find(): Promise<string | null> {
		const list = await this.d.herdr.workspaceList();
		const hit = list.find((w) => w.label === this.d.label) ?? list.find((w) => isCockpitLabel(w.label));
		if (hit) {
			this.workspaceId = hit.workspace_id;
			this.d.label = hit.label;
			return hit.workspace_id;
		}
		this.workspaceId = null;
		return null;
	}

	/** Find-or-create the cockpit workspace. The owner-launcher normally creates it; if it is
	 *  gone at dispatch we rebuild a headless one (the owner keeps running in its original —
	 *  now orphaned — pane) so workers still run visibly. Returns the id (null on herdr failure). */
	async ensure(): Promise<string | null> {
		if (this.workspaceId) return this.workspaceId;
		if (this.ensuring) return this.ensuring; // a concurrent caller is already creating it
		const run = (async () => {
			const found = await this.find();
			if (found) return found;
			const ws = await this.d.herdr.workspaceCreate(this.d.label, this.d.cwd);
			if (!ws.ok || !ws.workspaceId) {
				this.d.log?.("COCKPIT_CREATE_FAILED", { label: this.d.label });
				return null;
			}
			this.workspaceId = ws.workspaceId;
			// Label the fresh root pane as the owner anchor so placement finds it uniformly.
			if (ws.paneId) await this.d.herdr.paneRename(ws.paneId, ownerLabelFromCockpitLabel(this.d.label));
			this.d.log?.("COCKPIT_RECREATED", { label: this.d.label, workspace: ws.workspaceId });
			return this.workspaceId;
		})();
		this.ensuring = run;
		try {
			return await run;
		} finally {
			this.ensuring = null;
		}
	}

	/**
	 * Place a new pane for `paneLabel` (worker:<id> / rpc:<purpose>): split the cockpit tab
	 * (owner→right for the first, then stack down) while it holds < COCKPIT_TAB_CAP panes,
	 * else overflow into the bench tab (created on first overflow, split down within).
	 * Renames the pane + paints its agent chip. Returns the new pane id (null on failure).
	 */
	async place(paneLabel: string, state: AgentState, paneCwd?: string): Promise<string | null> {
		// Serialize placements: N concurrent launches must not race the split geometry (which
		// reads the current pane list to pick the anchor + cockpit-vs-bench branch).
		const run = this.placeLock.then(() => this.doPlace(paneLabel, state, paneCwd));
		this.placeLock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async doPlace(paneLabel: string, state: AgentState, paneCwd?: string): Promise<string | null> {
		const ws = await this.ensure();
		if (!ws) return null;
		const panes = await this.d.herdr.paneList(ws);
		const owner = panes.find((p) => isOwnerLabel(p.label));
		const anchorTab = owner?.tab_id ?? panes[0]?.tab_id;
		const cockpitPanes = anchorTab ? panes.filter((p) => p.tab_id === anchorTab) : panes;

		let pane: string | null = null;
		if (cockpitPanes.length > 0 && cockpitPanes.length < COCKPIT_TAB_CAP) {
			// Room in the cockpit tab.
			const workers = cockpitPanes.filter((p) => !isOwnerLabel(p.label));
			if (workers.length === 0) {
				const anchor = owner?.pane_id ?? cockpitPanes[0].pane_id;
				pane = await this.d.herdr.paneSplit(anchor, "right", paneCwd);
			} else {
				pane = await this.d.herdr.paneSplit(workers[workers.length - 1].pane_id, "down", paneCwd);
			}
		} else {
			// Overflow → the bench tab.
			const tabs = await this.d.herdr.tabList(ws);
			const bench = tabs.find((t) => t.label === BENCH_TAB_LABEL);
			if (!bench) {
				const created = await this.d.herdr.tabCreate(ws, BENCH_TAB_LABEL, paneCwd);
				pane = created?.paneId ?? null;
			} else {
				const benchPanes = panes.filter((p) => p.tab_id === bench.tab_id);
				const last = benchPanes[benchPanes.length - 1];
				pane = last ? await this.d.herdr.paneSplit(last.pane_id, "down", paneCwd) : null;
			}
		}
		if (!pane) {
			this.d.log?.("COCKPIT_PLACE_FAILED", { label: paneLabel, workspace: ws });
			return null;
		}
		await this.d.herdr.paneRename(pane, paneLabel);
		await this.d.herdr.paneReportAgent(pane, COCKPIT_AGENT_SOURCE, paneLabel, state);
		return pane;
	}

	/** Resolve a label to its current pane id AND report whether the scoped pane list was
	 *  non-empty — so a caller can tell a GENUINE omission (pane gone) from a transient/empty
	 *  herdr read (the adapter returns [] on a timeout too, which must NOT read as "dead"). */
	async locate(paneLabel: string): Promise<{ paneId: string | null; listNonEmpty: boolean }> {
		const ws = this.workspaceId ?? (await this.find());
		if (!ws) return { paneId: null, listNonEmpty: false };
		const panes = await this.d.herdr.paneList(ws);
		const hit = panes.find((p) => p.label === paneLabel);
		return { paneId: hit?.pane_id ?? null, listNonEmpty: panes.length > 0 };
	}

	/** Resolve the CURRENT pane id for a label (renumber-safe), or null if the pane is gone. */
	async resolve(paneLabel: string): Promise<string | null> {
		return (await this.locate(paneLabel)).paneId;
	}

	/** Best-effort agent-chip update for a label (e.g. working → idle on completion). */
	async report(paneLabel: string, state: AgentState): Promise<void> {
		const id = await this.resolve(paneLabel);
		if (id) await this.d.herdr.paneReportAgent(id, COCKPIT_AGENT_SOURCE, paneLabel, state);
	}

	/** Teardown: close the pane for a label (NOT the workspace). herdr auto-closes the bench
	 *  tab when its last pane goes. Idempotent — a missing label is a no-op. */
	async close(paneLabel: string): Promise<void> {
		const id = await this.resolve(paneLabel);
		if (id) await this.d.herdr.paneClose(id);
	}
}
