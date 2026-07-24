/**
 * GA OpenAI Realtime WebSocket client (VS2 / issue #9, VS8 / #15).
 *
 * Transcription MVP + conversational mode (`pi_turn` tool, audio out,
 * function_call_output). Protocol constraints:
 *   - wss://api.openai.com/v1/realtime?model=…
 *   - no OpenAI-Beta realtime=v1 header
 *   - session.type "realtime" on every session.update
 *   - nested audio.input / audio.output; PCM16 24 kHz
 */

import WebSocket from "ws";

import type { VoiceConfig } from "./config.js";
import type {
	FunctionCallEvent,
	RealtimeClientLike,
	TranscriptEvent,
} from "./types.js";

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

/** Narrow tool surface for conversational mode (VS8). */
export const PI_TURN_TOOL = {
	type: "function" as const,
	name: "pi_turn",
	description:
		"Delegate a coding or repository task to the pi agent. Use for ANY " +
		"file reads/edits, shell commands, searches, git, tests, or other " +
		"coding work. Do not invent file contents or claim you ran commands.",
	parameters: {
		type: "object",
		properties: {
			message: {
				type: "string",
				description:
					"Clear instruction for the pi coding agent (what to do in the repo).",
			},
		},
		required: ["message"],
	},
} as const;

/**
 * System instructions for conversational mode.
 * Voice model holds chit-chat; all coding goes through `pi_turn`.
 */
export const CONVERSATIONAL_INSTRUCTIONS = [
	"You are a voice pair-programming partner sitting next to the pi coding agent.",
	"You hold a brief spoken conversation with the user.",
	"ALL coding, file reads/edits, shell, git, tests, and repository work MUST go",
	"through the pi_turn tool — never invent file contents, diffs, or command output.",
	"When the user asks for coding work, call pi_turn with a clear message, then",
	"summarize the tool result briefly in speech.",
	"Keep spoken replies short (one or two sentences). Do not monologue.",
	"If you are unsure what the user wants, ask a short clarifying question instead",
	"of guessing or calling pi_turn with a vague task.",
].join(" ");

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
	/** Conversational: model requested a tool (typically `pi_turn`). */
	function_call: [event: FunctionCallEvent];
	/** Conversational: base64 PCM16 audio chunk from the model. */
	"audio.delta": [event: RealtimeAudioDeltaEvent];
	/** Conversational: end of an assistant audio segment. */
	"audio.done": [event: RealtimeAudioDoneEvent];
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

/** Audio output chunk from the Realtime model (conversational). */
export interface RealtimeAudioDeltaEvent {
	/** Base64-encoded PCM16 mono audio. */
	delta: string;
	itemId?: string;
	responseId?: string;
	timestamp: number;
}

export interface RealtimeAudioDoneEvent {
	itemId?: string;
	responseId?: string;
	timestamp: number;
}

/** Minimal server event shape we parse. */
export interface RealtimeFunctionCallItem {
	type?: string;
	id?: string;
	name?: string;
	call_id?: string;
	arguments?: string;
	status?: string;
}

export interface RealtimeServerEvent {
	type: string;
	event_id?: string;
	session?: unknown;
	item_id?: string;
	response_id?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	delta?: string;
	transcript?: string;
	item?: RealtimeFunctionCallItem;
	response?: {
		id?: string;
		status?: string;
		output?: RealtimeFunctionCallItem[];
		[key: string]: unknown;
	};
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
 * Build the default GA session.update body for transcription or
 * conversational mode. Always includes `type: "realtime"`.
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
		// Explicit empty tools so a live mode-switch clears conversational tools.
		base.tools = [];
		base.tool_choice = "none";
		// Transcription plane: VAD for endpointing only; no assistant speech.
		base.audio = {
			...base.audio,
			input: {
				...base.audio?.input,
				turn_detection: {
					type: "server_vad",
					create_response: false,
					interrupt_response: false,
				},
			},
		};
	} else {
		// Full duplex voice: Realtime speaks + may call pi_turn.
		// GA only allows ["audio"] or ["text"] — not both.
		base.output_modalities = ["audio"];
		base.instructions = CONVERSATIONAL_INSTRUCTIONS;
		base.tools = [PI_TURN_TOOL];
		base.tool_choice = "auto";
		base.audio = {
			...base.audio,
			input: {
				...base.audio?.input,
				turn_detection: {
					type: "server_vad",
					// Automatically answer after user speech + allow barge-in cancel.
					create_response: true,
					interrupt_response: true,
				},
			},
		};
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

/** Server errors that are expected during barge-in / idle cancel. */
function isBenignRealtimeError(message: string, code?: string): boolean {
	const m = message.toLowerCase();
	if (m.includes("no active response")) return true;
	if (m.includes("cancellation failed") && m.includes("no active")) return true;
	if (code === "response_cancel_not_active") return true;
	return false;
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
	/** Dedupe function_call emits across arguments.done / output_item.done / response.done. */
	#seenCallIds = new Set<string>();

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
		this.#seenCallIds.clear();
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

	/**
	 * Return a tool result to the Realtime conversation (VS8).
	 * Caller should follow with {@link createResponse}.
	 */
	sendFunctionCallOutput(callId: string, output: string): void {
		this.#send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: callId,
				output,
			},
		});
	}

	/** Ask the model to generate a response (after tool output or manual turn). */
	createResponse(response?: Record<string, unknown>): void {
		if (response && Object.keys(response).length > 0) {
			this.#send({ type: "response.create", response });
		} else {
			this.#send({ type: "response.create" });
		}
	}

	/** Cancel an in-flight model response (barge-in / interrupt). */
	cancelResponse(): void {
		try {
			this.#send({ type: "response.cancel" });
		} catch {
			// Not connected or no active response — ignore.
		}
	}

	/**
	 * Truncate unplayed assistant audio after a user barge-in (WebSocket path).
	 * `audioEndMs` is how much of the item the user actually heard.
	 */
	truncateConversationItem(
		itemId: string,
		audioEndMs: number,
		contentIndex = 0,
	): void {
		try {
			this.#send({
				type: "conversation.item.truncate",
				item_id: itemId,
				content_index: contentIndex,
				audio_end_ms: Math.max(0, Math.floor(audioEndMs)),
			});
		} catch {
			// ignore when disconnected
		}
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

	#emitFunctionCall(partial: {
		name: string;
		callId: string;
		arguments: string;
		itemId?: string;
	}): void {
		const callId = partial.callId.trim();
		if (!callId) return;
		if (this.#seenCallIds.has(callId)) return;
		this.#seenCallIds.add(callId);
		// Bound memory for long sessions.
		if (this.#seenCallIds.size > 200) {
			const first = this.#seenCallIds.values().next().value;
			if (typeof first === "string") this.#seenCallIds.delete(first);
		}
		const fc: FunctionCallEvent = {
			name: partial.name,
			callId,
			arguments: partial.arguments || "{}",
			itemId: partial.itemId,
			timestamp: Date.now(),
		};
		this.#emit("function_call", fc);
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
			case "response.function_call_arguments.done": {
				this.#emitFunctionCall({
					name: typeof event.name === "string" ? event.name : "",
					callId: typeof event.call_id === "string" ? event.call_id : "",
					arguments:
						typeof event.arguments === "string" ? event.arguments : "{}",
					itemId:
						typeof event.item_id === "string" ? event.item_id : undefined,
				});
				break;
			}
			case "response.output_item.done": {
				const item = event.item;
				if (item && item.type === "function_call") {
					this.#emitFunctionCall({
						name: typeof item.name === "string" ? item.name : "",
						callId: typeof item.call_id === "string" ? item.call_id : "",
						arguments:
							typeof item.arguments === "string" ? item.arguments : "{}",
						itemId:
							typeof item.id === "string"
								? item.id
								: typeof event.item_id === "string"
									? event.item_id
									: undefined,
					});
				}
				break;
			}
			case "response.done": {
				// Primary documented path for completed tool calls.
				const output = event.response?.output;
				if (Array.isArray(output)) {
					for (const item of output) {
						if (!item || item.type !== "function_call") continue;
						this.#emitFunctionCall({
							name: typeof item.name === "string" ? item.name : "",
							callId:
								typeof item.call_id === "string" ? item.call_id : "",
							arguments:
								typeof item.arguments === "string"
									? item.arguments
									: "{}",
							itemId: typeof item.id === "string" ? item.id : undefined,
						});
					}
				}
				break;
			}
			// GA name; keep beta alias for older gateways.
			case "response.output_audio.delta":
			case "response.audio.delta": {
				const delta = typeof event.delta === "string" ? event.delta : "";
				if (!delta) break;
				this.#emit("audio.delta", {
					delta,
					itemId:
						typeof event.item_id === "string"
							? event.item_id
							: undefined,
					responseId:
						typeof event.response_id === "string"
							? event.response_id
							: undefined,
					timestamp: Date.now(),
				} satisfies RealtimeAudioDeltaEvent);
				break;
			}
			case "response.output_audio.done":
			case "response.audio.done": {
				this.#emit("audio.done", {
					itemId:
						typeof event.item_id === "string"
							? event.item_id
							: undefined,
					responseId:
						typeof event.response_id === "string"
							? event.response_id
							: undefined,
					timestamp: Date.now(),
				} satisfies RealtimeAudioDoneEvent);
				break;
			}
			case "error": {
				const err = event.error;
				const message = err?.message ?? "Realtime server error";
				// Barge-in always tries response.cancel; server errors if idle.
				if (isBenignRealtimeError(message, err?.code)) {
					break;
				}
				this.#emit("error", {
					message,
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
