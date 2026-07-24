/**
 * Voice session state machine (VS5 / issue #12).
 *
 * Wires auth + realtime client + mic capture + pi bridge into a working
 * transcription loop. Public API surface leaves hooks for later slices
 * (playback #13, conversational #14): onTranscript, onStateChange,
 * setCapturePaused.
 *
 * State machine: idle → connecting → listening → stopping → idle (+ error)
 */

import { resolveVoiceAuth, VoiceAuthError } from "./auth.js";
import {
	deliverVoiceText,
	type DeliverVoiceTextCallOptions,
	type VoiceBridgePi,
} from "./bridge.js";
import { MicCapture } from "./capture.js";
import { loadVoiceConfig, type VoiceConfig } from "./config.js";
import {
	connectConfigFromVoice,
	RealtimeClient,
	type RealtimeClientError,
} from "./realtime-client.js";
import type {
	MicCaptureLike,
	RealtimeClientLike,
	TranscriptEvent,
	VoiceAuth,
	VoiceAuthMode,
	VoiceSessionState,
	VoiceSessionStatus,
} from "./types.js";

/** Minimal UI surface used for footer + notifications. */
export interface VoiceSessionUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus?(key: string, text: string | undefined): void;
	/** Optional one-line partial transcript widget above the editor. */
	setWidget?(key: string, content: string[] | undefined): void;
}

/** Options accepted by {@link VoiceSession.start}. */
export interface VoiceSessionStartOptions {
	/** Pi API used to inject final transcripts. Required for bridge delivery. */
	pi?: VoiceBridgePi;
	/** Returns true when the agent is idle (not streaming). */
	isIdle?: () => boolean;
	/** UI for footer setStatus / notify; retained for later updates. */
	ui?: VoiceSessionUi;
}

/** Injectable collaborators — production defaults use the real modules. */
export interface VoiceSessionDeps {
	config?: VoiceConfig;
	resolveAuth?: (options: {
		prefer?: VoiceConfig["auth"];
		codexHome?: string;
		apiKey?: string;
	}) => Promise<VoiceAuth>;
	createClient?: () => RealtimeClientLike;
	createCapture?: (sampleRate: number) => MicCaptureLike;
	deliverText?: (
		pi: VoiceBridgePi,
		text: string,
		opts?: DeliverVoiceTextCallOptions,
	) => void;
}

type Unsubscribe = () => void;
type StateChangeHandler = (
	state: VoiceSessionState,
	prev: VoiceSessionState,
) => void;
type TranscriptHandler = (event: TranscriptEvent) => void;

const LIVE_STATES: ReadonlySet<VoiceSessionState> = new Set([
	"connecting",
	"listening",
	"stopping",
]);

/** PCM16 amplitude ≈ silence below this (int16 units, abs). */
const SILENCE_ABS = 200;
/** Throttle footer refreshes while streaming mic levels. */
const LEVEL_UI_MIN_MS = 250;

function errorMessage(err: unknown): string {
	if (err instanceof VoiceAuthError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

export class VoiceSession {
	readonly #config: VoiceConfig;
	readonly #resolveAuth: NonNullable<VoiceSessionDeps["resolveAuth"]>;
	readonly #createClient: NonNullable<VoiceSessionDeps["createClient"]>;
	readonly #createCapture: NonNullable<VoiceSessionDeps["createCapture"]>;
	readonly #deliverText: NonNullable<VoiceSessionDeps["deliverText"]>;

	#state: VoiceSessionState = "idle";
	#error: string | undefined;
	#authMode: VoiceAuthMode | undefined;
	#capturePaused = false;
	#agentBusy = false;
	/** Monotonic generation — invalidates in-flight start/stop work. */
	#generation = 0;

	#client: RealtimeClientLike | undefined;
	#capture: MicCaptureLike | undefined;
	#unsubs: Unsubscribe[] = [];

	#pi: VoiceBridgePi | undefined;
	#isIdle: (() => boolean) | undefined;
	#ui: VoiceSessionUi | undefined;

	/** Server VAD: user is currently speaking. */
	#hearing = false;
	/** Accumulated partial transcript for the current utterance. */
	#partial = "";
	/** Mic chunks observed since last start (proves capture path). */
	#audioChunks = 0;
	/** Smoothed 0–1 level from recent PCM. */
	#audioLevel = 0;
	#lastLevelUiAt = 0;
	#hadAudible = false;

	readonly #stateHandlers = new Set<StateChangeHandler>();
	readonly #transcriptHandlers = new Set<TranscriptHandler>();

	constructor(deps: VoiceSessionDeps = {}) {
		this.#config = deps.config ?? loadVoiceConfig();
		this.#resolveAuth =
			deps.resolveAuth ??
			((options) =>
				resolveVoiceAuth({
					prefer: options.prefer,
					codexHome: options.codexHome,
					apiKey: options.apiKey,
				}));
		this.#createClient = deps.createClient ?? (() => new RealtimeClient());
		this.#createCapture =
			deps.createCapture ?? ((sampleRate) => new MicCapture({ sampleRate }));
		this.#deliverText = deps.deliverText ?? deliverVoiceText;
	}

	/** Current lifecycle state. */
	getState(): VoiceSessionState {
		return this.#state;
	}

	/** True while connecting / listening / stopping. */
	isLive(): boolean {
		return LIVE_STATES.has(this.#state);
	}

	/** Short status string suitable for `/voice status` and footer setStatus. */
	getStatus(): string {
		if (this.#state === "error" && this.#error) {
			return `error: ${this.#error}`;
		}
		if (this.#state === "listening" && this.#capturePaused) {
			return "pi working…";
		}
		if (this.#state === "listening") {
			const partial = this.#partial.trim();
			if (partial) {
				return `hearing: ${truncate(partial, 48)}`;
			}
			if (this.#hearing) {
				return "hearing…";
			}
			if (this.#audioChunks === 0) {
				return "● listening · waiting for mic…";
			}
			if (!this.#hadAudible) {
				// Chunks flowing but near-zero PCM — almost always OS mic permission
				// or the wrong/muted default input device (not a "not listening" bug).
				if (this.#audioChunks >= 30) {
					return "● listening · mic silent (check macOS Mic privacy / input device)";
				}
				return `● listening · mic silent? (lvl ${levelPct(this.#audioLevel)})`;
			}
			return `● listening · lvl ${levelPct(this.#audioLevel)}`;
		}
		if (this.#state === "connecting") {
			return "connecting…";
		}
		if (this.#state === "stopping") {
			return "stopping…";
		}
		return this.#state;
	}

	/** Full status snapshot (no secrets). */
	getStatusInfo(): VoiceSessionStatus {
		return {
			state: this.#state,
			status: this.getStatus(),
			mode: this.#config.mode,
			auth: this.#config.auth,
			authMode: this.#authMode,
			model: this.#config.model,
			voice: this.#config.voice,
			sampleRate: this.#config.sampleRate,
			capturePaused: this.#capturePaused,
			hearing: this.#hearing,
			partial: this.#partial || undefined,
			audioChunks: this.#audioChunks,
			audioLevel: this.#audioLevel,
			error: this.#error,
		};
	}

	/** Config used by this session (read-only view). */
	getConfig(): Readonly<VoiceConfig> {
		return this.#config;
	}

	/**
	 * Subscribe to lifecycle state transitions.
	 * Hook for later slices (#13 playback, #14 conversational).
	 */
	onStateChange(handler: StateChangeHandler): Unsubscribe {
		this.#stateHandlers.add(handler);
		return () => {
			this.#stateHandlers.delete(handler);
		};
	}

	/**
	 * Subscribe to transcript events (partial + final + speech markers).
	 * Hook for later slices (partial widget, conversational tools).
	 */
	onTranscript(handler: TranscriptHandler): Unsubscribe {
		this.#transcriptHandlers.add(handler);
		return () => {
			this.#transcriptHandlers.delete(handler);
		};
	}

	/**
	 * Gate mic audio without tearing down capture or the WS.
	 * Used on `agent_start` to reduce self-noise while pi is working;
	 * also a hook for playback self-echo mitigation (#13).
	 */
	setCapturePaused(paused: boolean): void {
		if (this.#capturePaused === paused) return;
		this.#capturePaused = paused;
		this.#pushUiStatus();
	}

	/** Whether mic chunks are currently gated. */
	isCapturePaused(): boolean {
		return this.#capturePaused;
	}

	/**
	 * Track agent busy state for bridge idle/busy delivery.
	 * Prefer this when `ctx.isIdle` is not available (e.g. event handlers).
	 */
	setAgentBusy(busy: boolean): void {
		this.#agentBusy = busy;
		if (busy) {
			this.setCapturePaused(true);
		} else if (this.#state === "listening") {
			this.setCapturePaused(false);
		}
	}

	/** Retain a UI handle for footer updates outside command handlers. */
	bindUi(ui: VoiceSessionUi | undefined): void {
		this.#ui = ui;
	}

	/**
	 * Start the transcription loop.
	 * No-op (resolves) when already connecting/listening.
	 */
	async start(options: VoiceSessionStartOptions = {}): Promise<void> {
		if (this.#state === "connecting" || this.#state === "listening") {
			this.#ui = options.ui ?? this.#ui;
			this.#pi = options.pi ?? this.#pi;
			this.#isIdle = options.isIdle ?? this.#isIdle;
			this.#notify("voice already running", "info");
			this.#pushUiStatus();
			return;
		}

		// Allow restart from error/idle/stopping.
		if (this.#state === "stopping") {
			// Wait out the in-flight stop via generation bump below.
		}

		const gen = ++this.#generation;
		this.#pi = options.pi ?? this.#pi;
		this.#isIdle = options.isIdle ?? this.#isIdle;
		this.#ui = options.ui ?? this.#ui;
		this.#error = undefined;
		this.#authMode = undefined;
		this.#capturePaused = false;
		this.#resetHearingState();
		this.#setState("connecting");
		this.#pushUiStatus();

		let client: RealtimeClientLike | undefined;
		let capture: MicCaptureLike | undefined;

		try {
			const auth = await this.#resolveAuth({
				prefer: this.#config.auth,
				codexHome: this.#config.codexHome,
				apiKey: this.#config.apiKey,
			});
			if (gen !== this.#generation) return;

			this.#authMode = auth.mode;

			client = this.#createClient();
			this.#client = client;
			this.#wireClient(client, gen);

			await client.connect(auth.headers, connectConfigFromVoice(this.#config));
			if (gen !== this.#generation) {
				this.#clearClientSubs();
				this.#client = undefined;
				client.close();
				return;
			}

			capture = this.#createCapture(this.#config.sampleRate);
			this.#capture = capture;
			await capture.start((pcm) => {
				if (gen !== this.#generation) return;
				if (this.#state !== "listening") return;
				// Always sample mic health (even while paused).
				this.#noteAudio(pcm);
				if (this.#capturePaused) return;
				const active = this.#client;
				if (!active) return;
				try {
					active.appendAudio(pcm);
				} catch {
					// Drop chunk on transient send failure; close handler recovers.
				}
			});
			if (gen !== this.#generation) {
				this.#clearClientSubs();
				this.#client = undefined;
				this.#capture = undefined;
				await capture.stop().catch(() => undefined);
				client.close();
				return;
			}

			this.#setState("listening");
			this.#notify(
				`voice listening (${auth.mode} · ${this.#config.mode}) — speak anytime; footer shows hearing/partials`,
				"info",
			);
			this.#pushUiStatus();
		} catch (err) {
			if (gen !== this.#generation) return;
			const message = errorMessage(err);
			this.#clearClientSubs();
			this.#client = undefined;
			this.#capture = undefined;
			await this.#teardownResources(client, capture);
			this.#authMode = undefined;
			this.#capturePaused = false;
			this.#resetHearingState();
			this.#error = message;
			this.#setState("error");
			this.#notify(`voice error: ${message}`, "error");
			this.#pushUiStatus();
			// Return to idle after surfacing the error so `/voice start` can retry.
			this.#setState("idle");
			throw err instanceof Error ? err : new Error(message);
		}
	}

	/**
	 * Stop capture + WS and return to idle.
	 * Idempotent when already idle.
	 */
	async stop(): Promise<void> {
		if (this.#state === "idle" && !this.#client && !this.#capture) {
			this.#notify("voice already stopped", "info");
			this.#pushUiStatus(true);
			return;
		}

		const gen = ++this.#generation;
		this.#setState("stopping");
		this.#pushUiStatus();

		const client = this.#client;
		const capture = this.#capture;
		this.#client = undefined;
		this.#capture = undefined;
		this.#clearClientSubs();

		await this.#teardownResources(client, capture);
		if (gen !== this.#generation) return;

		this.#authMode = undefined;
		this.#capturePaused = false;
		this.#resetHearingState();
		this.#error = undefined;
		this.#setState("idle");
		this.#notify("voice stopped", "info");
		this.#pushUiStatus(true);
	}

	/**
	 * Toggle: start when idle/error, stop when live.
	 * @returns the action taken
	 */
	async toggle(
		options: VoiceSessionStartOptions = {},
	): Promise<"started" | "stopped"> {
		if (this.#state === "listening" || this.#state === "connecting") {
			await this.stop();
			return "stopped";
		}
		await this.start(options);
		return "started";
	}

	// ── internals ────────────────────────────────────────────────────

	#setState(next: VoiceSessionState): void {
		const prev = this.#state;
		if (prev === next) return;
		this.#state = next;
		for (const handler of this.#stateHandlers) {
			try {
				handler(next, prev);
			} catch {
				// listener errors must not break the session
			}
		}
	}

	#wireClient(client: RealtimeClientLike, gen: number): void {
		this.#clearClientSubs();

		const onDone = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			const event = args[0] as TranscriptEvent | undefined;
			if (!event) return;
			this.#hearing = false;
			this.#partial = "";
			this.#emitTranscript(event);
			this.#handleFinalTranscript(event);
			this.#pushUiStatus();
			this.#pushPartialWidget();
		};
		const onDelta = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			const event = args[0] as TranscriptEvent | undefined;
			if (!event) return;
			// Deltas are incremental; accumulate for the footer line.
			const piece = event.text ?? "";
			if (piece) {
				this.#partial = `${this.#partial}${piece}`;
				this.#hearing = true;
			}
			this.#emitTranscript({
				...event,
				text: this.#partial,
			});
			this.#pushUiStatus();
			this.#pushPartialWidget();
		};
		const onSpeech = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			const event = args[0] as TranscriptEvent | undefined;
			if (!event) return;
			if (event.type === "speech_started") {
				this.#hearing = true;
				this.#partial = "";
				this.#notify("voice: hearing you…", "info");
			} else if (event.type === "speech_stopped") {
				this.#hearing = false;
				// Keep partial until final arrives.
			}
			this.#emitTranscript(event);
			this.#pushUiStatus();
			this.#pushPartialWidget();
		};
		const onError = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			const err = args[0] as RealtimeClientError | undefined;
			const message = err?.message ?? "realtime error";
			this.#error = message;
			this.#notify(`voice error: ${message}`, "error");
			// Stay listening if possible; hard close is handled below.
			this.#pushUiStatus();
		};
		const onClose = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			// Unexpected close while live → surface and reset.
			if (this.#state === "listening" || this.#state === "connecting") {
				const info = args[0] as
					| { code?: number; reason?: string }
					| undefined;
				const reason = info?.reason?.trim();
				const message = reason
					? `connection closed (${info?.code ?? "?"}: ${reason})`
					: `connection closed (${info?.code ?? "?"})`;
				void this.#handleUnexpectedClose(message, gen);
			}
		};

		const unsubs: Unsubscribe[] = [];
		const sub = (event: string, handler: (...args: unknown[]) => void) => {
			const off = client.on(event, handler);
			if (typeof off === "function") {
				unsubs.push(off);
			}
		};

		sub("transcript.done", onDone);
		sub("transcript.delta", onDelta);
		sub("speech.started", onSpeech);
		sub("speech.stopped", onSpeech);
		sub("error", onError);
		sub("close", onClose);
		this.#unsubs = unsubs;
	}

	#clearClientSubs(): void {
		for (const off of this.#unsubs) {
			try {
				off();
			} catch {
				// ignore
			}
		}
		this.#unsubs = [];
	}

	#emitTranscript(event: TranscriptEvent): void {
		for (const handler of this.#transcriptHandlers) {
			try {
				handler(event);
			} catch {
				// listener errors must not break the session
			}
		}
	}

	#handleFinalTranscript(event: TranscriptEvent): void {
		const text = event.text?.trim() ?? "";
		if (!text) return;

		const pi = this.#pi;
		if (!pi) {
			this.#notify(
				`voice transcript (no bridge): ${truncate(text, 80)}`,
				"warning",
			);
			return;
		}

		try {
			this.#deliverText(pi, text, {
				isIdle: () => this.#probeIdle(),
			});
			this.#notify(`voice → pi: ${truncate(text, 60)}`, "info");
		} catch (err) {
			this.#notify(`voice bridge failed: ${errorMessage(err)}`, "error");
		}
	}

	#probeIdle(): boolean {
		if (this.#isIdle) {
			try {
				return this.#isIdle();
			} catch {
				// fall through
			}
		}
		return !this.#agentBusy;
	}

	async #handleUnexpectedClose(message: string, gen: number): Promise<void> {
		if (gen !== this.#generation) return;
		this.#generation++;
		const client = this.#client;
		const capture = this.#capture;
		this.#client = undefined;
		this.#capture = undefined;
		this.#clearClientSubs();
		await this.#teardownResources(client, capture);
		this.#error = message;
		this.#authMode = undefined;
		this.#capturePaused = false;
		this.#resetHearingState();
		this.#setState("error");
		this.#notify(`voice error: ${message}`, "error");
		this.#pushUiStatus();
		this.#setState("idle");
		this.#pushUiStatus(true);
	}

	async #teardownResources(
		client: RealtimeClientLike | undefined,
		capture: MicCaptureLike | undefined,
	): Promise<void> {
		if (capture) {
			try {
				await capture.stop();
			} catch {
				// ignore stop failures during teardown
			}
		}
		if (client) {
			try {
				client.close();
			} catch {
				// ignore
			}
		}
	}

	#notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		try {
			this.#ui?.notify(message, type);
		} catch {
			// UI optional
		}
	}

	#resetHearingState(): void {
		this.#hearing = false;
		this.#partial = "";
		this.#audioChunks = 0;
		this.#audioLevel = 0;
		this.#lastLevelUiAt = 0;
		this.#hadAudible = false;
		this.#pushPartialWidget(true);
	}

	#noteAudio(pcm: Uint8Array): void {
		this.#audioChunks += 1;
		const level = pcmLevel01(pcm);
		// Light EMA so the footer isn't jumpy.
		this.#audioLevel = this.#audioLevel * 0.7 + level * 0.3;
		if (level > 0.02) this.#hadAudible = true;
		const now = Date.now();
		if (now - this.#lastLevelUiAt >= LEVEL_UI_MIN_MS) {
			this.#lastLevelUiAt = now;
			// Only refresh footer for levels when not already showing speech text.
			if (!this.#hearing && !this.#partial) {
				this.#pushUiStatus();
			}
		}
	}

	#pushPartialWidget(clear = false): void {
		const ui = this.#ui;
		if (!ui?.setWidget) return;
		try {
			if (clear || !this.#partial.trim()) {
				ui.setWidget("voice-partial", undefined);
				return;
			}
			ui.setWidget("voice-partial", [
				`voice ▸ ${truncate(this.#partial.trim(), 100)}`
			]);
		} catch {
			// UI optional
		}
	}

	/**
	 * Push footer status. When `clear` is set and state is idle, remove the key.
	 */
	#pushUiStatus(clear = false): void {
		const ui = this.#ui;
		if (!ui?.setStatus) return;
		try {
			if (clear && this.#state === "idle") {
				ui.setStatus("voice", undefined);
				this.#pushPartialWidget(true);
				return;
			}
			ui.setStatus("voice", `voice: ${this.getStatus()}`);
		} catch {
			// UI optional
		}
	}
}
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function levelPct(level: number): string {
	const pct = Math.max(0, Math.min(100, Math.round(level * 100)));
	return `${pct}%`;
}

/** Rough 0–1 peak level from PCM16 LE mono bytes. */
function pcmLevel01(pcm: Uint8Array): number {
	if (pcm.byteLength < 2) return 0;
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let peak = 0;
	// Subsample for cheap metering.
	const step = Math.max(2, Math.floor(pcm.byteLength / 64) * 2);
	for (let i = 0; i + 1 < pcm.byteLength; i += step) {
		const s = Math.abs(view.getInt16(i, true));
		if (s > peak) peak = s;
	}
	if (peak < SILENCE_ABS) return 0;
	return Math.min(1, peak / 32768);
}

/** Process-wide session for the `/voice` command. */
let sharedSession: VoiceSession | undefined;

export function getSharedVoiceSession(): VoiceSession {
	if (!sharedSession) {
		sharedSession = new VoiceSession();
	}
	return sharedSession;
}

/** Test helper — resets the shared session. */
export function resetSharedVoiceSession(): void {
	sharedSession = undefined;
}
