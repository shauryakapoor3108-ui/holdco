// workspace-paths.ts - the ONE place the per-card scoped-dir / worktree layout lives.
//
// Every scoped-dir template collapses to these two functions, parameterised by
// `scopedBase`. The default base is a holdco dir under the OS tmpdir - per-card
// working state is ephemeral by design (the durable record is the card + the
// harvested diff, never the scratch workspace).

import { tmpdir } from "node:os";
import { join } from "node:path";

/** Default base dir for per-card scoped dirs + worktrees. Override via deps/config. */
export const DEFAULT_SCOPED_BASE = join(tmpdir(), "holdco");

/** The per-card scoped dir: `<scopedBase>/<cardId>` (holds task.md / card.diff / worktree/). */
export function scopedDirFor(cfg: { scopedBase: string }, cardId: string): string {
	return join(cfg.scopedBase, cardId);
}

/** The per-card git worktree: `<scopedBase>/<cardId>/worktree` (the worker's cwd + write scope). */
export function worktreeDirFor(cfg: { scopedBase: string }, cardId: string): string {
	return join(cfg.scopedBase, cardId, "worktree");
}
