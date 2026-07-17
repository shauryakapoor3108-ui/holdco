// goal-dag.ts — the PURE goal-DAG validators, shared by the `/commit-goal` REPL command
// (index.ts) AND the control-inbox `commit-goal` verb (control-inbox.ts).
//
// Extracted verbatim from index.ts so there is ONE source of truth for the commit-to-Held
// admission check: both the interactive owner command and the seam-driven drain refuse the
// SAME invalid DAGs (dangling deps, cycles) all-or-nothing. Zero IO, zero deps — a total
// function of (goalIds, depsById, filedIds) → first failure message | null.

/**
 * Extract an EXACT cycle path (e.g. `["a","b","a"]` for a→b→a) from a directed graph via a
 * stack-tracking DFS. `adj` is the `depends_on` adjacency (card → its dep ids), restricted to
 * `nodes` (the goal cards). Returns the first cycle found, or null if the subgraph is acyclic.
 */
export function findCyclePath(nodes: Set<string>, adj: Map<string, string[]>): string[] | null {
	const visited = new Set<string>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	let found: string[] | null = null;
	const dfs = (n: string): boolean => {
		visited.add(n);
		onStack.add(n);
		stack.push(n);
		for (const m of adj.get(n) ?? []) {
			if (!nodes.has(m)) continue; // an off-graph (already-Filed) dep can't close a Draft-card cycle
			if (onStack.has(m)) {
				found = [...stack.slice(stack.indexOf(m)), m]; // the exact cycle, closed back to m
				return true;
			}
			if (!visited.has(m) && dfs(m)) return true;
		}
		onStack.delete(n);
		stack.pop();
		return false;
	};
	for (const n of nodes) {
		if (!visited.has(n) && dfs(n)) return found;
	}
	return null;
}

/**
 * Validate a goal's `depends_on` DAG at `/commit-goal` time. `depsById` maps each goal card id to
 * its declared deps; `filedIds` are already-Filed board cards (a legal cross-goal dep target). Runs
 * Kahn's algorithm for the acyclicity DECISION (all nodes reach in-degree 0 ⇔ acyclic) and, on a
 * cycle, hands off to `findCyclePath` to report the EXACT path. Returns the first failure (dangling
 * before cycle) as a precise message, or null when the DAG is valid. NEVER writes.
 */
export function validateGoalDag(
	goalIds: Set<string>,
	depsById: Map<string, string[]>,
	filedIds: Set<string>,
): string | null {
	// 1. Dangling: every dep id must be a goal card OR an already-Filed board card.
	const dangling: string[] = [];
	for (const [id, deps] of depsById) {
		for (const d of deps) {
			if (!goalIds.has(d) && !filedIds.has(d)) dangling.push(`${id} → ${d}`);
		}
	}
	if (dangling.length) return `dangling depends_on (target absent from the board / not Filed): ${dangling.join(", ")}`;

	// 2. Acyclic (Kahn). Only edges WITHIN the goal subgraph can form a cycle (a Filed dep is a
	//    satisfied leaf). Build adjacency card → deps + in-degrees over deps that are goal cards.
	const adj = new Map<string, string[]>();
	const indeg = new Map<string, number>();
	for (const n of goalIds) {
		adj.set(n, []);
		indeg.set(n, 0);
	}
	for (const [c, deps] of depsById) {
		for (const d of deps) {
			if (!goalIds.has(d)) continue;
			adj.get(c)!.push(d);
			indeg.set(d, (indeg.get(d) ?? 0) + 1);
		}
	}
	const queue: string[] = [];
	for (const n of goalIds) if ((indeg.get(n) ?? 0) === 0) queue.push(n);
	let removed = 0;
	while (queue.length) {
		const n = queue.shift()!;
		removed++;
		for (const m of adj.get(n) ?? []) {
			indeg.set(m, (indeg.get(m) ?? 0) - 1);
			if ((indeg.get(m) ?? 0) === 0) queue.push(m);
		}
	}
	if (removed !== goalIds.size) {
		const cycle = findCyclePath(goalIds, adj) ?? [...goalIds];
		return `dependency cycle: ${cycle.join(" → ")}`;
	}
	return null;
}
