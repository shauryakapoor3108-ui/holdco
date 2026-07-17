// obs-client.ts — read-only client for the pi-observability server (D2 telemetry harvest).
// (EngineHost port: Pi-free already — near-verbatim; constructor parameter properties
// expanded to explicit fields per the strip-only TypeScript rule.)
//
// The owner is the SOLE board-state writer; the cost/token rollup it writes on a card's
// completion is harvested from the obs server (it survives the worker process, unlike D1's
// in-REPL `agent_end` accumulation). Two queries, both grounded in observability/server.ts:
//   - GET /sessions?tag=<tag>        → resolve the worker's runtime session_id (server.ts:308)
//   - GET /sessions/:id/stats        → { total_cost, total_tokens, error_count, latest_ts } (server.ts:365)
//   - GET /health                    → liveness (server.ts:231)
//
// AUTH (grounded server.ts:27,124-139): the server auth-walls every push + query; the token
// is `OBS_AUTH_TOKEN` (random per-boot if unset). The owner pins one token, propagates it to
// every worker launch, and sends it here as `Authorization: Bearer <token>`. A 401 / down
// server / missing session is NOT fatal — every method RESOLVES `{ ok:false }` so the harvest
// degrades to the OUTCOME-only fallback (spec §7), never hard-blocks board state.
//
// `fetchFn` is injectable so the D2 self-test drives harvest off a FAKE server.

export type FetchFn = typeof fetch;

export interface SessionStats {
	total_cost: number;
	total_tokens: number;
	error_count: number;
	latest_ts: string | null;
}

export class ObsClient {
	private readonly serverUrl: string;
	private readonly token: string;
	private readonly fetchFn: FetchFn;
	private readonly timeoutMs: number;

	constructor(serverUrl: string, token: string, fetchFn: FetchFn = fetch, timeoutMs: number = 4_000) {
		this.serverUrl = serverUrl;
		this.token = token;
		this.fetchFn = fetchFn;
		this.timeoutMs = timeoutMs;
	}

	private headers(): Record<string, string> {
		return this.token ? { authorization: `Bearer ${this.token}` } : {};
	}

	private async get(path: string): Promise<any | null> {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
		try {
			const res = await this.fetchFn(`${this.serverUrl}${path}`, { headers: this.headers(), signal: ctrl.signal });
			if (!res.ok) return null; // 401 (token mismatch) / 404 / 5xx → telemetry-unavailable fallback
			return await res.json();
		} catch {
			return null; // server down / aborted / network → fallback
		} finally {
			clearTimeout(t);
		}
	}

	/** Liveness probe (unauthenticated route, but cheap). */
	async health(): Promise<boolean> {
		const data = await this.get("/health");
		return data?.ok === true;
	}

	/**
	 * Resolve a worker's runtime session_id via its `run:<runId>` tag. Pi mints the
	 * session UUID at runtime (not predictable from CLI args), so the per-spawn tag is
	 * the only sound correlation key. Returns the single matching session_id, or null
	 * (no match yet — the worker has not pushed its first event, or obs is down).
	 */
	async resolveSessionIdByTag(tag: string): Promise<string | null> {
		const data = await this.get(`/sessions?tag=${encodeURIComponent(tag)}`);
		const sessions = data?.sessions;
		if (!Array.isArray(sessions) || sessions.length === 0) return null;
		const sid = sessions[0]?.session_id;
		return typeof sid === "string" ? sid : null;
	}

	/** Per-session telemetry rollup. `{ ok:false }` on a down server / 401 / missing session. */
	async getStats(sessionId: string): Promise<{ ok: boolean; stats: SessionStats | null }> {
		const data = await this.get(`/sessions/${encodeURIComponent(sessionId)}/stats`);
		if (!data || typeof data !== "object") return { ok: false, stats: null };
		return {
			ok: true,
			stats: {
				total_cost: Number(data.total_cost ?? 0),
				total_tokens: Number(data.total_tokens ?? 0),
				error_count: Number(data.error_count ?? 0),
				latest_ts: typeof data.latest_ts === "string" ? data.latest_ts : null,
			},
		};
	}
}
