// table.ts - the cost-aware model routing table: config, not code.
//
// The cost story in one file: one dependable WORKHORSE model completes mapped
// task classes; FRONTIER models run only where judgment lives (plan/review).
// Re-routing is a config edit to knowledge/routing.json - no code change, no
// redeploy. The table is part of the governed knowledge layer, versioned and
// schema-validated like its siblings.
//
// Fail-safe like permissions.json: a malformed table falls back to the seeded
// defaults (never to "no routing"), and an unknown class routes via "default".

import * as fs from "node:fs";
import { join } from "node:path";

export type ModelTier = "workhorse" | "frontier";

export interface RoutingTable {
	version: number;
	/** tier → concrete model id (harness-native naming). */
	tiers: Record<ModelTier, string>;
	/** card class → tier. MUST carry "default". */
	routes: Record<string, ModelTier>;
	/** The cheap model the classifier itself runs on. */
	classifier: { model: string };
}

export const DEFAULT_ROUTING: RoutingTable = {
	version: 1,
	tiers: {
		workhorse: "claude-haiku-4-5",
		frontier: "claude-opus-4-8",
	},
	routes: {
		chore: "workhorse",
		research: "workhorse",
		feature: "frontier",
		plan: "frontier",
		review: "frontier",
		default: "workhorse",
	},
	classifier: { model: "claude-haiku-4-5" },
};

function isTier(v: unknown): v is ModelTier {
	return v === "workhorse" || v === "frontier";
}

/** Load knowledge/routing.json from a board root. Tolerant: malformed/missing
 *  → DEFAULT_ROUTING (warn via the optional sink); partial → merged over defaults. */
export function loadRoutingTable(boardRoot: string, warn?: (msg: string) => void): RoutingTable {
	const p = join(boardRoot, "knowledge", "routing.json");
	let raw: any;
	try {
		raw = JSON.parse(fs.readFileSync(p, "utf8"));
	} catch (err) {
		if (fs.existsSync(p)) warn?.(`routing.json unusable (${String(err)}) - using built-in defaults`);
		return DEFAULT_ROUTING;
	}
	if (!raw || typeof raw !== "object") {
		warn?.("routing.json is not an object - using built-in defaults");
		return DEFAULT_ROUTING;
	}
	const tiers = { ...DEFAULT_ROUTING.tiers };
	if (raw.tiers && typeof raw.tiers === "object") {
		for (const t of ["workhorse", "frontier"] as const) {
			if (typeof raw.tiers[t] === "string" && raw.tiers[t]) tiers[t] = raw.tiers[t];
		}
	}
	const routes: Record<string, ModelTier> = { ...DEFAULT_ROUTING.routes };
	if (raw.routes && typeof raw.routes === "object") {
		for (const [k, v] of Object.entries(raw.routes)) {
			if (isTier(v)) routes[k] = v;
			else warn?.(`routing.json: route "${k}" has unknown tier "${String(v)}" - ignored`);
		}
	}
	const classifierModel =
		raw.classifier && typeof raw.classifier === "object" && typeof raw.classifier.model === "string" && raw.classifier.model
			? raw.classifier.model
			: DEFAULT_ROUTING.classifier.model;
	return {
		version: typeof raw.version === "number" ? raw.version : DEFAULT_ROUTING.version,
		tiers,
		routes,
		classifier: { model: classifierModel },
	};
}

/** Resolve a card class to its tier + concrete model. Unknown class → "default". */
export function routeFor(table: RoutingTable, cardClass: string): { tier: ModelTier; model: string } {
	const tier = table.routes[cardClass] ?? table.routes.default ?? "workhorse";
	return { tier, model: table.tiers[tier] };
}
