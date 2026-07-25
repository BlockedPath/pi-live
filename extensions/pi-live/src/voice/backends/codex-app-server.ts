/**
 * Optional Codex app-server realtime V3 voice backend (VS9 / issue #16).
 *
 * Instead of pi talking to the OpenAI Realtime WebSocket API directly, this
 * backend drives the LOCAL Codex CLI `app-server` realtime session and maps
 * its `thread/realtime/*` events into the SAME `RealtimeClientLike` surface
 * the existing `/voice` session already consumes — so `/voice status`, the
 * transcript widget, TTS, prefs, and the pi bridge all keep working.
 *
 * ── Protocol research summary (Codex CLI 0.145.0) ─────────────────────────
 * `codex app-server` speaks JSON-RPC 2.0 over stdio (newline-delimited JSON;
 * the `"jsonrpc":"2.0"` header is OMITTED on the wire per the app-server README).
 * Realtime is EXPERIMENTAL and lives behind `thread/realtime/*`:
 *
 *   initialize                       → {clientInfo:{name,title,version},
 *                                      capabilities:{experimentalApi:true}}
 *   initialized                      (notification, no id)
 *   thread/start                     → {} → response {thread:{id,...}}
 *   thread/realtime/start            → {threadId, outputModality:"text"|"audio",
 *                                      version:"v2" (text) | "v3" (audio),
 *                                      voice?, model?, transport?}
 *                                    → {} (then thread/realtime/started notification)
 *   thread/realtime/appendAudio      → {threadId, audio:{data:b64, sampleRate, numChannels}}
 *   thread/realtime/appendText      → {threadId, text, role}
 *   thread/realtime/appendSpeech     → {threadId, text}
 *   thread/realtime/stop             → {threadId}
 *
 * Notifications (thread-scoped, camelCase params — method names use slashes):
 *   thread/realtime/started          {threadId, realtimeSessionId, version}
 *   thread/realtime/transcript/delta {threadId, role, delta}
 *   thread/realtime/transcript/done  {threadId, role, text}   (assumed; not in the
 *                                    fetched realtime.rs struct list — see GAPS)
 *   thread/realtime/outputAudio/delta{threadId, audio:{data, sampleRate,
 *                                    numChannels, samplesPerChannel?, itemId?}}
 *   thread/realtime/itemAdded        {threadId, item} (raw non-audio items,
 *                                    incl. handoff_request)
 *   thread/realtime/sdp              {threadId, sdp}  (WebRTC only)
 *   thread/realtime/error            {threadId, message}
 *   thread/realtime/closed           {threadId, reason?}
 *
 * Sources: openai/codex `codex-rs/app-server/README.md`,
 * `codex-rs/app-server-protocol/src/protocol/v2/realtime.rs`, and the
 * `tests/suite/v2/realtime_conversation.rs` fixture (method-name strings).
 *
 * ── Known gaps / assumptions (do NOT treat as verified facts) ─────────────
 *  G1. `thread/realtime/transcript/done` is assumed from the Rust struct
 *      `ThreadRealtimeTranscriptDoneNotification`; the exact wire method string
 *      was not confirmed against a running server. Falls back gracefully
 *      (unknown notifications are ignored, transcript finalizes on `closed`).
 *  G2. Codex V3 has no explicit server-VAD `speech_started`/`speech_stopped`
 *      events like OpenAI Realtime. We SYNTHESIZE them from user-role
 *      transcript deltas/done so the session hearing state + barge-in meter
 *      still have something to track.
 *  G3. There is no documented `thread/realtime/outputAudio/done` notification.
 *      We emit `audio.done` when an assistant-role transcript/done arrives
 *      (assistant finished speaking) and on `closed`, so `PcmStreamPlayer`
 *      finalizes. Marked as an assumption.
 *  G4. V3 "handoffs" delegate coding to Codex's OWN background agent, NOT to
 *      pi. That conflicts with the pi-live design where pi owns the coding
 *      plane. We therefore do NOT map `itemAdded` handoff items to Realtime
 *      `function_call`/`pi_turn`. Conversational `pi_turn` (which delegates to
 *      pi) is the OpenAI-backend's mechanism; with the codex backend the
 *      `pi_turn` tool path is simply inactive. Coding still goes through pi
 *      via the transcription bridge (final user transcript → sendUserMessage).
 *  G5. `updateSession` (live mode switch) is a best-effort NO-OP: the Codex
 *      realtime session was started with the right modality at connect time
 *      and has no single-message `session.update` equivalent. A
 *      `/voice stop` + `/voice start` picks up a new mode.
 *  G6. `sendFunctionCallOutput` / `createResponse` / `cancelResponse` /
 *      `truncateConversationItem` are not implemented (left undefined on the
 *      interface) because the V3 voice plane does not use Realtime tool-call
 *      round-trips. The session calls them with optional-chaining (`?.()`),
 *      so their absence is safe.
 *  G7. AUTH/TRANSPORT: the app-server rejects WebSocket-transport realtime on a
 *      ChatGPT-OAuth account with `realtime conversation requires API key auth`
 *      (verified against 0.145 for BOTH V2 text and V3 audio). Only the WebRTC
 *      transport works over OAuth, and it is audio-only. So:
 *        conversational/audio → WebRTC   (works with ChatGPT/Codex OAuth)
 *        transcription/text   → WebSocket (requires an OpenAI API key)
 *      WebRTC media is handled by `./codex-webrtc.ts` (`@roamhq/wrtc`): the SDP
 *      offer is generated locally (non-trickle, ICE candidates included), sent
 *      as `transport:{type:"webrtc", sdp}`, and the app-server replies with a
 *      `thread/realtime/sdp` answer notification.
 *  G8. A WebRTC realtime session is minted server-side from Codex's OWN config,
 *      so `session.model` is not client-settable: passing one fails with
 *      "Field `session.model` is not allowed for this Codex realtime session".
 *      `PI_VOICE_MODEL` is therefore ignored on the WebRTC path (the model comes
 *      from `~/.codex/config.toml`); it is still forwarded over WebSocket.
 *
 * Unit tests inject a fake `CodexTransport` — no real `codex` process and no
 * network are required.
 */
import {
	spawn,
	type ChildProcess,
	type SpawnOptions,
} from "node:child_process";

import type { RealtimeAudioDeltaEvent } from "../realtime-client.js";
import type { RealtimeClientLike, TranscriptEvent } from "../types.js";
import { CodexWebRtcMedia, type WrtcModule } from "./codex-webrtc.js";

/** Codex binary used when spawning the app-server (override in tests). */
export const DEFAULT_CODEX_BIN = "codex";

/**
 * Voice names accepted by Codex app-server V3 bidi realtime (0.145). The OpenAI
 * Realtime default `marin` is NOT in this set and is rejected, so we only
 * forward `voice` when it matches — otherwise the server picks its own default.
 */
export const CODEX_V3_VOICES = new Set([
	"juniper",
	"maple",
	"spruce",
	"ember",
	"vale",
	"breeze",
	"arbor",
	"sol",
	"cove",
]);
/** Machine-readable reason codes for backend failures (surfaced in errors). */
export type CodexBackendErrorCode =
	| "cli_missing"
	| "not_running"
	| "no_realtime"
	| "handshake"
	| "closed";

export class CodexBackendError extends Error {
	readonly code: CodexBackendErrorCode;
	constructor(code: CodexBackendErrorCode, message: string) {
		super(message);
		this.name = "CodexBackendError";
		this.code = code;
	}
}

/**
 * Injectable transport abstraction over the app-server stdio channel.
 * Production uses {@link StdioCodexTransport}; tests inject a fake that
 * records sent lines and lets the test push inbound lines.
 */
export interface CodexTransport {
	/** Write one JSON-RPC message (already serialized) as a single line. */
	send(line: string): void;
	/** Inbound line (one JSON-RPC message). */
	onLine(cb: (line: string) => void): void;
	/** Underlying transport error (spawn failure, broken pipe, …). */
	onError(cb: (err: Error) => void): void;
	/** Transport closed (child exited / EOF). */
	onClose(cb: () => void): void;
	/** Tear the transport down (kill child / close streams). */
	close(): void;
}

/** Spawn options shape we pass through (narrowed for test injection). */
export type CodexSpawnFn = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess;

/**
 * Production transport: spawns `codex app-server --stdio` and frames
 * newline-delimited JSON over stdio. stderr is buffered for error messages.
 */
export class StdioCodexTransport implements CodexTransport {
	readonly #child: ChildProcess;
	readonly #lineCbs = new Set<(line: string) => void>();
	readonly #errCbs = new Set<(err: Error) => void>();
	readonly #closeCbs = new Set<() => void>();
	#stdoutBuf = "";
	#stderrBuf = "";
	#closed = false;

	constructor(spawnFn: CodexSpawnFn, codexBin: string, env: NodeJS.ProcessEnv) {
		this.#child = spawnFn(codexBin, ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		this.#child.stdout?.setEncoding("utf8");
		this.#child.stderr?.setEncoding("utf8");

		this.#child.stdout?.on("data", (chunk: string) => {
			this.#stdoutBuf += chunk;
			let nl: number;
			while ((nl = this.#stdoutBuf.indexOf("\n")) >= 0) {
				const line = this.#stdoutBuf.slice(0, nl);
				this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
				if (line.trim()) {
					for (const cb of this.#lineCbs) cb(line);
				}
			}
		});
		this.#child.stderr?.on("data", (chunk: string) => {
			this.#stderrBuf += chunk;
			// Keep stderr bounded; only the tail matters for error messages.
			if (this.#stderrBuf.length > 4096) {
				this.#stderrBuf = this.#stderrBuf.slice(-4096);
			}
		});
		this.#child.on("error", (err) => {
			for (const cb of this.#errCbs) cb(err);
		});
		this.#child.on("close", () => {
			this.#markClosed();
		});
	}

	send(line: string): void {
		if (this.#closed) {
			throw new CodexBackendError(
				"closed",
				"codex app-server transport closed",
			);
		}
		const stdin = this.#child.stdin;
		if (!stdin || stdin.destroyed) {
			throw new CodexBackendError("closed", "codex app-server stdin closed");
		}
		stdin.write(`${line}\n`);
	}

	onLine(cb: (line: string) => void): void {
		this.#lineCbs.add(cb);
	}
	onError(cb: (err: Error) => void): void {
		this.#errCbs.add(cb);
	}
	onClose(cb: () => void): void {
		this.#closeCbs.add(cb);
	}

	close(): void {
		this.#markClosed();
		try {
			this.#child.stdin?.end();
		} catch {
			// ignore
		}
		try {
			this.#child.kill("SIGTERM");
		} catch {
			// ignore
		}
	}

	#markClosed(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const cb of this.#closeCbs) cb();
	}
}

/** Result of probing for the Codex CLI on PATH. */
export interface CodexDetectResult {
	ok: boolean;
	version?: string;
	reason?: string;
}

/**
 * Detect the `codex` CLI by running `<bin> --version`. Never throws — returns
 * a structured result so callers can surface a clear error. Injectable spawn
 * for unit tests.
 */
export function detectCodexCli(
	spawnFn: CodexSpawnFn,
	bin: string = DEFAULT_CODEX_BIN,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CodexDetectResult> {
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawnFn(bin, ["--version"], {
				stdio: ["ignore", "pipe", "pipe"],
				env,
			});
		} catch (err) {
			resolve({
				ok: false,
				reason: `codex CLI not found: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}
		let out = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}, 4000);
		(timer as NodeJS.Timeout).unref?.();
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (c: string) => (out += c));
		child.on("error", (err) => {
			clearTimeout(timer);
			if (timedOut) return;
			resolve({
				ok: false,
				reason: `codex CLI not found on PATH (${err.message})`,
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				resolve({ ok: false, reason: "codex --version timed out" });
				return;
			}
			if (code !== 0) {
				resolve({
					ok: false,
					reason: `codex --version exited with code ${code}`,
				});
				return;
			}
			const version = out.trim().split(/\s+/).pop() || out.trim();
			resolve({ ok: true, version });
		});
	});
}

type Handler = (...args: unknown[]) => void;

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	method: string;
}

export interface CodexAppServerBackendOptions {
	/** Injectable transport (tests). When omitted, a stdio child is spawned. */
	transport?: CodexTransport;
	/** Override the codex binary name (default `codex`). */
	codexBin?: string;
	/** Environment for the spawned app-server (default inherits process.env). */
	env?: NodeJS.ProcessEnv;
	/** Injectable spawn (tests). */
	spawn?: CodexSpawnFn;
	/** Skip the `codex --version` precheck (tests with injected transport). */
	skipDetect?: boolean;
	/**
	 * Explicit protocol override. Default is mode-aware: V2 for text/transcription
	 * and V3 for audio/conversational, matching Codex CLI 0.145 constraints.
	 */
	version?: "v1" | "v2" | "v3";
	/**
	 * Realtime media transport. `webrtc` is the ONLY transport the app-server
	 * accepts with ChatGPT/Codex OAuth; `websocket` (raw PCM over JSON-RPC)
	 * requires an OpenAI API key. Default: `webrtc` for audio/conversational,
	 * `websocket` for text/transcription (which has no media plane).
	 */
	realtimeTransport?: "websocket" | "webrtc";
	/** Injectable `@roamhq/wrtc` (tests). Production loads it lazily. */
	wrtc?: WrtcModule;
}

/**
 * Adapter that drives experimental `codex app-server` realtime (V2 text / V3
 * audio) and presents the same `RealtimeClientLike` surface as the OpenAI
 * Realtime WebSocket client.
 */
export class CodexAppServerBackend implements RealtimeClientLike {
	readonly #version?: "v1" | "v2" | "v3";
	readonly #codexBin: string;
	readonly #env: NodeJS.ProcessEnv;
	readonly #spawn?: CodexSpawnFn;
	readonly #injectedTransport?: CodexTransport;
	readonly #skipDetect: boolean;
	readonly #realtimeTransport?: "websocket" | "webrtc";
	readonly #wrtc?: WrtcModule;

	#transport: CodexTransport | undefined;
	#connected = false;
	#closed = false;
	#nextId = 1;
	#pending = new Map<number, PendingRequest>();
	#threadId: string | undefined;
	#listeners = new Map<string, Set<Handler>>();
	/** Active WebRTC media plane (audio/conversational over OAuth). */
	#media: CodexWebRtcMedia | undefined;

	/** Used to synthesize user speech.started/stopped (G2). */
	#userSpeaking = false;

	constructor(options: CodexAppServerBackendOptions = {}) {
		this.#version = options.version;
		this.#codexBin = options.codexBin ?? DEFAULT_CODEX_BIN;
		this.#env = options.env ?? process.env;
		this.#spawn = options.spawn;
		this.#injectedTransport = options.transport;
		this.#skipDetect = options.skipDetect ?? false;
		this.#realtimeTransport = options.realtimeTransport;
		this.#wrtc = options.wrtc;
	}

	/** True once `thread/realtime/started` has arrived. */
	get connected(): boolean {
		return this.#connected && !this.#closed;
	}

	async connect(
		authHeaders: Record<string, string>,
		config: unknown,
	): Promise<void> {
		if (this.#connected) return;

		const cfg = config as {
			model?: string;
			voice?: string;
			mode?: "transcription" | "conversational";
			sampleRate?: number;
		};

		// 1. CLI presence precheck (clear error instead of a cryptic spawn ENOENT).
		if (!this.#skipDetect && !this.#injectedTransport) {
			const detect = await detectCodexCli(
				this.#spawn ?? spawn,
				this.#codexBin,
				this.#env,
			);
			if (!detect.ok) {
				throw new CodexBackendError(
					"cli_missing",
					`codex backend requires the Codex CLI on PATH: ${detect.reason ?? "not found"}. ` +
						"Install Codex 0.145+ or set PI_VOICE_BACKEND=openai for the default OpenAI Realtime backend.",
				);
			}
		}

		// 2. Open the transport. With ChatGPT/Codex OAuth the app-server reads its
		// own ~/.codex/auth.json; resolved API-key credentials (if any) are forwarded
		// to the child environment as OPENAI_API_KEY for V2 text fallback.
		const transport =
			this.#injectedTransport ??
			this.#spawnTransport(this.#appServerEnv(authHeaders));
		this.#transport = transport;
		transport.onLine((line) => this.#handleLine(line));
		transport.onError((err) => this.#handleTransportError(err));
		transport.onClose(() => this.#handleTransportClose());

		try {
			// 3. JSON-RPC handshake: initialize → initialized → thread/start.
			await this.#request("initialize", {
				clientInfo: {
					name: "pi-live-voice",
					title: "pi-live voice extension",
					version: "0.1.0",
				},
				// `thread/realtime/*` is gated by this negotiated capability.
				capabilities: { experimentalApi: true },
			});
			this.#notify("initialized", {});
			const startRes = (await this.#request("thread/start", {})) as {
				thread?: { id?: string };
			};
			const threadId = startRes?.thread?.id;
			if (!threadId) {
				throw new CodexBackendError(
					"handshake",
					"thread/start returned no thread id",
				);
			}
			this.#threadId = threadId;

			// 4. Start realtime. Codex 0.145 requires V2 for text output; V3 is
			// used for full-duplex audio. An explicit test/compat override wins.
			const outputModality = cfg.mode === "conversational" ? "audio" : "text";
			const version =
				this.#version ?? (outputModality === "text" ? "v2" : "v3");

			// Media transport. WebRTC is the only OAuth-capable path; the WebSocket
			// PCM path needs an OpenAI API key. Text has no media plane.
			const wantWebRtc =
				(this.#realtimeTransport ??
					(outputModality === "audio" ? "webrtc" : "websocket")) === "webrtc";

			const realtimeParams: Record<string, unknown> = {
				threadId,
				outputModality,
				version,
			};
			// G8: a WebRTC realtime session is minted server-side from Codex's own
			// configuration, so it rejects a client-supplied model with
			// "Field `session.model` is not allowed for this Codex realtime session".
			// Only the WebSocket/API-key path accepts a model override.
			if (cfg.model && !wantWebRtc) realtimeParams.model = cfg.model;
			// V3 audio realtime rejects the OpenAI default `marin` and other unsupported
			// voice names; only forward a voice the server accepts, else let it pick a
			// default. V2 text tolerates any voice name (it produces no audio).
			if (
				cfg.voice &&
				(outputModality !== "audio" || CODEX_V3_VOICES.has(cfg.voice))
			) {
				realtimeParams.voice = cfg.voice;
			}

			if (wantWebRtc) {
				const media = new CodexWebRtcMedia({
					wrtc: this.#wrtc,
					micSampleRate: cfg.sampleRate ?? 24_000,
					outSampleRate: cfg.sampleRate ?? 24_000,
					onAudio: (base64) => {
						const ev: RealtimeAudioDeltaEvent = {
							delta: base64,
							itemId: undefined,
							timestamp: Date.now(),
						};
						this.#emit("audio.delta", ev);
					},
				});
				this.#media = media;
				// Non-trickle: the offer carries gathered ICE candidates.
				realtimeParams.transport = {
					type: "webrtc",
					sdp: await media.createOffer(),
				};
			}

			// Subscribe before sending: app-server can return the response and
			// started notification in the same stdout batch.
			const started = this.#waitForStarted();
			// Observe both promises together. If the request fails, teardown closes
			// the transport and rejects `started`; Promise.all keeps that secondary
			// rejection handled instead of escalating as an uncaughtException.
			await Promise.all([
				this.#request("thread/realtime/start", realtimeParams),
				started,
			]);
			this.#connected = true;
		} catch (err) {
			this.#closeMedia();
			this.#teardownTransport();
			if (err instanceof CodexBackendError) throw err;
			throw new CodexBackendError(
				"handshake",
				`codex realtime start failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	#appServerEnv(authHeaders: Record<string, string>): NodeJS.ProcessEnv {
		const entries = Object.entries(authHeaders);
		const chatgptAuth = entries.some(
			([key]) => key.toLowerCase() === "chatgpt-account-id",
		);
		if (chatgptAuth) return this.#env;

		const authorization = entries.find(
			([key]) => key.toLowerCase() === "authorization",
		)?.[1];
		const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
		return token ? { ...this.#env, OPENAI_API_KEY: token } : this.#env;
	}

	#spawnTransport(env: NodeJS.ProcessEnv): CodexTransport {
		if (!this.#spawn) {
			// Production default — real child_process.spawn.
			return new StdioCodexTransport(spawn, this.#codexBin, env);
		}
		return new StdioCodexTransport(this.#spawn, this.#codexBin, env);
	}

	#teardownTransport(): void {
		const t = this.#transport;
		this.#transport = undefined;
		this.#pending.clear();
		try {
			t?.close();
		} catch {
			// ignore
		}
	}

	/** Resolve when `thread/realtime/started` arrives (or reject on error/closed). */
	#waitForStarted(): Promise<void> {
		return new Promise((resolve, reject) => {
			const offStarted = this.#onInternal("thread/realtime/started", () => {
				offStarted();
				offError();
				offClosed();
				resolve();
			});
			const offError = this.#onInternal("thread/realtime/error", (ev) => {
				offStarted();
				offError();
				offClosed();
				const msg = (ev as { message?: string })?.message ?? "realtime error";
				reject(
					new CodexBackendError(
						"no_realtime",
						`codex realtime rejected start: ${msg}`,
					),
				);
			});
			const offClosed = this.#onInternal("__transport_closed__", () => {
				offStarted();
				offError();
				offClosed();
				reject(
					new CodexBackendError(
						"not_running",
						"codex app-server closed before realtime started " +
							"(is Codex logged in / realtime supported?)",
					),
				);
			});
		});
	}

	appendAudio(pcm16Base64OrBuffer: string | Uint8Array): void {
		if (!this.#connected || !this.#threadId) return;
		// WebRTC path: mic PCM goes into the RTP audio track, not JSON-RPC.
		const media = this.#media;
		if (media) {
			const bytes =
				typeof pcm16Base64OrBuffer === "string"
					? new Uint8Array(Buffer.from(pcm16Base64OrBuffer, "base64"))
					: pcm16Base64OrBuffer;
			media.feedMicBytes(bytes);
			return;
		}
		const data =
			typeof pcm16Base64OrBuffer === "string"
				? pcm16Base64OrBuffer
				: Buffer.from(
						pcm16Base64OrBuffer.buffer,
						pcm16Base64OrBuffer.byteOffset,
						pcm16Base64OrBuffer.byteLength,
					).toString("base64");
		// Fire-and-forget; app-server returns {}. Failures surface via error/closed.
		void this.#request("thread/realtime/appendAudio", {
			threadId: this.#threadId,
			audio: {
				data,
				sampleRate: 24_000,
				numChannels: 1,
			},
		}).catch(() => undefined);
	}

	#closeMedia(): void {
		const media = this.#media;
		this.#media = undefined;
		try {
			media?.close();
		} catch {
			// ignore
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#connected = false;
		const tid = this.#threadId;
		// Best-effort stop; don't wait.
		if (tid) {
			void this.#request("thread/realtime/stop", { threadId: tid }).catch(
				() => undefined,
			);
		}
		this.#closeMedia();
		this.#teardownTransport();
		// Let session reconnect/stop listeners see a normal close.
		this.#emit("close", { code: 1000, reason: "client close" });
	}

	on(event: string, handler: Handler): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(handler);
		return () => {
			set?.delete(handler);
		};
	}

	/**
	 * Best-effort NO-OP (G5). Codex realtime has no single-message
	 * `session.update` equivalent; the session was started with the right
	 * modality at connect. A live mode switch needs `/voice stop`+`start`.
	 */
	updateSession(_partial: unknown): void {
		// Intentionally ignored — see G5 in the file header.
	}

	// ── internals ────────────────────────────────────────────────────────

	#request(method: string, params: unknown): Promise<unknown> {
		const transport = this.#transport;
		if (!transport) {
			return Promise.reject(
				new CodexBackendError("closed", "transport not open"),
			);
		}
		const id = this.#nextId++;
		const msg = JSON.stringify({ method, id, params });
		return new Promise((resolve, reject) => {
			this.#pending.set(id, {
				method,
				resolve,
				reject,
			});
			try {
				transport.send(msg);
			} catch (err) {
				this.#pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	#notify(method: string, params: unknown): void {
		const transport = this.#transport;
		if (!transport) return;
		try {
			transport.send(JSON.stringify({ method, params }));
		} catch {
			// notifications are best-effort
		}
	}

	/** Internal listener channel (separate from RealtimeClientLike `on()`). */
	#onInternal(event: string, handler: Handler): () => void {
		return this.on(event, handler);
	}

	#emit(event: string, ...args: unknown[]): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const h of set) {
			try {
				h(...args);
			} catch {
				// listener errors must not break the backend
			}
		}
	}

	#handleLine(line: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// Ignore malformed lines (log chatter from the child, etc.).
			return;
		}

		// JSON-RPC response (has `id` + `result`/`error`).
		if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
			const pending = this.#pending.get(msg.id);
			if (!pending) return;
			this.#pending.delete(msg.id);
			if (msg.error) {
				const err = msg.error as { code?: number; message?: string };
				pending.reject(
					new Error(
						`${pending.method} error: ${err.message ?? JSON.stringify(msg.error)}`,
					),
				);
			} else {
				pending.resolve(msg.result);
			}
			return;
		}

		// JSON-RPC notification (has `method`, no `id`).
		const method = typeof msg.method === "string" ? msg.method : undefined;
		if (!method) return;
		const params = (msg.params ?? {}) as Record<string, unknown>;
		this.#dispatchNotification(method, params);
	}

	#dispatchNotification(method: string, params: Record<string, unknown>): void {
		// Internal handshake channels first.
		this.#emit(method, params);

		switch (method) {
			case "thread/realtime/started": {
				this.#connected = true;
				this.#emit("session.created", params);
				break;
			}
			case "thread/realtime/transcript/delta": {
				const role = typeof params.role === "string" ? params.role : "user";
				const delta = typeof params.delta === "string" ? params.delta : "";
				if (!delta) break;
				const te: TranscriptEvent = {
					type: "partial",
					text: delta,
					timestamp: Date.now(),
				};
				if (role === "assistant") {
					this.#emit("assistant_transcript.delta", te);
				} else {
					// G2: synthesize user speech.started on the first user delta.
					if (!this.#userSpeaking) {
						this.#userSpeaking = true;
						this.#emit("speech.started", {
							type: "speech_started",
							text: "",
							timestamp: Date.now(),
						});
					}
					this.#emit("transcript.delta", te);
				}
				break;
			}
			case "thread/realtime/transcript/done": {
				const role = typeof params.role === "string" ? params.role : "user";
				const text = typeof params.text === "string" ? params.text : "";
				const te: TranscriptEvent = {
					type: "final",
					text,
					timestamp: Date.now(),
				};
				if (role === "assistant") {
					this.#emit("assistant_transcript.done", te);
					// G3: no documented outputAudio/done; finalize playback here.
					this.#emit("audio.done", {
						itemId: undefined,
						timestamp: Date.now(),
					});
				} else {
					this.#emit("transcript.done", te);
					// G2: synthesize speech.stopped on user transcript done.
					if (this.#userSpeaking) {
						this.#userSpeaking = false;
						this.#emit("speech.stopped", {
							type: "speech_stopped",
							text: "",
							timestamp: Date.now(),
						});
					}
				}
				break;
			}
			case "thread/realtime/outputAudio/delta": {
				const audio = params.audio as
					| { data?: string; itemId?: string }
					| undefined;
				if (!audio?.data) break;
				const ev: RealtimeAudioDeltaEvent = {
					delta: audio.data,
					itemId: audio.itemId,
					timestamp: Date.now(),
				};
				this.#emit("audio.delta", ev);
				break;
			}
			case "thread/realtime/error": {
				const message =
					typeof params.message === "string"
						? params.message
						: "codex realtime error";
				this.#emit("error", { message, raw: params });
				break;
			}
			case "thread/realtime/closed": {
				const reason =
					typeof params.reason === "string" ? params.reason : undefined;
				this.#emit("close", {
					code: 1000,
					reason: reason ?? "thread/realtime/closed",
				});
				break;
			}
			case "thread/realtime/sdp": {
				// WebRTC answer from the app-server; completes the media handshake.
				const sdp = typeof params.sdp === "string" ? params.sdp : undefined;
				const media = this.#media;
				if (!sdp || !media) break;
				void media.setAnswer(sdp).catch((err: unknown) => {
					this.#emit("error", {
						message: `codex WebRTC answer rejected: ${err instanceof Error ? err.message : String(err)}`,
						raw: err,
					});
				});
				break;
			}
			default:
			// Unknown notifications (incl. itemAdded) are surfaced via
			// the raw internal channel above; no typed mapping yet.
		}
	}

	#handleTransportError(err: Error): void {
		if (!this.#connected && !this.#closed) {
			// During handshake — reject any pending waiters via closed.
			this.#emit("__transport_closed__", undefined);
		}
		this.#emit("error", {
			message: `codex app-server transport error: ${err.message}`,
			raw: err,
		});
	}

	#handleTransportClose(): void {
		const wasConnected = this.#connected;
		this.#closeMedia();
		this.#connected = false;
		// Reject pending requests so connect() doesn't hang forever.
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		for (const p of pending) {
			p.reject(new CodexBackendError("closed", "transport closed"));
		}
		// During handshake, unblock #waitForStarted.
		if (!wasConnected && !this.#closed) {
			this.#emit("__transport_closed__", undefined);
			return;
		}
		// After a live session, surface an unexpected close so the session
		// reconnect/stop path can react.
		this.#emit("close", { code: 1006, reason: "codex app-server exited" });
	}
}
