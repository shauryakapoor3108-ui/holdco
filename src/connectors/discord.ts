// discord.ts - Discord intake connector: polls channel history via the REST
// API with native fetch (zero deps, no gateway/websocket) and normalizes new
// human messages into SourceEvents.
//
// Cursor semantics: the FIRST successful poll of a channel only SEEDS the
// cursor (max message id seen) and delivers nothing. Only messages that
// arrive AFTER start() are intake - without this, every boot would re-draft
// the entire channel history as cards. (Redelivery of an already-drafted
// message is still harmless: the drafter dedupes on source_ref.)
//
// Failure policy (contract rule 4): 429s, 5xx and network errors are logged
// and retried on the next poll - nothing throws out of the watch loop. A 429
// honours Retry-After by skipping polls until the window elapses.

import type { Connector, SourceEvent, StopFn } from "./types.ts";

export interface DiscordConnectorOpts {
	botToken: string;
	channelIds: string[];
	/** Poll cadence, default 15s. */
	pollMs?: number;
	/** REST base, default the real API - injectable for tests. */
	apiBase?: string;
	/** fetch implementation, default globalThis.fetch - injectable for tests. */
	fetchFn?: typeof fetch;
	log?: (event: string, data: Record<string, unknown>) => void;
}

/** The subset of a Discord REST message object this connector reads. */
interface DiscordMessage {
	id: string;
	content?: string;
	timestamp?: string;
	author?: { username?: string; bot?: boolean };
}

/** First non-empty line, clipped to ~80 chars. */
function firstLineTitle(content: string): string {
	const line = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? content.trim();
	return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}

/** Snowflake ids are 64-bit - compare as BigInt, never as strings. */
function snowflakeGt(a: string, b: string): boolean {
	return BigInt(a) > BigInt(b);
}

export class DiscordConnector implements Connector {
	readonly name = "discord";

	private readonly botToken: string;
	private readonly channelIds: string[];
	private readonly pollMs: number;
	private readonly apiBase: string;
	private readonly fetchFn: typeof fetch;
	private readonly log?: (event: string, data: Record<string, unknown>) => void;

	/** channelId → max message id seen (undefined = not yet seeded). */
	private readonly cursors = new Map<string, string>();
	private stopped = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Epoch ms until which polls are skipped (set by a 429's Retry-After). */
	private retryAt = 0;

	constructor(opts: DiscordConnectorOpts) {
		this.botToken = opts.botToken;
		this.channelIds = [...opts.channelIds];
		this.pollMs = opts.pollMs ?? 15_000;
		this.apiBase = (opts.apiBase ?? "https://discord.com/api/v10").replace(/\/+$/, "");
		this.fetchFn = opts.fetchFn ?? fetch;
		this.log = opts.log;
	}

	async start(onEvent: (ev: SourceEvent) => void): Promise<StopFn> {
		this.stopped = false;
		// Seed pass: arms the cursors so only messages after "now" are intake.
		await this.pollAll(onEvent);
		const schedule = (): void => {
			if (this.stopped) return;
			this.timer = setTimeout(() => {
				this.pollAll(onEvent).then(schedule, schedule);
			}, this.pollMs);
		};
		schedule();
		return async () => {
			this.stopped = true;
			if (this.timer !== undefined) {
				clearTimeout(this.timer);
				this.timer = undefined;
			}
		};
	}

	/** One poll across all channels. NEVER throws (contract rule 4). */
	private async pollAll(onEvent: (ev: SourceEvent) => void): Promise<void> {
		for (const channelId of this.channelIds) {
			if (this.stopped || Date.now() < this.retryAt) return;
			try {
				await this.pollChannel(channelId, onEvent);
			} catch (err) {
				// Network/parse failure - log and retry next poll.
				this.log?.("DISCORD_POLL_ERROR", { channel: channelId, error: String(err) });
			}
		}
	}

	private async pollChannel(channelId: string, onEvent: (ev: SourceEvent) => void): Promise<void> {
		const cursor = this.cursors.get(channelId);
		const url =
			`${this.apiBase}/channels/${channelId}/messages?limit=50` +
			(cursor !== undefined ? `&after=${cursor}` : "");
		const res = await this.fetchFn(url, { headers: { Authorization: `Bot ${this.botToken}` } });

		if (res.status === 429) {
			const raw = res.headers.get("retry-after");
			const seconds = raw !== null && Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : 1;
			this.retryAt = Date.now() + seconds * 1000;
			this.log?.("DISCORD_RATE_LIMITED", { channel: channelId, retry_after_s: seconds });
			return;
		}
		if (!res.ok) {
			this.log?.("DISCORD_HTTP_ERROR", { channel: channelId, status: res.status });
			return;
		}

		const messages = (await res.json()) as DiscordMessage[];
		if (!Array.isArray(messages)) {
			this.log?.("DISCORD_BAD_RESPONSE", { channel: channelId });
			return;
		}
		if (messages.length === 0) {
			// Empty channel at seed time: everything that ever arrives is new.
			if (cursor === undefined) this.cursors.set(channelId, "0");
			return;
		}

		// Discord returns newest-first; deliver oldest-first.
		const ascending = [...messages].sort((a, b) => (snowflakeGt(a.id, b.id) ? 1 : -1));
		const maxId = ascending[ascending.length - 1].id;

		if (cursor === undefined) {
			// First successful poll: seed only - channel history is not intake.
			this.cursors.set(channelId, maxId);
			this.log?.("DISCORD_CURSOR_SEEDED", { channel: channelId, cursor: maxId });
			return;
		}

		if (snowflakeGt(maxId, cursor)) this.cursors.set(channelId, maxId);

		for (const msg of ascending) {
			if (this.stopped) return;
			if (!snowflakeGt(msg.id, cursor)) continue; // defensive: never re-deliver behind the cursor
			if (msg.author?.bot === true) continue; // bot chatter is not intake (incl. our own echoes)
			const content = (msg.content ?? "").trim();
			if (!content) continue; // attachment-only / embed-only messages carry no draftable text
			onEvent({
				sourceType: "discord-message",
				// No guild id on this endpoint's message objects - use a stable
				// synthetic scheme instead of a https://discord.com/channels URL.
				sourceRef: `discord://${channelId}/${msg.id}`,
				surfacedBy: msg.author?.username || "unknown",
				title: firstLineTitle(content),
				body: content,
				receivedAt: msg.timestamp || new Date().toISOString(),
			});
		}
	}
}
