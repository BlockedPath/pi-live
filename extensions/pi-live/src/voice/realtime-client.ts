/**
 * GA OpenAI Realtime WebSocket client (VS2 / issue #9).
 *
 * Transcription-first; session shape is extensible for conversational mode later.
 * Protocol constraints:
 *   - wss://api.openai.com/v1/realtime?model=…
 *   - no OpenAI-Beta realtime=v1 header
 *   - session.type "realtime" on every session.update
 *   - nested audio.input / audio.output; PCM16 24 kHz
 */

import WebSocket from "ws";

import type { VoiceConfig } from "./config.js";
import type { RealtimeClientLike, TranscriptEvent } from "./types.js";

/** Default Realtime WS origin (override in tests). */
export const DEFAULT_REALTIME_URL = "wss://api.openai.com/v1/realtime";

/** PCM format object required by GA session.update. */
export interface RealtimeAudioFormat {
	type: "audio/pcm";
	rate: number;
}

export interface RealtimeInputAudioConfig {
	format?: RealtimeAudioFormat;
	transcription?: {
		model?: string;
		language?: string;
	};
	turn_detection?: Record<string, unknown> | null;
}

export interface RealtimeOutputAudioConfig {
	format?: RealtimeAudioFormat;
	voice?: string;
}

/**
 * Session body sent inside `session.update`.
 * Always stamped with `type: "realtime"` by the client.
 */
export interface RealtimeSessionConfig {
	type?: "realtime";
	model?: string;
	instructions?: string;
	output_modalities?: Array<"audio" | "text">;
	audio?: {
		input?: RealtimeInputAudioConfig;
		output?: RealtimeOutputAudioConfig;
	};
	tools?: unknown[];
	tool_choice?: unknown;
	[key: string]: unknown;
}

/** Connect-time options (typically derived from VoiceConfig). */
export interface RealtimeConnectConfig {
	/** Realtime model id (also placed on the WS query string). */
	model: string;
	/** PCM sample rate in Hz (default 24000). */
	sampleRate?: number;
	/** TTS voice under audio.output (conversational / later). */
	voice?: string;
	/** High-level mode — affects default session payload. */
	mode?: "transcription" | "conversational";
	/** Optional full session override merged into the default. */
	session?: RealtimeSessionConfig;
	/** Override WS URL origin (tests). Default: OpenAI GA endpoint. */
	url?: string;
}

/** Typed client events emitted via `on()`. */
export type RealtimeClientEventMap = {
	"session.created": [session: unknown];
	"session.updated": [session: unknown];
	"transcript.delta": [event: TranscriptEvent];
	"transcript.done": [event: TranscriptEvent];
	"speech.started": [event: TranscriptEvent];
	"speech.stopped": [event: TranscriptEvent];
	error: [error: RealtimeClientError];
	close: [info: { code: number; reason: string }];
	/** Raw parsed server event for extensibility (tools, audio deltas, …). */
	event: [event: RealtimeServerEvent];
};

export type RealtimeClientEvent = keyof RealtimeClientEventMap;

export interface RealtimeClientError {
	message: string;
	code?: string;
	/** Provider event_id when the error came from the server. */
	eventId?: string;
	/** Original server payload when available. */
	raw?: unknown;
}

/** Minimal server event shape we parse. */
export interface RealtimeServerEvent {
	type: string;
	event_id?: string;
	session?: unknown;
	item_id?: string;
	delta?: string;
	transcript?: string;
	error?: {
		type?: string;
		code?: string;
		message?: string;
		event_id?: string;
	};
	[key: string]: unknown;
}

/** Subset of the `ws` surface we rely on (injectable for tests). */
export interface WebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	/**
	 * EventEmitter-style subscribe (matches `ws`).
	 * Signature is intentionally wide so test doubles type-check cleanly.
	 */
	on(event: string, listener: (...args: any[]) => void): void;
	removeAllListeners?(): void;
}

export type WebSocketFactory = (
	url: string,
	options: { headers: Record<string, string> },
) => WebSocketLike;

export interface RealtimeClientOptions {
	/** Inject a mock WebSocket factory in unit tests. */
	webSocketFactory?: WebSocketFactory;
	/**
	 * Resolve when connect() should consider the socket ready.
	 * Default: wait for the WS `open` event (and optionally session.created).
	 */
	waitForSessionCreated?: boolean;
}

type Handler = (...args: unknown[]) => void;

const OPEN = 1; // WebSocket.OPEN

function defaultWebSocketFactory(
	url: string,
	options: { headers: Record<string, string> },
): WebSocketLike {
	// Intentionally no OpenAI-Beta header — GA protocol.
	return new WebSocket(url, { headers: options.headers });
}

function pcmFormat(sampleRate: number): RealtimeAudioFormat {
	return { type: "audio/pcm", rate: sampleRate };
}

/**
 * Build the default GA session.update body for transcription (MVP) or
 * conversational (later) mode. Always includes `type: "realtime"`.
 */
export function buildDefaultSessionConfig(
	config: RealtimeConnectConfig,
): RealtimeSessionConfig {
	const sampleRate = config.sampleRate ?? 24_000;
	const voice = config.voice ?? "marin";
	const mode = config.mode ?? "transcription";

	const base: RealtimeSessionConfig = {
		type: "realtime",
		model: config.model,
		audio: {
			input: {
				format: pcmFormat(sampleRate),
				transcription: {
					// Lightweight default; callers can override via updateSession /
					// config.session. audio.input.transcription.
					model: "gpt-4o-mini-transcribe",
				},
				turn_detection: {
					type: "server_vad",
				},
			},
			output: {
				format: pcmFormat(sampleRate),
				voice,
			},
		},
	};

	if (mode === "transcription") {
		// No spoken assistant response in MVP — text modality keeps the plane quiet.
		base.output_modalities = ["text"];
	} else {
		base.output_modalities = ["audio"];
	}

	if (config.session) {
		return mergeSessionConfig(base, config.session);
	}
	return base;
}

/** Deep-merge session partials; `type` is always forced to `"realtime"`. */
export function mergeSessionConfig(
	base: RealtimeSessionConfig,
	partial: RealtimeSessionConfig,
): RealtimeSessionConfig {
	const merged: RealtimeSessionConfig = {
		...base,
		...partial,
		type: "realtime",
	};

	const baseAudio = base.audio ?? {};
	const partialAudio = partial.audio ?? {};
	if (base.audio || partial.audio) {
		merged.audio = {
			...baseAudio,
			...partialAudio,
			input:
				baseAudio.input || partialAudio.input
					? { ...baseAudio.input, ...partialAudio.input }
					: undefined,
			output:
				baseAudio.output || partialAudio.output
					? { ...baseAudio.output, ...partialAudio.output }
					: undefined,
		};
	}

	return merged;
}

/** Map VoiceConfig → connect config (helper for later session wiring). */
export function connectConfigFromVoice(
	config: Pick<VoiceConfig, "model" | "sampleRate" | "voice" | "mode">,
): RealtimeConnectConfig {
	return {
		model: config.model,
		sampleRate: config.sampleRate,
		voice: config.voice,
		mode: config.mode,
	};
}

function toBase64(pcm16Base64OrBuffer: string | Uint8Array): string {
	if (typeof pcm16Base64OrBuffer === "string") return pcm16Base64OrBuffer;
	return Buffer.from(
		pcm16Base64OrBuffer.buffer,
		pcm16Base64OrBuffer.byteOffset,
		pcm16Base64OrBuffer.byteLength,
	).toString("base64");
}

function reasonToString(reason: Buffer | string | undefined): string {
	if (reason == null) return "";
	if (typeof reason === "string") return reason;
	return reason.toString("utf8");
}

/**
 * GA OpenAI Realtime WebSocket client.
 *
 * ```ts
 * const client = new RealtimeClient();
 * client.on("transcript.done", (ev) => { … });
 * await client.connect(auth.headers, { model: "gpt-realtime-2.1" });
 * client.appendAudio(pcmChunk);
 * client.close();
 * ```
 */
export class RealtimeClient implements RealtimeClientLike {
	readonly #wsFactory: WebSocketFactory;
	readonly #waitForSessionCreated: boolean;
	readonly #listeners = new Map<string, Set<Handler>>();

	#ws: WebSocketLike | undefined;
	#sessionConfig: RealtimeSessionConfig | undefined;
	#closed = false;
	#connectPromise: Promise<void> | undefined;

	constructor(options: RealtimeClientOptions = {}) {
		this.#wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
		this.#waitForSessionCreated = options.waitForSessionCreated ?? true;
	}

	/** True while a socket exists and is OPEN. */
	get connected(): boolean {
		return this.#ws?.readyState === OPEN;
	}

	/**
	 * Open the Realtime WebSocket with injected auth headers and config.
	 * Resolves after the socket opens and (by default) `session.created` arrives.
	 * Sends an initial `session.update` with `type: "realtime"`.
	 */
	connect(
		authHeaders: Record<string, string>,
		config: RealtimeConnectConfig,
	): Promise<void> {
		if (this.#connectPromise) {
			return this.#connectPromise;
		}
		if (this.connected) {
			return Promise.resolve();
		}

		this.#closed = false;
		this.#sessionConfig = buildDefaultSessionConfig(config);

		const origin = config.url ?? DEFAULT_REALTIME_URL;
		const url = `${origin}?model=${encodeURIComponent(config.model)}`;

		// Strip any accidental beta header — GA must not send it.
		const headers: Record<string, string> = { ...authHeaders };
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === "openai-beta") {
				delete headers[key];
			}
		}

		this.#connectPromise = new Promise<void>((resolve, reject) => {
			let settled = false;
			const settleOk = () => {
				if (settled) return;
				settled = true;
				resolve();
			};
			const settleErr = (err: Error) => {
				if (settled) return;
				settled = true;
				this.#connectPromise = undefined;
				reject(err);
			};

			let ws: WebSocketLike;
			try {
				ws = this.#wsFactory(url, { headers });
			} catch (err) {
				settleErr(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			this.#ws = ws;

			const onOpen = () => {
				const session = this.#sessionConfig;
				if (!session) {
					settleErr(new Error("RealtimeClient session config missing on open"));
					return;
				}
				try {
					this.#sendSessionUpdate(session);
				} catch (err) {
					settleErr(err instanceof Error ? err : new Error(String(err)));
					return;
				}
				if (!this.#waitForSessionCreated) {
					settleOk();
				}
			};

			const onMessage = (data: WebSocket.RawData) => {
				this.#handleMessage(data, {
					onSessionCreated: () => {
						if (this.#waitForSessionCreated) settleOk();
					},
				});
			};

			const onError = (err: Error) => {
				const wrapped =
					err instanceof Error ? err : new Error(String(err));
				this.#emit("error", {
					message: wrapped.message,
					raw: wrapped,
				} satisfies RealtimeClientError);
				if (!settled) settleErr(wrapped);
			};

			const onClose = (code: number, reason: Buffer | string) => {
				const info = { code, reason: reasonToString(reason) };
				this.#ws = undefined;
				this.#connectPromise = undefined;
				this.#emit("close", info);
				if (!settled) {
					settleErr(
						new Error(
							`Realtime WebSocket closed before ready (code=${code}${
								info.reason ? `: ${info.reason}` : ""
							})`,
						),
					);
				}
			};

			ws.on("open", onOpen);
			ws.on("message", onMessage);
			ws.on("error", onError);
			ws.on("close", onClose);
		});

		return this.#connectPromise;
	}

	/** Close the socket (idempotent). */
	close(): void {
		this.#closed = true;
		const ws = this.#ws;
		this.#ws = undefined;
		this.#connectPromise = undefined;
		if (!ws) return;
		try {
			// 1000 = normal closure
			ws.close(1000, "client close");
		} catch {
			// ignore
		}
		ws.removeAllListeners?.();
	}

	/**
	 * Append PCM16 audio to the input buffer.
	 * Accepts base64 string or raw PCM16 bytes (encoded to base64).
	 */
	appendAudio(pcm16Base64OrBuffer: string | Uint8Array): void {
		const audio = toBase64(pcm16Base64OrBuffer);
		this.#send({ type: "input_audio_buffer.append", audio });
	}

	/**
	 * Commit the input audio buffer (manual turn end when VAD is off).
	 * Not on the minimal contract but useful for tests / PTT later.
	 */
	commitAudio(): void {
		this.#send({ type: "input_audio_buffer.commit" });
	}

	/** Clear the input audio buffer. */
	clearAudio(): void {
		this.#send({ type: "input_audio_buffer.clear" });
	}

	/**
	 * Merge a partial session config and send `session.update`.
	 * Always forces `session.type` to `"realtime"`.
	 */
	updateSession(partial: RealtimeSessionConfig | Record<string, unknown>): void {
		const next = mergeSessionConfig(
			this.#sessionConfig ?? { type: "realtime" },
			partial as RealtimeSessionConfig,
		);
		this.#sessionConfig = next;
		this.#sendSessionUpdate(next);
	}

	/**
	 * Subscribe to a typed client event.
	 * Returns an unsubscribe function.
	 */
	on<E extends RealtimeClientEvent>(
		event: E,
		handler: (...args: RealtimeClientEventMap[E]) => void,
	): () => void;
	on(event: string, handler: (...args: unknown[]) => void): () => void;
	on(event: string, handler: Handler): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(handler);
		return () => {
			const listeners = this.#listeners.get(event);
			listeners?.delete(handler);
		};
	}

	/** Current session config snapshot (post-merge). */
	getSessionConfig(): Readonly<RealtimeSessionConfig> | undefined {
		return this.#sessionConfig;
	}

	// ── internals ──────────────────────────────────────────────────────────

	#emit(event: string, ...args: unknown[]): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const handler of set) {
			try {
				handler(...args);
			} catch {
				// Listener errors must not tear down the socket.
			}
		}
	}

	#send(payload: Record<string, unknown>): void {
		if (this.#closed || !this.#ws || this.#ws.readyState !== OPEN) {
			throw new Error("RealtimeClient is not connected");
		}
		this.#ws.send(JSON.stringify(payload));
	}

	#sendSessionUpdate(session: RealtimeSessionConfig): void {
		const body: RealtimeSessionConfig = { ...session, type: "realtime" };
		this.#send({ type: "session.update", session: body });
	}

	#handleMessage(
		data: WebSocket.RawData,
		hooks: { onSessionCreated: () => void },
	): void {
		let parsed: RealtimeServerEvent;
		try {
			const text =
				typeof data === "string"
					? data
					: Buffer.isBuffer(data)
						? data.toString("utf8")
						: Buffer.from(data as ArrayBuffer).toString("utf8");
			parsed = JSON.parse(text) as RealtimeServerEvent;
		} catch (err) {
			this.#emit("error", {
				message: `Failed to parse server event: ${
					err instanceof Error ? err.message : String(err)
				}`,
				raw: data,
			} satisfies RealtimeClientError);
			return;
		}

		this.#emit("event", parsed);
		this.#dispatchServerEvent(parsed, hooks);
	}

	#dispatchServerEvent(
		event: RealtimeServerEvent,
		hooks: { onSessionCreated: () => void },
	): void {
		switch (event.type) {
			case "session.created": {
				this.#emit("session.created", event.session ?? event);
				hooks.onSessionCreated();
				break;
			}
			case "session.updated": {
				this.#emit("session.updated", event.session ?? event);
				break;
			}
			case "conversation.item.input_audio_transcription.delta": {
				const text =
					typeof event.delta === "string" ? event.delta : "";
				const te: TranscriptEvent = {
					type: "partial",
					text,
					itemId:
						typeof event.item_id === "string"
							? event.item_id
							: undefined,
					timestamp: Date.now(),
				};
				this.#emit("transcript.delta", te);
				break;
			}
			case "conversation.item.input_audio_transcription.completed": {
				const text =
					typeof event.transcript === "string" ? event.transcript : "";
				const te: TranscriptEvent = {
					type: "final",
					text,
					itemId:
						typeof event.item_id === "string"
							? event.item_id
							: undefined,
					timestamp: Date.now(),
				};
				this.#emit("transcript.done", te);
				break;
			}
			case "input_audio_buffer.speech_started": {
				const te: TranscriptEvent = {
					type: "speech_started",
					text: "",
					itemId:
						typeof event.item_id === "string"
							? event.item_id
							: undefined,
					timestamp: Date.now(),
				};
				this.#emit("speech.started", te);
				break;
			}
			case "input_audio_buffer.speech_stopped": {
				const te: TranscriptEvent = {
					type: "speech_stopped",
					text: "",
					itemId:
						typeof event.item_id === "string"
							? event.item_id
							: undefined,
					timestamp: Date.now(),
				};
				this.#emit("speech.stopped", te);
				break;
			}
			case "error": {
				const err = event.error;
				this.#emit("error", {
					message: err?.message ?? "Realtime server error",
					code: err?.code,
					eventId: err?.event_id ?? event.event_id,
					raw: event,
				} satisfies RealtimeClientError);
				break;
			}
			default:
				// Other events available via the "event" channel.
				break;
		}
	}
}
