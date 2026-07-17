// classify.ts — the triage stage: a CHEAP model (or deterministic rules) reads a
// card and answers three questions before any expensive worker spawns:
//   delegation — can AI do this unattended, or does a human hold judgment?
//   complexity — deterministic/mapped work, or exploratory?
//   outcome    — what shape is the deliverable (code diff / filed artifact / answer)?
// plus the routing class the table keys on (chore / research / feature / plan /
// review). The decision is WRITTEN ONTO THE CARD (class / tier / model /
// classified_by) so the routing is inspectable provenance, not hidden state.
//
// Two implementations:
//   RuleClassifier  — deterministic keyword + card_type heuristics. Zero cost,
//                     zero network; the fallback and the test workhorse.
//   HeadlessModelClassifier — one `claude -p --model <cheap>` call returning
//                     strict JSON; ANY failure (spawn, timeout, parse, invalid
//                     enum) falls back to the rules. Classification must never
//                     block the board.

import { execFile } from "node:child_process";

export type CardClass = "chore" | "research" | "feature" | "plan" | "review";
const CLASSES: readonly CardClass[] = ["chore", "research", "feature", "plan", "review"];

export interface Classification {
	class: CardClass;
	delegation: "auto" | "human";
	complexity: "deterministic" | "exploratory";
	outcome: "code" | "artifact" | "answer";
	/** One line of why — lands in the log, keeps the decision auditable. */
	rationale: string;
	/** Who decided: "rules" or the classifier model id. */
	via: string;
}

export interface ClassifyInput {
	id: string;
	title: string;
	cardType: string;
	instruction: string;
}

export interface Classifier {
	classify(input: ClassifyInput): Promise<Classification>;
}

// ── deterministic rules (fallback + tests) ────────────────────────────────────

const CHORE_HINTS = /\b(rename|bump|typo|format|lint|update dep|append|delete|move file|copy|regenerate|fix comment|changelog)\b/i;
const REVIEW_HINTS = /\b(review|audit|critique|assess|verify|check the diff)\b/i;
const PLAN_HINTS = /\b(plan|design|architect|spec|strategy|roadmap|decide|proposal)\b/i;
const RESEARCH_HINTS = /\b(research|investigate|survey|summari[sz]e|compare|explore|read up|find out)\b/i;

export class RuleClassifier implements Classifier {
	async classify(input: ClassifyInput): Promise<Classification> {
		const text = `${input.title}\n${input.instruction}`;
		let cls: CardClass;
		let rationale: string;
		if (REVIEW_HINTS.test(text)) {
			cls = "review";
			rationale = "review/audit language";
		} else if (PLAN_HINTS.test(text) || input.cardType === "strategy") {
			cls = "plan";
			rationale = input.cardType === "strategy" ? "strategy card_type" : "planning/design language";
		} else if (RESEARCH_HINTS.test(text) || input.cardType === "research") {
			cls = "research";
			rationale = input.cardType === "research" ? "research card_type" : "research language";
		} else if (CHORE_HINTS.test(text) || input.cardType === "maintenance") {
			cls = "chore";
			rationale = input.cardType === "maintenance" ? "maintenance card_type" : "mechanical-change language";
		} else {
			cls = "feature";
			rationale = "no chore/plan/review/research signals — substantive change assumed";
		}
		const isCode = input.cardType === "ops" || input.cardType === "maintenance";
		return {
			class: cls,
			delegation: cls === "plan" || cls === "review" ? "human" : "auto",
			complexity: cls === "chore" ? "deterministic" : "exploratory",
			outcome: cls === "research" || cls === "plan" ? "artifact" : isCode ? "code" : "artifact",
			rationale,
			via: "rules",
		};
	}
}

// ── headless cheap-model classifier ───────────────────────────────────────────

const CLASSIFY_PROMPT = (input: ClassifyInput) =>
	`You are a task triage classifier. Read the task below and respond with ONLY a JSON object, no prose, no code fence:\n` +
	`{"class":"chore|research|feature|plan|review","delegation":"auto|human","complexity":"deterministic|exploratory","outcome":"code|artifact|answer","rationale":"<one short line>"}\n\n` +
	`Definitions: chore = small mechanical change with a known recipe; research = gather/summarize information; ` +
	`feature = substantive new code/content; plan = design or strategy work needing judgment; review = assessing existing work.\n\n` +
	`TASK ${input.id} (card_type: ${input.cardType || "unknown"})\nTitle: ${input.title}\n\n${input.instruction.slice(0, 4000)}`;

export interface HeadlessClassifierOpts {
	/** The cheap model to classify on (routing table's classifier.model). */
	model: string;
	claudeBin?: string;
	timeoutMs?: number;
}

export class HeadlessModelClassifier implements Classifier {
	private readonly model: string;
	private readonly claudeBin: string;
	private readonly timeoutMs: number;
	private readonly fallback = new RuleClassifier();

	constructor(opts: HeadlessClassifierOpts) {
		this.model = opts.model;
		this.claudeBin = opts.claudeBin ?? "claude";
		this.timeoutMs = opts.timeoutMs ?? 60_000;
	}

	async classify(input: ClassifyInput): Promise<Classification> {
		try {
			const raw = await this.run(CLASSIFY_PROMPT(input));
			const parsed = extractJson(raw);
			if (
				parsed &&
				(CLASSES as readonly string[]).includes(parsed.class) &&
				(parsed.delegation === "auto" || parsed.delegation === "human") &&
				(parsed.complexity === "deterministic" || parsed.complexity === "exploratory") &&
				(parsed.outcome === "code" || parsed.outcome === "artifact" || parsed.outcome === "answer")
			) {
				return {
					class: parsed.class,
					delegation: parsed.delegation,
					complexity: parsed.complexity,
					outcome: parsed.outcome,
					rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 200) : "",
					via: this.model,
				};
			}
		} catch {
			/* fall through to rules */
		}
		const ruled = await this.fallback.classify(input);
		return { ...ruled, rationale: `${ruled.rationale} (model classifier unavailable — rules fallback)` };
	}

	/** One headless print-mode call on the cheap model, no tools, JSON out. */
	private run(prompt: string): Promise<string> {
		// Strip nested-session markers (same discipline as the harness adapter).
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v === undefined || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
			env[k] = v;
		}
		return new Promise((resolve, reject) => {
			execFile(
				this.claudeBin,
				// `--` ends flag parsing: --disallowed-tools is variadic and would
				// otherwise swallow the prompt positional (probed live).
				["-p", "--model", this.model, "--output-format", "json", "--disallowed-tools", "*", "--", prompt],
				{ encoding: "utf8", timeout: this.timeoutMs, env, maxBuffer: 4 * 1024 * 1024 },
				(err, stdout) => {
					if (err) return reject(err);
					try {
						const outer = JSON.parse(stdout);
						resolve(typeof outer?.result === "string" ? outer.result : stdout);
					} catch {
						resolve(stdout);
					}
				},
			);
		});
	}
}

/** Pull the first JSON object out of a model reply (tolerates fences/prose). */
function extractJson(text: string): any | null {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		return JSON.parse(m[0]);
	} catch {
		return null;
	}
}
