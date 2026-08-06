// git-ops.ts - pure git-CLI wrappers for per-card worktree isolation (Slice 3/4).
//
// Every function calls child_process.execSync with a timeout and throws on
// non-zero exit. No card-engine imports - standalone, testable, mockable.
// Wired into the engine by workspace-manager.ts and index.ts in Slices 3/4.

import { execSync, type ExecSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";

// ── Internal helpers ─────────────────────────────────────────────────────────

const EXEC_DEFAULTS: ExecSyncOptions = {
	encoding: "utf8",
	stdio: "pipe",
	timeout: 30_000,
};

/**
 * Run `git <args>` and return raw stdout.
 * Throws on non-zero exit (CaptureError is surfaced as-is).
 * NOTE: trailing newline is preserved so diff output (which must end with \n)
 * remains valid for git apply. Callers that need trimming may do so.
 */
function execGit(args: string, cwd?: string): string {
	const opts: ExecSyncOptions = { ...EXEC_DEFAULTS };
	if (cwd !== undefined) opts.cwd = cwd;
	return execSync(`git ${args}`, opts).toString();
}

/**
 * Engine directories whose diffs require a /reload after apply.
 * Order: card-engine FIRST (the most critical), then the other owner-loaded
 * extensions. Matching is done via String.includes.
 *
 * These match REPO-RELATIVE diff paths (`+++ b/.pi/extensions/<name>/…`), which are
 * project-independent as long as the owner-loaded extensions live at `.pi/extensions/`
 * - so this default works for any ProjectConfig whose engineRoot is `<cwd>/.pi/extensions`.
 * A project with an exotic engineRoot can pass its own pattern array to
 * `gitCheckEngineTouched`. Exported so callers/config can reference the default.
 */
export const ENGINE_DIR_PATTERNS: readonly string[] = [
	".pi/extensions/card-engine/",
	"/auto-planner/",
	"/queue-drain/",
	"/worker-guard/",
] as const;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a git worktree at `path` from `ref` in the repository at `repoPath`.
 *
 * Runs: `git -C <repoPath> worktree add --force <path> <ref>`
 * `--force` is used so the worktree can be (re)created even if the ref is
 * already checked out in another worktree - matches the per-card isolation
 * model where multiple worktrees share the same base ref.
 *
 * @param repoPath  Absolute path to the main repository.
 * @param ref       Branch name, tag, or commit-ish (e.g. "HEAD", "main").
 * @param path      Absolute path for the new worktree directory.
 */
export function gitWorktreeAdd(repoPath: string, ref: string, path: string): string {
	execGit(`-C ${repoPath} worktree add --force ${path} ${ref}`);
	// Return the resolved base commit the worktree starts from. The harvest diffs
	// against THIS base (not the live worktree HEAD), so a worker that runs `git commit`
	// inside its worktree still produces a capturable diff. (Without this, a committed
	// worker leaves `diff --staged HEAD` empty → the merge-back applies nothing.)
	return execGit(`-C ${path} rev-parse HEAD`).trim();
}

/**
 * Remove a git worktree at `path` from the repository at `repoPath`.
 *
 * Runs: `git -C <repoPath> worktree remove --force <path>`
 * `--force` allows removal even with dirty state (cleanup scenario).
 *
 * @param repoPath  Absolute path to the main repository.
 * @param path      Absolute path to the worktree to remove.
 */
export function gitWorktreeRemove(repoPath: string, path: string): void {
	execGit(`-C ${repoPath} worktree remove --force ${path}`);
}

/**
 * Stage all changes in a worktree and produce a staged diff against HEAD.
 *
 * Runs:
 *   1. `git -C <worktreePath> add -A`         - stages everything
 *   2. `git -C <worktreePath> diff --staged HEAD` - produces the diff
 *
 * Returns the full diff text (empty string if the worktree is clean).
 *
 * @param worktreePath  Absolute path to the worktree.
 * @returns The staged diff (empty string = no changes).
 */
export function gitStageAndDiff(worktreePath: string, base = "HEAD"): string {
	execGit(`-C ${worktreePath} add -A`);
	// Diff the index against the worktree's CREATION BASE, not the live HEAD. A worker may
	// `git commit` inside its worktree (moving HEAD onto its own commit), which would make
	// `diff --staged HEAD` empty even though real work was done. `--staged <base>` captures
	// committed AND staged work in one diff. base defaults to "HEAD" (no-commit / test path).
	return execGit(`-C ${worktreePath} diff --staged ${base}`);
}

/**
 * Apply a staged diff to the main repository.
 *
 * Runs: `git -C <mainRepoPath> apply --index <diffPath>`
 * `--index` applies the changes to both the working tree and the index,
 * matching the format produced by `gitStageAndDiff` (which stages first).
 *
 * Throws on merge conflict or other apply failure. The caller should catch
 * and handle (e.g. set review_flag: merge-conflict on the card).
 *
 * @param mainRepoPath  Absolute path to the main repository (or any clone).
 * @param diffPath      Absolute path to a file containing `git diff --staged HEAD` output.
 */
export function gitApply(mainRepoPath: string, diffPath: string): void {
	execGit(`-C ${mainRepoPath} apply --index ${diffPath}`);
}

/**
 * Reset a worktree to a clean state matching HEAD.
 *
 * Runs:
 *   1. `git -C <worktreePath> reset HEAD -- .`  - unstage any staged changes
 *   2. `git -C <worktreePath> checkout -- .`     - discard working-tree changes
 *   3. `git -C <worktreePath> clean -fd`         - remove untracked files/dirs
 *
 * After reset, the worktree is identical to HEAD (clean index + clean tree).
 *
 * @param worktreePath  Absolute path to the worktree.
 */
export function gitWorktreeReset(worktreePath: string, base = "HEAD"): void {
	// Hard-reset to the creation base, then drop untracked. Resetting to <base> (not the
	// live HEAD) matters because a worker may have committed inside the worktree - HEAD
	// would be the worker's commit, so a HEAD-reset would NOT actually clean it. base
	// defaults to "HEAD" (no-commit / test path → identical to the old reset behavior).
	execGit(`-C ${worktreePath} reset --hard ${base}`);
	execGit(`-C ${worktreePath} clean -fd`);
}

/**
 * Prune stale git worktree metadata from the main repository.
 *
 * Runs: `git worktree prune` in the main repo.
 * Removes administrative data for worktrees whose directories no longer exist.
 * Safe to call even when no stale worktrees exist; it is a no-op in that case.
 *
 * @param mainRepoPath  Absolute path to the main repository.
 */
export function gitWorktreePrune(mainRepoPath: string): void {
	execGit(`worktree prune`, mainRepoPath);
}

/**
 * Check whether a diff file touches any owner-loaded extension directory.
 *
 * Returns `true` if the diff content references:
 *   - `.pi/extensions/card-engine/`
 *   - `/auto-planner/`
 *   - `/queue-drain/`
 *   - `/worker-guard/`
 *
 * This is used (in Slice 4) to flag engine-touching cards that require a
 * manual `/reload` after their diff is applied to main.
 *
 * Detection is a simple substring match on the entire diff content against
 * the ENGINE_DIR_PATTERNS list. This covers both `+++ b/...` and `--- a/...`
 * git-diff path lines as well as any rename/copy headers. False positives are
 * possible in theory (a diff body comment mentioning the same string) but
 * negligible in practice - the human verifies the flag at review time.
 *
 * @param diffPath  Absolute path to a `git diff --staged HEAD` output file.
 * @param patterns  Substrings that mark an engine dir. Defaults to ENGINE_DIR_PATTERNS
 *                  (the built-in `.pi/extensions/<name>/` set); a project with a
 *                  non-default engineRoot can pass patterns derived from it.
 * @returns `true` if at least one engine directory pattern is found.
 */
export function gitCheckEngineTouched(diffPath: string, patterns: readonly string[] = ENGINE_DIR_PATTERNS): boolean {
	const content = readFileSync(diffPath, "utf8");
	return patterns.some((p) => content.includes(p));
}