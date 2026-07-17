// git-ops.test.ts — thorough unit tests for git-ops.ts against throwaway temp
// git repos. Run via `bun run git-ops.test.ts`.
//
// Every test creates its own bare.git + clone, exercises one or two functions,
// and reports pass/fail. The temp dirs are NOT cleaned up on failure (for
// post-mortem inspection); on all-pass they are pruned at the end.

import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { execSync, type ExecSyncOptions } from "node:child_process";

import {
	gitWorktreeAdd,
	gitWorktreeRemove,
	gitStageAndDiff,
	gitApply,
	gitWorktreeReset,
	gitWorktreePrune,
	gitCheckEngineTouched,
} from "../src/engine/git-ops.ts";

// ── Test harness ─────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
	if (cond) {
		pass++;
		console.log(`  ✅ ${msg}`);
	} else {
		fail++;
		console.log(`  ❌ ${msg}`);
	}
}

function failHard(msg: string): never {
	fail++;
	console.log(`  💥 ${msg}`);
	process.exit(1);
}

const GIT: ExecSyncOptions = { encoding: "utf8", stdio: "pipe", timeout: 15_000 };

/** Create a throwaway bare repo + clone pair. Returns {bare, clone}. */
function createRepoPair(): { bare: string; clone: string } {
	const tmp = fs.mkdtempSync(join(os.tmpdir(), "git-ops-test-"));
	const bare = join(tmp, "bare.git");
	const clone = join(tmp, "clone");
	execSync(`git init --bare --initial-branch=main ${bare}`, GIT);
	execSync(`git clone ${bare} ${clone}`, GIT);
	execSync(`git -C ${clone} config user.email "test@git-ops.holdco"`, GIT);
	execSync(`git -C ${clone} config user.name "GitOps Test"`, GIT);
	fs.writeFileSync(join(clone, "README.md"), "# Git-Ops Test Repo\n");
	execSync(`git -C ${clone} add -A`, GIT);
	execSync(`git -C ${clone} commit -m "Initial commit"`, GIT);
	execSync(`git -C ${clone} push origin main`, GIT);
	return { bare, clone };
}

/** Run a function with temp-dir cleanup on success, leak on failure for debugging. */
function withRepo(label: string, fn: (clone: string) => void): void {
	const { bare, clone } = createRepoPair();
	try {
		fn(clone);
	} catch (e) {
		fail++;
		console.log(`  ❌ ${label} — exception: ${e}`);
		return;
	}
	try {
		fs.rmSync(bare, { recursive: true, force: true });
		fs.rmSync(join(clone, ".."), { recursive: true, force: true });
	} catch { /* best-effort */ }
}

function read(path: string): string {
	return fs.readFileSync(path, "utf8");
}

function write(path: string, content: string): void {
	fs.mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
	fs.writeFileSync(path, content, "utf8");
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log("\n── gitWorktreeAdd ──");

withRepo("add worktree at detached HEAD", (clone) => {
	const wt = join(clone, "..", "wt-add");
	gitWorktreeAdd(clone, "HEAD", wt);
	ok(fs.existsSync(wt), "worktree directory exists");
	ok(fs.existsSync(join(wt, "README.md")), "worktree has the initial file");
	const list = execSync(`git -C ${clone} worktree list`, GIT).toString();
	ok(list.includes(wt), "worktree listed by git worktree list");
});

withRepo("add worktree from branch name", (clone) => {
	const wt = join(clone, "..", "wt-branch");
	gitWorktreeAdd(clone, "main", wt);
	ok(fs.existsSync(wt), "branch-based worktree exists");
	const head = execSync(`git -C ${wt} rev-parse HEAD`, GIT).toString().trim();
	const mainHead = execSync(`git -C ${clone} rev-parse main`, GIT).toString().trim();
	ok(head === mainHead, "worktree HEAD matches branch HEAD");
});

console.log("\n── gitStageAndDiff ──");

withRepo("new file capture", (clone) => {
	const wt = join(clone, "..", "wt-newfile");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "new-file.md"), "# New Artifact\n");
	const diff = gitStageAndDiff(wt);
	ok(diff.length > 0, "diff is non-empty for a new file");
	ok(diff.includes("new-file.md"), "diff references the new file path");
	ok(diff.includes("+# New Artifact"), "diff contains the new file content");
});

withRepo("modified existing file", (clone) => {
	const wt = join(clone, "..", "wt-modify");
	gitWorktreeAdd(clone, "HEAD", wt);
	fs.writeFileSync(join(wt, "README.md"), "# Modified\n", "utf8");
	const diff = gitStageAndDiff(wt);
	ok(diff.length > 0, "diff is non-empty for a modified file");
	ok(diff.includes("README.md"), "diff references README.md");
	ok(diff.includes("+# Modified"), "diff contains the new content");
});

withRepo("deleted file", (clone) => {
	const wt = join(clone, "..", "wt-delete");
	gitWorktreeAdd(clone, "HEAD", wt);
	fs.unlinkSync(join(wt, "README.md"));
	const diff = gitStageAndDiff(wt);
	ok(diff.length > 0, "diff is non-empty for a deletion");
	ok(diff.includes("README.md"), "diff references the deleted file");
	ok(diff.includes("-# Git-Ops Test Repo"), "diff shows deleted content");
});

withRepo("empty diff when worktree is clean", (clone) => {
	const wt = join(clone, "..", "wt-clean");
	gitWorktreeAdd(clone, "HEAD", wt);
	const diff = gitStageAndDiff(wt);
	ok(diff === "", `diff is empty string (got ${diff.length} chars)`);
});

withRepo("multiple changes combined (new + modify + delete)", (clone) => {
	const wt = join(clone, "..", "wt-multi");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "sub/a.md"), "A\n");
	write(join(wt, "sub/b.md"), "B\n");
	fs.writeFileSync(join(wt, "README.md"), "## Modified\n", "utf8");
	const diff = gitStageAndDiff(wt);
	ok(diff.length > 0, "diff is non-empty for mixed operations");
	const lines = diff.split("\n").filter((l) => l.startsWith("diff --git"));
	ok(lines.length === 3, `diff contains exactly 3 file sections (got ${lines.length})`);
});

console.log("\n── gitApply ──");

withRepo("apply new-file diff to main", (clone) => {
	const wt = join(clone, "..", "wt-apply-new");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "result.txt"), "applied content\n");
	const diff = gitStageAndDiff(wt);
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	gitApply(clone, diffFile);
	ok(fs.existsSync(join(clone, "result.txt")), "result.txt exists in main repo after apply");
	ok(read(join(clone, "result.txt")) === "applied content\n", "content matches");
});

withRepo("apply modified-file diff to main", (clone) => {
	const wt = join(clone, "..", "wt-apply-mod");
	gitWorktreeAdd(clone, "HEAD", wt);
	fs.writeFileSync(join(wt, "README.md"), "# Modified\n", "utf8");
	const diff = gitStageAndDiff(wt);
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	gitApply(clone, diffFile);
	ok(read(join(clone, "README.md")) === "# Modified\n", "README.md updated in main");
});

withRepo("apply deletion diff to main", (clone) => {
	const wt = join(clone, "..", "wt-apply-del");
	gitWorktreeAdd(clone, "HEAD", wt);
	fs.unlinkSync(join(wt, "README.md"));
	const diff = gitStageAndDiff(wt);
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	gitApply(clone, diffFile);
	ok(!fs.existsSync(join(clone, "README.md")), "README.md deleted from main after apply");
});

withRepo("apply to second clone verifies uncommitted transport", (clone) => {
	const second = join(clone, "..", "second-clone");
	execSync(`git clone ${join(clone, "..", "bare.git")} ${second}`, GIT);
	execSync(`git -C ${second} config user.email "test2@git-ops.holdco"`, GIT);
	execSync(`git -C ${second} config user.name "GitOps Test 2"`, GIT);
	const wt = join(clone, "..", "wt-second");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "staged-only.md"), "Not committed\n");
	const diff = gitStageAndDiff(wt);
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	gitApply(clone, diffFile);
	ok(fs.existsSync(join(clone, "staged-only.md")), "staged-only.md visible in primary");
	ok(!fs.existsSync(join(second, "staged-only.md")), "staged-only.md NOT visible in second clone (applied, not committed)");
});

console.log("\n── gitWorktreeReset ──");

withRepo("reset discards new files, modifications, and deletions", (clone) => {
	const wt = join(clone, "..", "wt-reset");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "junk.txt"), "should be removed\n");
	fs.writeFileSync(join(wt, "README.md"), "## Tampered\n", "utf8");
	gitWorktreeReset(wt);
	const status = execSync(`git -C ${wt} status --porcelain`, GIT).toString().trim();
	ok(status === "", `worktree is clean after reset (got ${JSON.stringify(status)})`);
	ok(fs.existsSync(join(wt, "README.md")), "README.md still exists");
	ok(read(join(wt, "README.md")).includes("Git-Ops Test Repo"), "README.md content restored");
	ok(!fs.existsSync(join(wt, "junk.txt")), "junk.txt removed by reset");
});

withRepo("reset after stage still discards changes", (clone) => {
	const wt = join(clone, "..", "wt-reset-staged");
	gitWorktreeAdd(clone, "HEAD", wt);
	fs.writeFileSync(join(wt, "README.md"), "# Staged modification\n", "utf8");
	execSync(`git -C ${wt} add -A`, GIT);
	gitWorktreeReset(wt);
	const status = execSync(`git -C ${wt} status --porcelain`, GIT).toString().trim();
	ok(status === "", "staged changes also discarded by reset");
});

console.log("\n── gitWorktreeRemove ──");

withRepo("remove existing worktree", (clone) => {
	const wt = join(clone, "..", "wt-remove");
	gitWorktreeAdd(clone, "HEAD", wt);
	gitWorktreeRemove(clone, wt);
	ok(!fs.existsSync(wt), "worktree directory removed");
});

withRepo("force-remove dirty worktree", (clone) => {
	const wt = join(clone, "..", "wt-remove-dirty");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "dirty-file.txt"), "uncommitted\n");
	gitWorktreeRemove(clone, wt);
	ok(!fs.existsSync(wt), "dirty worktree directory removed with --force");
});

console.log("\n── gitWorktreePrune ──");

withRepo("prune stale worktree metadata", (clone) => {
	const wt = join(clone, "..", "wt-prune");
	gitWorktreeAdd(clone, "HEAD", wt);
	fs.rmSync(wt, { recursive: true, force: true });
	gitWorktreePrune(clone);
	const list = execSync(`git -C ${clone} worktree list`, GIT).toString();
	ok(!list.includes(wt), "pruned worktree no longer listed");
});

withRepo("prune is a no-op when nothing is stale", (clone) => {
	try {
		gitWorktreePrune(clone);
		ok(true, "prune on clean repo does not throw");
	} catch (e) {
		ok(false, `prune on clean repo threw: ${e}`);
	}
});

console.log("\n── gitCheckEngineTouched ──");

function withDiffFile(content: string, fn: (path: string) => void): void {
	const tmp = fs.mkdtempSync(join(os.tmpdir(), "git-ops-check-"));
	const path = join(tmp, "card.diff");
	fs.writeFileSync(path, content, "utf8");
	try {
		fn(path);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

// True positives

withDiffFile(`diff --git a/.pi/extensions/card-engine/index.ts b/.pi/extensions/card-engine/index.ts
--- a/.pi/extensions/card-engine/index.ts
+++ b/.pi/extensions/card-engine/index.ts
@@ -1 +1 @@
-old
+new
`, (p) => {
	ok(gitCheckEngineTouched(p), "card-engine path detected (direct include)");
});

withDiffFile(`diff --git a/.pi/extensions/auto-planner/index.ts b/.pi/extensions/auto-planner/index.ts
--- a/.pi/extensions/auto-planner/index.ts
+++ b/.pi/extensions/auto-planner/index.ts
@@ -1 +1 @@
-planned
+replanned
`, (p) => {
	ok(gitCheckEngineTouched(p), "auto-planner path detected");
});

withDiffFile(`diff --git a/.pi/extensions/queue-drain/drain.ts b/.pi/extensions/queue-drain/drain.ts
--- a/.pi/extensions/queue-drain/drain.ts
+++ b/.pi/extensions/queue-drain/drain.ts
@@ -1 +1 @@
-old
+new
`, (p) => {
	ok(gitCheckEngineTouched(p), "queue-drain path detected");
});

withDiffFile(`diff --git a/.pi/extensions/worker-guard/index.ts b/.pi/extensions/worker-guard/index.ts
--- a/.pi/extensions/worker-guard/index.ts
+++ b/.pi/extensions/worker-guard/index.ts
@@ -1 +1 @@
-guard
+reguard
`, (p) => {
	ok(gitCheckEngineTouched(p), "worker-guard path detected");
});

withDiffFile(`diff --git a/.pi/extensions/card-engine/worker-pool.ts b/.pi/extensions/card-engine/worker-pool.ts
diff --git a/.pi/extensions/auto-planner/rpc.ts b/.pi/extensions/auto-planner/rpc.ts
diff --git a/.pi/extensions/queue-drain/index.ts b/.pi/extensions/queue-drain/index.ts
diff --git a/.pi/extensions/worker-guard/blocklist.ts b/.pi/extensions/worker-guard/blocklist.ts
`, (p) => {
	ok(gitCheckEngineTouched(p), "multiple engine paths all detected");
});

// True negatives

withDiffFile(`diff --git a/domains/dds/refs/new-analysis.md b/domains/dds/refs/new-analysis.md
--- /dev/null
+++ b/domains/dds/refs/new-analysis.md
@@ -0,0 +1 @@
+new artifact
`, (p) => {
	ok(!gitCheckEngineTouched(p), "non-engine path (domain artifact) returns false");
});

withDiffFile(`diff --git a/.gitignore b/.gitignore
--- a/.gitignore
+++ b/.gitignore
@@ -1 +1 @@
-old
+new
`, (p) => {
	ok(!gitCheckEngineTouched(p), ".gitignore (non-engine) returns false");
});

withDiffFile(`diff --git a/.pi/extensions/card-preview/render.ts b/.pi/extensions/card-preview/render.ts
--- a/.pi/extensions/card-preview/render.ts
+++ b/.pi/extensions/card-preview/render.ts
@@ -1 +1 @@
-old
+new
`, (p) => {
	ok(!gitCheckEngineTouched(p), "card-preview (NOT an owner-loaded extension) returns false");
});

withDiffFile(`diff --git a/.pi/extensions/_shared/helpers.ts b/.pi/extensions/_shared/helpers.ts
--- a/.pi/extensions/_shared/helpers.ts
+++ b/.pi/extensions/_shared/helpers.ts
@@ -1 +1 @@
-old
+new
`, (p) => {
	ok(!gitCheckEngineTouched(p), "_shared helpers (non-engine) returns false");
});

// Edge cases

withDiffFile("", (p) => {
	ok(!gitCheckEngineTouched(p), "empty diff returns false");
});

withDiffFile(`diff --git a/domains/pps/refs/notes.md b/domains/pps/refs/notes.md
index abc..def 100644
--- a/domains/pps/refs/notes.md
+++ b/domains/pps/refs/notes.md
@@ -1 +1 @@
-see .pi/extensions/card-engine/ for context
+see /auto-planner/ for routing
`, (p) => {
	ok(gitCheckEngineTouched(p), "documented false-positive: body text matching an engine path returns true");
});

console.log("\n── Merge conflict ──");

withRepo("apply throws on merge conflict", (clone) => {
	const wt = join(clone, "..", "wt-conflict");
	fs.writeFileSync(join(clone, "shared.txt"), "line1\nline2\nline3\n");
	execSync(`git -C ${clone} add shared.txt`, GIT);
	execSync(`git -C ${clone} commit -m "add shared.txt"`, GIT);
	execSync(`git -C ${clone} push origin main`, GIT);
	gitWorktreeAdd(clone, "HEAD", wt);
	fs.writeFileSync(join(clone, "shared.txt"), "line1\nmodified in main\nline3\n");
	execSync(`git -C ${clone} add shared.txt`, GIT);
	execSync(`git -C ${clone} commit -m "modify shared in main"`, GIT);
	fs.writeFileSync(join(wt, "shared.txt"), "line1\nmodified in worktree\nline3\n");
	const diff = gitStageAndDiff(wt);
	ok(diff.length > 0, "conflict diff is non-empty");
	const diffFile = join(clone, "..", "conflict.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	let threw = false;
	try {
		gitApply(clone, diffFile);
	} catch (e) {
		threw = true;
		const msg = String(e);
		ok(msg.includes("patch failed") || msg.includes("error:"), `apply error mentions conflict (got: ${msg.slice(0, 120)})`);
	}
	ok(threw, "gitApply throws on merge conflict");
});

console.log("\n── Slice 4: full lifecycle (worktree → diff → apply → main) ──");

withRepo("artifact card: new file created in worktree, diff produced, applied to main", (clone) => {
	const wt = join(clone, "..", "wt-s4-artifact");
	gitWorktreeAdd(clone, "HEAD", wt);
	// Simulate an artifact card creating a new vault file
	const artifactPath = "domains/dds/refs/new-analysis.md";
	const fullPath = join(wt, artifactPath);
	write(fullPath, "---\ntitle: New Analysis\ntype: knowledge\n---\n\n# Analysis\n\nFindings here.\n");
	const diff = gitStageAndDiff(wt);
	ok(diff.length > 0, "artifact diff is non-empty");
	ok(diff.includes(artifactPath), "diff references the artifact file path");
	ok(diff.includes("+Findings here."), "diff contains the artifact content");
	// Apply to main — this is what happens on human File
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	gitApply(clone, diffFile);
	ok(fs.existsSync(join(clone, artifactPath)), "artifact file exists in main after apply");
	ok(read(join(clone, artifactPath)).includes("New Analysis"), "artifact file content matches");
});

withRepo("code card: multiple file edits, diff produced, applied to main", (clone) => {
	// Create the baseline files in main first, so the worktree diff has a common ancestor.
	write(join(clone, ".pi/extensions/example/foo.ts"), "export const x = 1;\n");
	write(join(clone, ".pi/extensions/example/bar.ts"), "export const y = 2;\n");
	execSync(`git -C ${clone} add -A`, GIT);
	execSync(`git -C ${clone} commit -m "add example ext"`, GIT);
	// Now create the worktree from this updated HEAD.
	const wt = join(clone, "..", "wt-s4-code");
	gitWorktreeAdd(clone, "HEAD", wt);
	// Simulate a code card editing both files
	fs.writeFileSync(join(wt, ".pi/extensions/example/foo.ts"), "export const x = 42; // changed\n");
	fs.writeFileSync(join(wt, ".pi/extensions/example/bar.ts"), "export const y = 99; // changed\n");
	const diff = gitStageAndDiff(wt);
	ok(diff.length > 0, "code card diff is non-empty");
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	gitApply(clone, diffFile);
	ok(read(join(clone, ".pi/extensions/example/foo.ts")).includes("x = 42"), "foo.ts updated in main");
	ok(read(join(clone, ".pi/extensions/example/bar.ts")).includes("y = 99"), "bar.ts updated in main");
});

console.log("\n── Slice 4: double-apply idempotency (git-level behavior) ──");

withRepo("second apply of same diff fails (demonstrates need for one-shot guard)", (clone) => {
	const wt = join(clone, "..", "wt-s4-double");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "once.txt"), "applied once\n");
	const diff = gitStageAndDiff(wt);
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	// First apply succeeds
	gitApply(clone, diffFile);
	ok(fs.existsSync(join(clone, "once.txt")), "first apply succeeded");
	// Second apply of the same diff should fail (patch already applied)
	let threw = false;
	try {
		gitApply(clone, diffFile);
	} catch (e) {
		threw = true;
	}
	ok(threw, "second apply of the same diff THROWS (patch already applied — one-shot guard is load-bearing)");
});

console.log("\n── Slice 4: reload-required scenario (engine-touched detection) ──");

withRepo("diff touching card-engine detected as engine-touched", (clone) => {
	const wt = join(clone, "..", "wt-s4-engine");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, ".pi/extensions/card-engine/worker-pool.ts"), "// modified engine code\n");
	const diff = gitStageAndDiff(wt);
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	ok(gitCheckEngineTouched(diffFile), "engine-touched: card-engine diff flagged");
});

withRepo("diff touching non-engine path NOT flagged", (clone) => {
	const wt = join(clone, "..", "wt-s4-noengine");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "domains/hyperactive-ceo/refs/strategy.md"), "# Strategy\n\nUpdates.\n");
	const diff = gitStageAndDiff(wt);
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diff, "utf8");
	ok(!gitCheckEngineTouched(diffFile), "non-engine diff NOT flagged as engine-touched");
});

console.log("\n── Slice 4: worktree reset for re-plan path ──");

withRepo("reset worktree after making changes, verify clean state", (clone) => {
	const wt = join(clone, "..", "wt-s4-rereset");
	gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "should-go-away.txt"), "temporary\n");
	fs.writeFileSync(join(wt, "README.md"), "# Tampered for re-plan\n");
	gitWorktreeReset(wt);
	const status = execSync(`git -C ${wt} status --porcelain`, GIT).toString().trim();
	ok(status === "", "worktree clean after re-plan reset");
	ok(!fs.existsSync(join(wt, "should-go-away.txt")), "untracked temp file removed");
	ok(read(join(wt, "README.md")).includes("Git-Ops Test Repo"), "original content restored");
});

console.log("\n── Harvest captures a worker's COMMIT (diff-vs-base — the merge-back fix) ──");

function asWorker(wt: string): void {
	execSync(`git -C ${wt} config user.email "worker@holdco"`, GIT);
	execSync(`git -C ${wt} config user.name "Worker"`, GIT);
}

withRepo("gitWorktreeAdd returns the creation-base SHA", (clone) => {
	const wt = join(clone, "..", "wt-base-return");
	const base = gitWorktreeAdd(clone, "HEAD", wt);
	const head = execSync(`git -C ${wt} rev-parse HEAD`, GIT).toString().trim();
	ok(/^[0-9a-f]{40}$/.test(base), `gitWorktreeAdd returns a 40-char SHA (got ${base.slice(0, 12)})`);
	ok(base === head, "returned base equals the worktree's initial HEAD");
});

withRepo("worker COMMITS in the worktree → diff-vs-base captures it, diff-vs-HEAD is EMPTY", (clone) => {
	const wt = join(clone, "..", "wt-committed");
	const base = gitWorktreeAdd(clone, "HEAD", wt);
	// A worker writes a file AND commits it inside the worktree (allowed; some plans
	// even request it). This moves the worktree HEAD onto the worker's own commit.
	write(join(wt, "vault/sources/note.md"), "# committed by worker\n");
	asWorker(wt);
	execSync(`git -C ${wt} add -A`, GIT);
	execSync(`git -C ${wt} commit -m "worker commit"`, GIT);
	// THE BUG (regression guard): diffing against the live HEAD sees nothing.
	const diffHead = gitStageAndDiff(wt, "HEAD");
	ok(diffHead.trim() === "", "diff-vs-HEAD is EMPTY for a committed worker (the old merge-back bug)");
	// THE FIX: diffing against the creation base captures the committed work.
	const diffBase = gitStageAndDiff(wt, base);
	ok(diffBase.length > 0, "diff-vs-base is NON-empty (captures the worker's commit)");
	ok(diffBase.includes("vault/sources/note.md"), "diff-vs-base references the committed file");
	ok(diffBase.includes("+# committed by worker"), "diff-vs-base contains the committed content");
	// And it applies cleanly to main (the merge-back).
	const diffFile = join(clone, "..", "card.diff");
	fs.writeFileSync(diffFile, diffBase, "utf8");
	gitApply(clone, diffFile);
	ok(fs.existsSync(join(clone, "vault/sources/note.md")), "committed artifact lands on main via the base-diff");
});

withRepo("diff-vs-base captures committed AND uncommitted work together", (clone) => {
	const wt = join(clone, "..", "wt-mixed");
	const base = gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "committed.md"), "C\n");
	asWorker(wt);
	execSync(`git -C ${wt} add -A`, GIT);
	execSync(`git -C ${wt} commit -m "first"`, GIT);
	write(join(wt, "uncommitted.md"), "U\n"); // left in the working tree
	const diff = gitStageAndDiff(wt, base);
	ok(diff.includes("committed.md") && diff.includes("uncommitted.md"), "diff-vs-base captures BOTH the commit and the uncommitted file");
});

withRepo("gitWorktreeReset(base) discards a worker's commit", (clone) => {
	const wt = join(clone, "..", "wt-reset-base");
	const base = gitWorktreeAdd(clone, "HEAD", wt);
	write(join(wt, "x.md"), "x\n");
	asWorker(wt);
	execSync(`git -C ${wt} add -A`, GIT);
	execSync(`git -C ${wt} commit -m "worker commit"`, GIT);
	gitWorktreeReset(wt, base);
	const head = execSync(`git -C ${wt} rev-parse HEAD`, GIT).toString().trim();
	ok(head === base, "reset(base) moved HEAD back to the creation base (commit discarded)");
	ok(!fs.existsSync(join(wt, "x.md")), "the committed file is gone after reset-to-base");
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n── Results ────────────────────────────────────────────────`);
console.log(`  Pass: ${pass}`);
console.log(`  Fail: ${fail}`);

if (fail > 0) {
	console.log("  ❌ SOME TESTS FAILED");
	process.exit(1);
} else {
	console.log("  ✅ ALL TESTS PASSED");
}