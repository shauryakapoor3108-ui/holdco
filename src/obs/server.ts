// server.ts — the observability server: Node port of the source system's Bun
// server (Bun.serve + bun:sqlite → node:http + node:sqlite).
//
// Same architecture, reshaped for the StageEvent contract:
//   • auth wall — Bearer token or ?token= on EVERY route except /health.
//   • ingest → persist → SSE broadcast: POST /stage-events validates each event
//     against schema/stage-event.schema.json (the strict wire contract), inserts
//     dedupe-aware, and pushes each NEW event to matching SSE subscribers.
//   • rollups — GET /runs replaces the legacy per-session rollup with per-run
//     aggregates (cost/token sums, first/last ts, last status).
// The source's public/ UI is deliberately NOT ported — the deck consumes
// /stage-events + /stage-events/stream directly.
//
// Run directly (`node src/obs/server.ts`) for a standalone boot, or via
// `holdco obs` (see cli.ts).

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../schema/validate.ts";
import type { StageEvent } from "../telemetry/stage-events.ts";
import { createObsDb } from "./db.ts";

export const MAX_REQUEST_BYTES = 1024 * 1024; // 1 MB body cap
const VERSION = "0.1.0";
const SCHEMA_PATH = fileURLToPath(new URL("../../schema/stage-event.schema.json", import.meta.url));

const CORS: Record<string, string> = { "access-control-allow-origin": "*" };

export interface ObsServerOpts {
	/** 0 (default) → ephemeral port; read the real one off the handle. */
	port?: number;
	host?: string;
	/** SQLite file path; default ":memory:" (tests / throwaway boots). */
	dbPath?: string;
	/** Auth token; default a random UUID per boot (like the source server). */
	token?: string;
	/** Suppress the boot banner. */
	quiet?: boolean;
}

export interface ObsServerHandle {
	port: number;
	url: string;
	token: string;
	close(): Promise<void>;
}

interface Subscriber {
	id: number;
	res: http.ServerResponse;
	runId?: string;
	cardId?: string;
}

export async function startObsServer(opts: ObsServerOpts = {}): Promise<ObsServerHandle> {
	const host = opts.host ?? "127.0.0.1";
	const token = opts.token ?? randomUUID();
	const dbPath = opts.dbPath ?? ":memory:";
	if (dbPath !== ":memory:") fs.mkdirSync(dirname(resolve(dbPath)), { recursive: true });
	const db = createObsDb(dbPath);
	const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
	const startTime = Date.now();

	// ── SSE subscriber registry ─────────────────────────────────────────────
	let nextSubId = 1;
	const subscribers = new Map<number, Subscriber>();

	function push(sub: Subscriber, data: string): void {
		try {
			sub.res.write(data);
		} catch {
			subscribers.delete(sub.id);
		}
	}

	function broadcast(ev: StageEvent): void {
		const frame = `event: stage\ndata: ${JSON.stringify(ev)}\n\n`;
		for (const sub of [...subscribers.values()]) {
			if (sub.runId && sub.runId !== ev.run_id) continue;
			if (sub.cardId && sub.cardId !== ev.card_id) continue;
			push(sub, frame);
		}
	}

	// Heartbeat every 15s (cleared on close; unref'd so it never pins the process).
	const heartbeat = setInterval(() => {
		for (const sub of [...subscribers.values()]) push(sub, ": ping\n\n");
	}, 15_000);
	heartbeat.unref?.();

	// ── helpers ─────────────────────────────────────────────────────────────
	function json(res: http.ServerResponse, body: unknown, status = 200): void {
		res.writeHead(status, { "content-type": "application/json", ...CORS });
		res.end(JSON.stringify(body));
	}

	function checkAuth(req: http.IncomingMessage, url: URL): boolean {
		// Authorization header wins when present (same wall as the source server).
		const auth = req.headers.authorization;
		if (auth) {
			const parts = auth.split(" ");
			return parts.length === 2 && parts[0].toLowerCase() === "bearer" && parts[1] === token;
		}
		return url.searchParams.get("token") === token;
	}

	function readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolveBody, rejectBody) => {
			const declared = parseInt(String(req.headers["content-length"] ?? "0"), 10);
			if (declared > MAX_REQUEST_BYTES) {
				rejectBody(new Error("payload too large"));
				req.destroy();
				return;
			}
			const chunks: Buffer[] = [];
			let total = 0;
			req.on("data", (chunk: Buffer) => {
				total += chunk.length;
				if (total > MAX_REQUEST_BYTES) {
					rejectBody(new Error("payload too large"));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
			req.on("error", (err) => rejectBody(err));
		});
	}

	// ── request handler (hand-rolled routing, like the source) ──────────────
	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const pathname = url.pathname;
		const method = (req.method ?? "GET").toUpperCase();

		// OPTIONS — CORS preflight
		if (method === "OPTIONS") {
			res.writeHead(204, {
				...CORS,
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-allow-headers": "Authorization, Content-Type",
			});
			res.end();
			return;
		}

		// ── unauthenticated: /health ──────────────────────────────────────
		if (pathname === "/health") {
			if (method !== "GET") return json(res, { error: "method not allowed" }, 405);
			return json(res, {
				ok: true,
				version: VERSION,
				uptime_s: Math.round((Date.now() - startTime) / 1000),
				stage_events_total: db.total(),
			});
		}

		// ── auth wall for everything else ─────────────────────────────────
		if (!checkAuth(req, url)) return json(res, { error: "unauthorized" }, 401);

		// ── POST /stage-events — validate → insert (dedupe) → broadcast ───
		if (pathname === "/stage-events" && method === "POST") {
			let bodyText: string;
			try {
				bodyText = await readBody(req);
			} catch (err) {
				return json(res, { error: String((err as Error).message ?? err) }, 413);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(bodyText);
			} catch {
				return json(res, { error: "invalid JSON" }, 400);
			}
			const events = Array.isArray(parsed) ? parsed : [parsed];
			let ingested = 0;
			let rejected = 0;
			let errors: string[] | undefined;
			for (const ev of events) {
				const v = validate(schema, ev);
				if (!v.valid) {
					rejected++;
					if (!errors) errors = v.errors; // the FIRST invalid event's errors
					continue;
				}
				// Valid + duplicate → not ingested, not rejected (idempotent re-POST).
				if (db.insert(ev as StageEvent)) {
					ingested++;
					broadcast(ev as StageEvent);
				}
			}
			return json(res, errors ? { ingested, rejected, errors } : { ingested, rejected });
		}

		// ── GET /stage-events?run_id=&card_id=&limit= — ascending seq ─────
		if (pathname === "/stage-events" && method === "GET") {
			const limit = parseInt(url.searchParams.get("limit") ?? "500", 10) || 500;
			const events = db.list({
				runId: url.searchParams.get("run_id") ?? undefined,
				cardId: url.searchParams.get("card_id") ?? undefined,
				limit,
			});
			return json(res, { events });
		}

		// ── GET /runs — per-run rollups, most recent first ─────────────────
		if (pathname === "/runs" && method === "GET") {
			const limit = parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
			return json(res, { runs: db.runs(limit) });
		}

		// ── GET /stage-events/stream — SSE ─────────────────────────────────
		if (pathname === "/stage-events/stream" && method === "GET") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
				...CORS,
			});
			const id = nextSubId++;
			subscribers.set(id, {
				id,
				res,
				runId: url.searchParams.get("run_id") ?? undefined,
				cardId: url.searchParams.get("card_id") ?? undefined,
			});
			const hello = JSON.stringify({ server: "holdco-obs", version: VERSION });
			res.write(`retry: 5000\nevent: hello\ndata: ${hello}\n\n`);
			res.on("close", () => subscribers.delete(id)); // clean unsubscribe
			return; // held open — no res.end()
		}

		return json(res, { error: "not found" }, 404);
	}

	const server = http.createServer((req, res) => {
		void handle(req, res).catch((err) => {
			try {
				json(res, { error: String(err) }, 500);
			} catch {
				/* response already gone */
			}
		});
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(opts.port ?? 0, host, () => resolveListen());
	});
	const port = (server.address() as AddressInfo).port;
	const url = `http://${host}:${port}`;

	if (!opts.quiet) {
		// The source server's boot banner, minus the UI URL (the deck replaces public/).
		console.log(`\n  holdco-obs server v${VERSION}`);
		console.log(`  URL:   ${url}`);
		console.log(`  Token: ${token}`);
		console.log(`  DB:    ${dbPath}\n`);
	}

	return {
		port,
		url,
		token,
		async close(): Promise<void> {
			clearInterval(heartbeat);
			for (const sub of [...subscribers.values()]) {
				try {
					sub.res.end();
				} catch {
					/* already gone */
				}
			}
			subscribers.clear();
			server.closeAllConnections();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			db.close();
		},
	};
}

// ── CLI entry (direct run: `node src/obs/server.ts [--port N] [--db PATH] [--token T]`) ──

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const flags: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i].startsWith("--")) {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[args[i].slice(2)] = next;
				i++;
			} else flags[args[i].slice(2)] = "true";
		}
	}
	const srv = await startObsServer({
		port: flags.port ? Number(flags.port) : 43190,
		host: flags.host || "127.0.0.1",
		dbPath: flags.db || resolve(process.cwd(), "obs.db"),
		token: flags.token || undefined,
	});
	const bye = () => void srv.close().then(() => process.exit(0));
	process.on("SIGINT", bye);
	process.on("SIGTERM", bye);
}
