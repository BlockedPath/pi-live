/**
 * Voice session state machine (VS5–VS8 / issues #12–#15).
 *
 * Wires auth + realtime client + mic capture + pi bridge into a working
 * transcription loop. VS6 adds optional speak-back via `playback.ts` on
 * `speakBack()`, coordinated with `setCapturePaused` for echo reduction.
 * VS7 adds transcript widget polish, prefs, reconnect / 60m session limit,
 * and a short post-TTS echo guard.
 * VS8 adds conversational mode: Realtime audio out + narrow `pi_turn` tool
 * that delegates coding to pi and returns function_call_output.
 *
 * Public hooks: onTranscript, onStateChange, setCapturePaused, applyPrefs,
 * setMode, notifyAgentSettled.
 *
 * State machine: idle → connecting → listening → stopping → idle (+ error)
 */
import { spawn } from "node:child_process";

import { resolveVoiceAuth, VoiceAuthError } from "./auth.js";
import {
	deliverVoiceText,
	type DeliverVoiceTextCallOptions,
	type VoiceBridgePi,
} from "./bridge.js";
import { MicCapture } from "./capture.js";
import { loadVoiceConfig, type VoiceConfig } from "./config.js";
import {
	PcmStreamPlayer,
	VoicePlayback,
	type SpawnFn,
	type TtsBackend,
	type VoicePlaybackOptions,
} from "./playback.js";
import {
	voiceStateFromFields,
	type VoiceStatePrefs,
} from "./prefs.js";
import {
	buildDefaultSessionConfig,
	connectConfigFromVoice,
	RealtimeClient,
	type RealtimeAudioDeltaEvent,
	type RealtimeClientError,
} from "./realtime-client.js";
import type {
	FunctionCallEvent,
	MicCaptureLike,
	RealtimeClientLike,
	TranscriptEvent,
	VoiceAuth,
	VoiceAuthMode,
	VoiceMode,
	VoiceSessionState,
	VoiceSessionStatus,
} from "./types.js";

/** Minimal UI surface used for footer + notifications. */
export interface VoiceSessionUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus?(key: string, text: string | undefined): void;
	/** Optional transcript widget above the editor. */
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
	createCapture?: (opts: { sampleRate: number; device?: string }) => MicCaptureLike;
	deliverText?: (
		pi: VoiceBridgePi,
		text: string,
		opts?: DeliverVoiceTextCallOptions,
	) => void;
	/** Override Herdr relay (tests). Default: `herdr agent prompt <target> <text>`. */
	relayText?: (target: string, text: string) => void;
	/** Override / inject TTS playback (tests). */
	createPlayback?: (options: VoicePlaybackOptions) => VoicePlayback;
	/** Injectable spawn for default playback (tests). */
	spawn?: SpawnFn;
	/**
	 * Injectable delay (tests). Defaults to `setTimeout`.
	 * Used for reconnect backoff and echo-guard hold-off.
	 */
	delay?: (ms: number) => Promise<void>;
	/**
	 * Injectable timer scheduler (tests). Defaults to `setTimeout`/`clearTimeout`.
	 * Used for the 60-minute session refresh and final-widget clear.
	 */
	scheduler?: {
		set: (fn: () => void, ms: number) => unknown;
		clear: (id: unknown) => void;
	};
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
/** How long a final transcript stays visible in the widget. */
const FINAL_WIDGET_MS = 4_000;
/** Brief mic hold-off after TTS so speaker tail is not transcribed. */
const ECHO_GUARD_AFTER_TTS_MS = 350;
/** Max automatic WS reconnect attempts after an unexpected drop. */
const MAX_RECONNECT_ATTEMPTS = 3;
/** Base delay between reconnect attempts (multiplied by attempt #). */
const RECONNECT_BASE_DELAY_MS = 700;
/**
 * Proactively refresh the Realtime session before OpenAI's ~60-minute
 * connection limit. 55 minutes leaves headroom for auth + handshake.
 */
const SESSION_LIMIT_REFRESH_MS = 55 * 60 * 1000;
/** Max wait for pi agent_settled while handling a pi_turn tool call. */
const PI_TURN_TIMEOUT_MS = 180_000;
/**
 * Min mic level (0–1) for local barge-in while the assistant is talking.
 * Tuned below typical close-talk speech; echo floor is tracked separately.
 */
const BARGE_IN_LEVEL = 0.04;
/** Ignore barge-in this long after assistant audio begins (echo settle). */
const BARGE_IN_GRACE_MS = 280;
/** Consecutive loud capture ticks required before cutting the assistant. */
const BARGE_IN_SUSTAIN = 3;

function errorMessage(err: unknown): string {
	if (err instanceof VoiceAuthError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

function defaultDelay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		// Don't keep the process alive for reconnect/echo timers alone.
		(t as NodeJS.Timeout).unref?.();
	});
}

const defaultScheduler = {
	set: (fn: () => void, ms: number): unknown => {
		const t = setTimeout(fn, ms);
		(t as NodeJS.Timeout).unref?.();
		return t;
	},
	clear: (id: unknown): void => {
		if (id !== undefined && id !== null) clearTimeout(id as NodeJS.Timeout);
	},
};

export class VoiceSession {
	/** Mutable so prefs restore / future `/voice` knobs can update it. */
	#config: VoiceConfig;
	readonly #resolveAuth: NonNullable<VoiceSessionDeps["resolveAuth"]>;
	readonly #createClient: NonNullable<VoiceSessionDeps["createClient"]>;
	readonly #createCapture: NonNullable<VoiceSessionDeps["createCapture"]>;
	readonly #deliverText: NonNullable<VoiceSessionDeps["deliverText"]>;
	readonly #relayText: NonNullable<VoiceSessionDeps["relayText"]>;
	readonly #playback: VoicePlayback;
	readonly #delay: (ms: number) => Promise<void>;
	readonly #scheduler: {
		set: (fn: () => void, ms: number) => unknown;
		clear: (id: unknown) => void;
	};

	#state: VoiceSessionState = "idle";
	#error: string | undefined;
	#authMode: VoiceAuthMode | undefined;
	#capturePaused = false;
	#agentBusy = false;
	#speaking = false;
	/** Monotonic generation — invalidates in-flight start/stop/reconnect work. */
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
	/** Last final transcript (briefly shown in the widget). */
	#lastFinal = "";
	#lastFinalAt = 0;
	/** Mic chunks observed since last start (proves capture path). */
	#audioChunks = 0;
	/** Smoothed 0–1 level from recent PCM. */
	#audioLevel = 0;
	#lastLevelUiAt = 0;
	#hadAudible = false;
	#captureBackend: string | undefined;

	/** Soft-reconnect bookkeeping. */
	#reconnecting = false;
	#reconnectAttempts = 0;
	#sessionLimitTimer: unknown;
	#echoGuardTimer: unknown;
	#finalWidgetTimer: unknown;

	/** Realtime PCM out (conversational mode). */
	#pcmOut: PcmStreamPlayer;
	/** Waiters for agent_settled during pi_turn. */
	#settledWaiters: Array<{
		resolve: (summary: string) => void;
		gen: number;
	}> = [];
	/** In-flight pi_turn call ids (dedupe / status). */
	#activePiTurns = 0;
	/** Realtime model response currently in flight (audio / tools). */
	#responseActive = false;
	/** Latest assistant item id for truncate on barge-in. */
	#assistantItemId: string | undefined;
	/** Date.now() when assistant audio last started (echo grace). */
	#assistantAudioAt = 0;
	/** Mic level baseline sampled as assistant audio starts (echo reference). */
	#echoFloor = 0;
	/** Sustained loud ticks while assistant is hot (local barge-in). */
	#bargeLoudTicks = 0;

	readonly #stateHandlers = new Set<StateChangeHandler>();
	readonly #transcriptHandlers = new Set<TranscriptHandler>();

	constructor(deps: VoiceSessionDeps = {}) {
		// Clone so applyPrefs can mutate without touching frozen defaults.
		this.#config = { ...(deps.config ?? loadVoiceConfig()) };
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
			deps.createCapture ??
			((opts) =>
				new MicCapture({
					sampleRate: opts.sampleRate,
					device: opts.device,
				}));
		this.#deliverText = deps.deliverText ?? deliverVoiceText;
		this.#relayText = deps.relayText ?? defaultHerdrRelay;
		this.#delay = deps.delay ?? defaultDelay;
		this.#scheduler = deps.scheduler ?? defaultScheduler;
		const playbackOpts: VoicePlaybackOptions = {
			backend: this.#config.tts,
			voice: this.#config.voice,
			apiKey: this.#config.apiKey,
			spawn: deps.spawn,
		};
		this.#playback =
			deps.createPlayback?.(playbackOpts) ?? new VoicePlayback(playbackOpts);
		this.#playback.onSpeakingChange((speaking) => {
			this.#onSpeakingChange(speaking);
		});
		this.#pcmOut = new PcmStreamPlayer({
			sampleRate: this.#config.sampleRate,
			spawn: deps.spawn,
		});
		this.#pcmOut.onSpeakingChange((speaking) => {
			// Realtime audio out also pauses capture (echo reduction).
			if (this.#config.mode === "conversational") {
				this.#onSpeakingChange(speaking);
			}
		});
	}

	/** Current lifecycle state. */
	getState(): VoiceSessionState {
		return this.#state;
	}

	/** True while connecting / listening / stopping. */
	isLive(): boolean {
		return LIVE_STATES.has(this.#state);
	}

	/** True while a soft reconnect is in flight. */
	isReconnecting(): boolean {
		return this.#reconnecting;
	}

	/** Short status string suitable for `/voice status` and footer setStatus. */
	getStatus(): string {
		if (this.#state === "error" && this.#error) {
			return `error: ${this.#error}`;
		}
		if (this.#reconnecting) {
			return `reconnecting (${this.#reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`;
		}
		if (this.#speaking || this.#pcmOut.isSpeaking()) {
			return this.#config.mode === "conversational"
				? "speaking (realtime)…"
				: "speaking…";
		}
		if (this.#responseActive && this.#config.mode === "conversational") {
			return "assistant…";
		}
		if (this.#activePiTurns > 0) {
			return "pi working…";
		}
		if (this.#state === "listening" && this.#capturePaused) {
			// Distinguish agent-busy gate from TTS echo-guard hold-off.
			if (this.#agentBusy) return "pi working…";
			if (this.#echoGuardTimer) return "echo guard…";
			return "paused…";
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
			tts: this.#config.tts,
			capturePaused: this.#capturePaused,
			speaking: this.#speaking,
			hearing: this.#hearing,
			partial: this.#partial || undefined,
			audioChunks: this.#audioChunks,
			audioLevel: this.#audioLevel,
			inputDevice: this.#config.inputDevice,
			captureBackend: this.#captureBackend,
			relayTarget: this.#config.relayTarget,
			relayMode: this.#config.relayMode,
			error: this.#error,
		};
	}

	/** Config used by this session (read-only view). */
	getConfig(): Readonly<VoiceConfig> {
		return this.#config;
	}

	/** Snapshot suitable for `pi.appendEntry("voice-state", …)`. */
	getPrefs(): VoiceStatePrefs {
		return voiceStateFromFields({
			mode: this.#config.mode,
			tts: this.#config.tts,
			voice: this.#config.voice,
			inputDevice: this.#config.inputDevice,
		});
	}

	/**
	 * Apply restored / user prefs (mode, tts, voice, input device).
	 * Safe while idle; device changes take effect on the next start.
	 * Does not write secrets.
	 */
	applyPrefs(prefs: VoiceStatePrefs): void {
		if (prefs.mode !== undefined) {
			this.setMode(prefs.mode as VoiceMode);
		}
		if (prefs.tts !== undefined) {
			const tts = prefs.tts as TtsBackend;
			this.#config = { ...this.#config, tts };
			this.#playback.configure({ backend: tts });
		}
		if (prefs.voice !== undefined) {
			this.#config = { ...this.#config, voice: prefs.voice };
			this.#playback.configure({ voice: prefs.voice });
		}
		if (prefs.inputDevice !== undefined) {
			this.#config = {
				...this.#config,
				inputDevice: prefs.inputDevice ?? undefined,
			};
		}
	}

	/**
	 * Switch transcription ↔ conversational mode (VS8).
	 * When live, pushes a session.update with the matching tools/modalities.
	 * Default remains transcription.
	 */
	setMode(mode: VoiceMode): void {
		if (mode !== "transcription" && mode !== "conversational") return;
		if (this.#config.mode === mode) return;
		this.#config = { ...this.#config, mode };
		// Conversational uses Realtime audio out; stop leftover TTS.
		if (mode === "conversational") {
			this.#playback.stop();
		} else {
			this.#pcmOut.stop();
		}
		const client = this.#client;
		if (client && this.isLive()) {
			try {
				const session = buildDefaultSessionConfig(
					connectConfigFromVoice(this.#config),
				);
				client.updateSession(session);
			} catch (err) {
				this.#notify(
					`voice mode update failed: ${errorMessage(err)}`,
					"warning",
				);
			}
		}
		this.#pushUiStatus();
	}

	/**
	 * Called from the extension on `agent_settled` so pi_turn can complete
	 * with a function_call_output summary.
	 */
	notifyAgentSettled(summary?: string): void {
		const text = (summary?.trim() || "done").slice(0, 2000);
		const waiters = this.#settledWaiters.splice(0);
		for (const w of waiters) {
			try {
				w.resolve(text);
			} catch {
				// ignore
			}
		}
	}

	/**
	 * Subscribe to lifecycle state transitions.
	 */
	onStateChange(handler: StateChangeHandler): Unsubscribe {
		this.#stateHandlers.add(handler);
		return () => {
			this.#stateHandlers.delete(handler);
		};
	}

	/**
	 * Subscribe to transcript events (partial + final + speech markers).
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
	 * also a hook for playback self-echo mitigation (#13 / #14).
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
			// Agent work wins over TTS — stop speak-back so tools aren't talked over.
			this.#clearEchoGuardTimer();
			this.#playback.stop();
			this.setCapturePaused(true);
		} else if (this.#state === "listening" && !this.#speaking) {
			this.setCapturePaused(false);
		}
	}

	/** Whether TTS speak-back is currently playing. */
	isSpeaking(): boolean {
		return this.#speaking || this.#pcmOut.isSpeaking();
	}

	/**
	 * Optional speak-back of a short summary (VS6).
	 * No-op when TTS is `off`, text is empty, or the session is not live.
	 * Pauses capture while speaking to reduce echo.
	 */
	async speakBack(text: string): Promise<void> {
		// Conversational mode: the Realtime model speaks after pi_turn output.
		if (this.#config.mode === "conversational") return;
		if (this.#config.tts === "off") return;
		if (!this.isLive()) return;
		const trimmed = text?.trim() ?? "";
		if (!trimmed) return;
		try {
			await this.#playback.speak(trimmed);
		} catch (err) {
			// Don't fail the agent turn — surface and continue listening.
			this.#notify(`voice tts: ${errorMessage(err)}`, "warning");
		}
	}

	/** Stop in-flight TTS / realtime audio without tearing down the session. */
	stopPlayback(): void {
		this.#playback.stop();
		this.#pcmOut.stop();
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
		this.#reconnecting = false;
		this.#reconnectAttempts = 0;
		this.#clearSessionLimitTimer();
		this.#clearEchoGuardTimer();
		this.#resetHearingState();
		this.#setState("connecting");
		this.#pushUiStatus();
		this.#pushPartialWidget();

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

			capture = this.#createCapture({
				sampleRate: this.#config.sampleRate,
				device: this.#config.inputDevice,
			});
			this.#capture = capture;

			// Surface unexpected capture death (e.g. Continuity drop).
			if (
				capture &&
				"onUnexpectedExit" in capture &&
				typeof (capture as MicCapture).onUnexpectedExit === "function"
			) {
				(capture as MicCapture).onUnexpectedExit((info) => {
					if (gen !== this.#generation) return;
					const tail = info.stderr?.trim().slice(-200);
					const detail = tail
						? `mic exited (${info.code ?? info.signal}): ${tail}`
						: `mic exited (${info.code ?? info.signal ?? "?"})`;
					// Mic death is not a soft WS reconnect — full stop.
					void this.#failAndStop(detail, gen);
				});
			}

			await capture.start((pcm) => {
				if (gen !== this.#generation) return;
				// Meter whenever capture is alive (including connecting).
				this.#noteAudio(pcm);
				if (this.#state !== "listening") return;
				const active = this.#client;
				// Local barge-in: while assistant audio plays we pause the uplink
				// (echo), so the server never sees speech_started — detect from mic energy.
				if (
					active &&
					this.#config.mode === "conversational" &&
					this.#assistantIsHot()
				) {
					this.#maybeLocalBargeIn(active);
				}
				if (this.#capturePaused) return;
				if (!active) return;
				try {
					active.appendAudio(pcm);
				} catch {
					// Drop chunk on transient send failure; close handler recovers.
				}
			});

			// Backend label is only meaningful after start().
			this.#captureBackend =
				"backend" in capture &&
				typeof (capture as { backend?: unknown }).backend === "string"
					? (capture as { backend: string }).backend
					: this.#config.inputDevice
						? `device:${this.#config.inputDevice}`
						: "default";
			if (gen !== this.#generation) {
				this.#clearClientSubs();
				this.#client = undefined;
				this.#capture = undefined;
				await capture.stop().catch(() => undefined);
				client.close();
				return;
			}

			this.#reconnectAttempts = 0;
			this.#setState("listening");
			this.#armSessionLimitTimer(gen);
			const deviceNote = this.#config.inputDevice
				? ` · in=${this.#config.inputDevice}`
				: "";
			const modeHint =
				this.#config.mode === "conversational"
					? "realtime audio + pi_turn"
					: "transcription";
			this.#notify(
				`voice listening (${auth.mode} · ${this.#config.mode}/${modeHint}${deviceNote}) — speak anytime; ctrl+shift+v toggles`,
				"info",
			);
			this.#pushUiStatus();
			this.#pushPartialWidget();
		} catch (err) {
			if (gen !== this.#generation) return;
			const message = errorMessage(err);
			this.#clearClientSubs();
			this.#client = undefined;
			this.#capture = undefined;
			this.#clearSessionLimitTimer();
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
			this.#pushUiStatus(true);
			throw err instanceof Error ? err : new Error(message);
		}
	}

	/**
	 * Stop capture + WS and return to idle.
	 * Idempotent when already idle.
	 */
	async stop(): Promise<void> {
		if (this.#state === "idle" && !this.#client && !this.#capture) {
			this.#playback.stop();
			this.#notify("voice already stopped", "info");
			this.#pushUiStatus(true);
			return;
		}

		const gen = ++this.#generation;
		this.#reconnecting = false;
		this.#clearSessionLimitTimer();
		this.#clearEchoGuardTimer();
		this.#playback.stop();
		this.#pcmOut.stop();
		this.#rejectSettledWaiters("voice stopped");
		this.#setState("stopping");
		this.#pushUiStatus();
		this.#pushPartialWidget();

		const client = this.#client;
		const capture = this.#capture;
		this.#client = undefined;
		this.#capture = undefined;
		this.#clearClientSubs();

		await this.#teardownResources(client, capture);
		if (gen !== this.#generation) return;

		this.#authMode = undefined;
		this.#capturePaused = false;
		this.#reconnectAttempts = 0;
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
		if (
			this.#state === "listening" ||
			this.#state === "connecting" ||
			this.#reconnecting
		) {
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

	#onSpeakingChange(speaking: boolean): void {
		this.#speaking = speaking;
		this.#clearEchoGuardTimer();
		if (speaking) {
			this.setCapturePaused(true);
		} else if (this.#state === "listening" && !this.#agentBusy) {
			// Barge-in: user already talking — resume immediately.
			if (this.#hearing) {
				this.setCapturePaused(false);
			} else {
				// Hold mic closed briefly so TTS tail / room echo isn't transcribed.
				this.#echoGuardTimer = this.#scheduler.set(() => {
					this.#echoGuardTimer = undefined;
					if (
						this.#state === "listening" &&
						!this.#agentBusy &&
						!this.#speaking
					) {
						this.setCapturePaused(false);
					}
					this.#pushUiStatus();
				}, ECHO_GUARD_AFTER_TTS_MS);
			}
		}
		this.#pushUiStatus();
	}

	#wireClient(client: RealtimeClientLike, gen: number): void {
		this.#clearClientSubs();

		const onDone = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			const event = args[0] as TranscriptEvent | undefined;
			if (!event) return;
			this.#hearing = false;
			const finalText = event.text?.trim() ?? "";
			this.#partial = "";
			if (finalText) {
				this.#lastFinal = finalText;
				this.#lastFinalAt = Date.now();
				this.#armFinalWidgetTimer(gen);
			}
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
				// Prefer local energy barge-in while assistant is hot; server VAD
				// often never fires because we pause the uplink during playback.
				if (this.#assistantIsHot()) {
					if (!this.#userBargeInSignal()) return;
				}
				this.#bargeIn(client);
				this.#hearing = true;
				this.#partial = "";
				this.#clearEchoGuardTimer();
				if (!this.#agentBusy && this.#state === "listening") {
					this.setCapturePaused(false);
				}
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
			// Unexpected close while live → reconnect or stop.
			if (
				this.#state === "listening" ||
				this.#state === "connecting" ||
				this.#reconnecting
			) {
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

		const onFunctionCall = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			const event = args[0] as FunctionCallEvent | undefined;
			if (!event) return;
			void this.#handleFunctionCall(event, gen);
		};
		const onAudioDelta = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			if (this.#config.mode !== "conversational") return;
			const event = args[0] as RealtimeAudioDeltaEvent | undefined;
			if (!event?.delta) return;
			const firstChunk = !this.#pcmOut.hasAudio();
			this.#responseActive = true;
			if (event.itemId) this.#assistantItemId = event.itemId;
			if (firstChunk) {
				this.#assistantAudioAt = Date.now();
				// Snapshot current mic energy as echo reference.
				this.#echoFloor = Math.max(this.#audioLevel, 0.01);
				this.#bargeLoudTicks = 0;
				// Drop residual mic audio already in the server buffer.
				try {
					(
						client as { clearAudio?: () => void }
					).clearAudio?.();
				} catch {
					// optional on fakes
				}
				// Pause uplink so speaker echo is not streamed back to the model.
				// Local barge-in still runs from mic metering above.
				this.setCapturePaused(true);
			}
			this.#pcmOut.appendBase64(event.delta, event.itemId);
			this.#pushUiStatus();
			this.#pushPartialWidget();
		};
		const onAudioDone = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			this.#pcmOut.done();
		};
		const onResponseCreated = (..._args: unknown[]) => {
			if (gen !== this.#generation) return;
			this.#responseActive = true;
			this.#pushUiStatus();
			this.#pushPartialWidget();
		};
		const onAssistantDelta = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			const event = args[0] as TranscriptEvent | undefined;
			const piece = event?.text ?? "";
			if (!piece) return;
			// Reuse partial slot with a marker via widget path below.
			this.#partial = `${this.#partial}${piece}`;
			// Prefix-less accumulation under lastFinal for assistant flash is noisy;
			// widget shows speaking state via #responseActive / pcmOut.
			this.#pushPartialWidget();
		};
		const onAssistantDone = (...args: unknown[]) => {
			if (gen !== this.#generation) return;
			const event = args[0] as TranscriptEvent | undefined;
			const text = event?.text?.trim() ?? this.#partial.trim();
			this.#partial = "";
			if (text) {
				this.#lastFinal = text;
				this.#lastFinalAt = Date.now();
				this.#armFinalWidgetTimer(gen);
			}
			this.#responseActive = false;
			this.#pushUiStatus();
			this.#pushPartialWidget();
		};

		sub("transcript.done", onDone);
		sub("transcript.delta", onDelta);
		sub("speech.started", onSpeech);
		sub("speech.stopped", onSpeech);
		sub("function_call", onFunctionCall);
		sub("audio.delta", onAudioDelta);
		sub("audio.done", onAudioDone);
		const onResponseDone = (..._args: unknown[]) => {
			if (gen !== this.#generation) return;
			this.#responseActive = false;
			this.#pushUiStatus();
			this.#pushPartialWidget();
		};
		sub("response.created", onResponseCreated);
		sub("response.done", onResponseDone);
		sub("assistant_transcript.delta", onAssistantDelta);
		sub("assistant_transcript.done", onAssistantDone);
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

		// Conversational: Realtime holds the dialogue; coding only via pi_turn.
		if (this.#config.mode === "conversational") {
			return;
		}

		const mode = this.#config.relayMode;
		const target = this.#config.relayTarget?.trim();
		const doLocal = mode === "local" || mode === "both" || !target;
		const doRelay = Boolean(target) && (mode === "relay" || mode === "both");

		if (doLocal) {
			const pi = this.#pi;
			if (!pi) {
				if (!doRelay) {
					this.#notify(
						`voice transcript (no bridge): ${truncate(text, 80)}`,
						"warning",
					);
					return;
				}
			} else {
				try {
					this.#deliverText(pi, text, {
						isIdle: () => this.#probeIdle(),
					});
					this.#notify(`voice → pi: ${truncate(text, 60)}`, "info");
				} catch (err) {
					this.#notify(
						`voice bridge failed: ${errorMessage(err)}`,
						"error",
					);
				}
			}
		}

		if (doRelay && target) {
			try {
				this.#relayText(target, text);
				this.#notify(
					`voice → herdr:${target}: ${truncate(text, 50)}`,
					"info",
				);
			} catch (err) {
				this.#notify(
					`voice herdr relay failed: ${errorMessage(err)}`,
					"error",
				);
			}
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

	/**
	 * Barge-in: stop local audio and truncate the Realtime assistant item.
	 * Server VAD already cancels the in-progress response on speech_started;
	 * we still send cancel + truncate for the WebSocket playback path.
	 */
	#assistantIsHot(): boolean {
		return (
			this.#responseActive ||
			this.#pcmOut.isSpeaking() ||
			this.#pcmOut.hasAudio()
		);
	}

	/** True when mic energy looks like the user talking over the assistant. */
	#userBargeInSignal(): boolean {
		if (Date.now() - this.#assistantAudioAt < BARGE_IN_GRACE_MS) {
			return false;
		}
		const floor = Math.max(this.#echoFloor, 0.015);
		// Must beat both absolute floor and a multiple of the echo baseline.
		const need = Math.max(BARGE_IN_LEVEL, floor * 2.2);
		return this.#audioLevel >= need;
	}

	#maybeLocalBargeIn(client: RealtimeClientLike): void {
		if (!this.#userBargeInSignal()) {
			this.#bargeLoudTicks = 0;
			return;
		}
		this.#bargeLoudTicks += 1;
		if (this.#bargeLoudTicks < BARGE_IN_SUSTAIN) return;
		this.#bargeLoudTicks = 0;
		this.#bargeIn(client);
		this.#hearing = true;
		this.#partial = "";
		this.#clearEchoGuardTimer();
		if (!this.#agentBusy && this.#state === "listening") {
			this.setCapturePaused(false);
		}
		this.#pushUiStatus();
		this.#pushPartialWidget();
	}

	#bargeIn(client: RealtimeClientLike): void {
		// Always cut local TTS / realtime PCM immediately.
		this.#bargeLoudTicks = 0;
		this.#playback.stop();
		const hadAudio = this.#pcmOut.hasAudio() || this.#pcmOut.isSpeaking();
		const itemId =
			this.#pcmOut.getCurrentItemId() ?? this.#assistantItemId;
		const shouldCancel =
			this.#config.mode === "conversational" &&
			(this.#responseActive || hadAudio || Boolean(itemId));
		const { audioEndMs } = this.#pcmOut.stop();
		this.#responseActive = false;
		this.#assistantItemId = undefined;
		if (!shouldCancel) return;
		try {
			client.cancelResponse?.();
		} catch {
			// ignore — benign when already finished
		}
		if (itemId) {
			try {
				client.truncateConversationItem?.(itemId, audioEndMs, 0);
			} catch {
				// ignore
			}
		}
		this.#pushUiStatus();
		this.#pushPartialWidget();
	}

	#rejectSettledWaiters(reason: string): void {
		const waiters = this.#settledWaiters.splice(0);
		for (const w of waiters) {
			try {
				w.resolve(`(interrupted: ${reason})`);
			} catch {
				// ignore
			}
		}
	}

	#waitAgentSettled(gen: number, timeoutMs = PI_TURN_TIMEOUT_MS): Promise<string> {
		return new Promise((resolve) => {
			let settled = false;
			const entry = {
				gen,
				resolve: (summary: string) => {
					if (settled) return;
					settled = true;
					this.#scheduler.clear(timer);
					resolve(summary);
				},
			};
			const timer = this.#scheduler.set(() => {
				this.#settledWaiters = this.#settledWaiters.filter((w) => w !== entry);
				entry.resolve("(pi turn timed out — agent still working)");
			}, timeoutMs);
			this.#settledWaiters.push(entry);
			if (gen !== this.#generation) {
				this.#settledWaiters = this.#settledWaiters.filter((w) => w !== entry);
				entry.resolve("(session ended)");
			}
		});
	}

	async #handleFunctionCall(event: FunctionCallEvent, gen: number): Promise<void> {
		if (gen !== this.#generation) return;
		const name = event.name || "pi_turn";
		if (name !== "pi_turn") {
			this.#notify(`voice: ignoring unknown tool ${name}`, "warning");
			this.#returnToolOutput(
				event.callId,
				JSON.stringify({
					ok: false,
					error: `unsupported tool: ${name}`,
				}),
			);
			return;
		}

		let message = "";
		try {
			const parsed = JSON.parse(event.arguments || "{}") as {
				message?: unknown;
			};
			message = typeof parsed.message === "string" ? parsed.message.trim() : "";
		} catch {
			message = "";
		}

		if (!message) {
			this.#returnToolOutput(
				event.callId,
				JSON.stringify({ ok: false, error: "pi_turn requires message" }),
			);
			return;
		}

		this.#activePiTurns += 1;
		// Tool call ends the current model response turn until we return output.
		this.#responseActive = false;
		this.#pushUiStatus();
		this.#notify(`voice pi_turn → pi: ${truncate(message, 60)}`, "info");

		const pi = this.#pi;
		if (!pi) {
			this.#activePiTurns = Math.max(0, this.#activePiTurns - 1);
			this.#returnToolOutput(
				event.callId,
				JSON.stringify({
					ok: false,
					error: "no pi bridge bound — start voice inside pi",
				}),
			);
			this.#pushUiStatus();
			return;
		}

		// Register waiter before deliver to avoid missing a fast agent_settled.
		const settledPromise = this.#waitAgentSettled(gen);
		try {
			// Steer while busy so conversational interrupts land promptly.
			this.#deliverText(pi, message, {
				isIdle: () => this.#probeIdle(),
				whenBusy: "steer",
			});
		} catch (err) {
			this.#activePiTurns = Math.max(0, this.#activePiTurns - 1);
			this.notifyAgentSettled(`(bridge failed: ${errorMessage(err)})`);
			this.#returnToolOutput(
				event.callId,
				JSON.stringify({
					ok: false,
					error: errorMessage(err),
				}),
			);
			this.#pushUiStatus();
			return;
		}

		const summary = await settledPromise;
		if (gen !== this.#generation) return;
		this.#activePiTurns = Math.max(0, this.#activePiTurns - 1);
		this.#pushUiStatus();

		const output = JSON.stringify({
			ok: true,
			summary: summarizeToolResult(summary),
		});
		this.#returnToolOutput(event.callId, output);
	}

	#returnToolOutput(callId: string, output: string): void {
		const client = this.#client;
		if (!client || !callId) return;
		try {
			client.sendFunctionCallOutput?.(callId, output);
			client.createResponse?.();
		} catch (err) {
			this.#notify(
				`voice tool output failed: ${errorMessage(err)}`,
				"warning",
			);
		}
	}

	/**
	 * Soft-reconnect on unexpected WS drop (network blip / 60m limit).
	 * Keeps mic capture alive when possible; only the Realtime client is swapped.
	 */
	async #handleUnexpectedClose(message: string, gen: number): Promise<void> {
		if (gen !== this.#generation) return;
		if (this.#state === "stopping" || this.#state === "idle") return;
		if (this.#reconnecting) return;

		this.#playback.stop();
		this.#clearSessionLimitTimer();
		this.#clearEchoGuardTimer();

		// Drop the dead client (subs first so our own close is ignored).
		const oldClient = this.#client;
		this.#client = undefined;
		this.#clearClientSubs();
		if (oldClient) {
			try {
				oldClient.close();
			} catch {
				// ignore
			}
		}

		// Attempt soft reconnect while capture is still running.
		if (
			this.#capture &&
			this.#reconnectAttempts < MAX_RECONNECT_ATTEMPTS
		) {
			this.#reconnecting = true;
			this.#setState("connecting");
			this.#pushUiStatus();
			this.#pushPartialWidget();

			while (
				this.#reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
				gen === this.#generation
			) {
				this.#reconnectAttempts += 1;
				const attempt = this.#reconnectAttempts;
				this.#notify(
					`voice: connection lost (${message}) — reconnecting ${attempt}/${MAX_RECONNECT_ATTEMPTS}…`,
					"warning",
				);
				this.#pushUiStatus();
				this.#pushPartialWidget();

				await this.#delay(RECONNECT_BASE_DELAY_MS * attempt);
				if (gen !== this.#generation) {
					this.#reconnecting = false;
					return;
				}

				try {
					await this.#reconnectClient(gen);
					this.#reconnecting = false;
					this.#reconnectAttempts = 0;
					this.#error = undefined;
					this.#setState("listening");
					this.#armSessionLimitTimer(gen);
					this.#notify("voice: reconnected", "info");
					this.#pushUiStatus();
					this.#pushPartialWidget();
					return;
				} catch (err) {
					// loop for another attempt
					this.#error = errorMessage(err);
				}
			}

			this.#reconnecting = false;
			message = `reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts: ${this.#error ?? message}`;
		}

		await this.#failAndStop(message, gen);
	}

	/** Re-auth + new WS; leaves capture running. */
	async #reconnectClient(gen: number): Promise<void> {
		if (gen !== this.#generation) {
			throw new Error("reconnect aborted");
		}
		const auth = await this.#resolveAuth({
			prefer: this.#config.auth,
			codexHome: this.#config.codexHome,
			apiKey: this.#config.apiKey,
		});
		if (gen !== this.#generation) {
			throw new Error("reconnect aborted");
		}
		this.#authMode = auth.mode;
		const client = this.#createClient();
		this.#client = client;
		this.#wireClient(client, gen);
		await client.connect(auth.headers, connectConfigFromVoice(this.#config));
		if (gen !== this.#generation) {
			this.#clearClientSubs();
			this.#client = undefined;
			try {
				client.close();
			} catch {
				// ignore
			}
			throw new Error("reconnect aborted");
		}
	}

	/** Full teardown after unrecoverable close / mic death. */
	async #failAndStop(message: string, gen: number): Promise<void> {
		if (gen !== this.#generation) return;
		this.#generation++;
		this.#reconnecting = false;
		this.#clearSessionLimitTimer();
		this.#clearEchoGuardTimer();
		this.#playback.stop();
		this.#pcmOut.stop();
		this.#rejectSettledWaiters(message);
		const client = this.#client;
		const capture = this.#capture;
		this.#client = undefined;
		this.#capture = undefined;
		this.#clearClientSubs();
		await this.#teardownResources(client, capture);
		this.#error = message;
		this.#authMode = undefined;
		this.#capturePaused = false;
		this.#reconnectAttempts = 0;
		this.#resetHearingState();
		this.#setState("error");
		this.#notify(`voice error: ${message} — voice stopped`, "error");
		this.#pushUiStatus();
		this.#setState("idle");
		this.#pushUiStatus(true);
	}

	/** Proactive refresh before the Realtime ~60-minute session limit. */
	#armSessionLimitTimer(gen: number): void {
		this.#clearSessionLimitTimer();
		this.#sessionLimitTimer = this.#scheduler.set(() => {
			this.#sessionLimitTimer = undefined;
			void this.#refreshBeforeSessionLimit(gen);
		}, SESSION_LIMIT_REFRESH_MS);
	}

	#clearSessionLimitTimer(): void {
		if (this.#sessionLimitTimer !== undefined) {
			this.#scheduler.clear(this.#sessionLimitTimer);
			this.#sessionLimitTimer = undefined;
		}
	}

	async #refreshBeforeSessionLimit(gen: number): Promise<void> {
		if (gen !== this.#generation) return;
		if (this.#state !== "listening" || this.#reconnecting) return;
		this.#notify(
			"voice: refreshing realtime session before 60-minute limit…",
			"info",
		);
		// Synthesize a soft reconnect via the same path as a WS drop.
		// Detach current client without going through fail.
		const oldClient = this.#client;
		this.#client = undefined;
		this.#clearClientSubs();
		if (oldClient) {
			try {
				oldClient.close();
			} catch {
				// ignore
			}
		}
		// Reset attempt counter for a clean refresh.
		this.#reconnectAttempts = 0;
		await this.#handleUnexpectedClose("session time limit refresh", gen);
	}

	#armFinalWidgetTimer(gen: number): void {
		if (this.#finalWidgetTimer !== undefined) {
			this.#scheduler.clear(this.#finalWidgetTimer);
			this.#finalWidgetTimer = undefined;
		}
		this.#finalWidgetTimer = this.#scheduler.set(() => {
			this.#finalWidgetTimer = undefined;
			if (gen !== this.#generation) return;
			// Only clear the lingering final if nothing new is showing.
			if (!this.#partial.trim() && !this.#hearing) {
				this.#pushPartialWidget();
			}
		}, FINAL_WIDGET_MS);
	}

	#clearEchoGuardTimer(): void {
		if (this.#echoGuardTimer !== undefined) {
			this.#scheduler.clear(this.#echoGuardTimer);
			this.#echoGuardTimer = undefined;
		}
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
		this.#lastFinal = "";
		this.#lastFinalAt = 0;
		this.#responseActive = false;
		this.#assistantItemId = undefined;
		this.#assistantAudioAt = 0;
		this.#echoFloor = 0;
		this.#bargeLoudTicks = 0;
		this.#audioChunks = 0;
		this.#audioLevel = 0;
		this.#lastLevelUiAt = 0;
		this.#hadAudible = false;
		this.#captureBackend = undefined;
		if (this.#finalWidgetTimer !== undefined) {
			this.#scheduler.clear(this.#finalWidgetTimer);
			this.#finalWidgetTimer = undefined;
		}
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

	/**
	 * Transcript widget above the editor.
	 * Shows connecting/reconnect state, live partials, and a brief final flash.
	 */
	#pushPartialWidget(clear = false): void {
		const ui = this.#ui;
		if (!ui?.setWidget) return;
		try {
			if (
				clear ||
				this.#state === "idle" ||
				this.#state === "stopping" ||
				this.#state === "error"
			) {
				ui.setWidget("voice-partial", undefined);
				return;
			}

			const lines: string[] = [];
			if (this.#reconnecting) {
				lines.push(
					`voice ↻ reconnecting (${this.#reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`,
				);
			} else if (this.#state === "connecting") {
				lines.push("voice ↻ connecting…");
			}

			const partial = this.#partial.trim();
			if (this.#hearing) {
				lines.push(
					partial
						? `voice ▸ ${truncate(partial, 100)}`
						: "voice ▸ …",
				);
			} else if (this.#pcmOut.isSpeaking() || this.#responseActive) {
				lines.push(
					partial
						? `voice ◂ ${truncate(partial, 100)}`
						: "voice ◂ speaking…",
				);
			} else if (partial) {
				lines.push(`voice ▸ ${truncate(partial, 100)}`);
			} else if (
				this.#lastFinal &&
				Date.now() - this.#lastFinalAt < FINAL_WIDGET_MS
			) {
				lines.push(`voice ✓ ${truncate(this.#lastFinal, 100)}`);
			}

			if (lines.length === 0) {
				ui.setWidget("voice-partial", undefined);
				return;
			}
			ui.setWidget("voice-partial", lines.slice(0, 2));
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

/** Keep function_call_output short for the voice model. */
function summarizeToolResult(text: string, max = 800): string {
	const t = text.replace(/\s+/g, " ").trim();
	if (t.length <= max) return t;
	return `${t.slice(0, max - 1)}…`;
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

/**
 * Fire-and-forget Herdr prompt into another agent/pane.
 * Requires `herdr` on PATH and a live Herdr session that can see the target.
 */
function defaultHerdrRelay(target: string, text: string): void {
	const child = spawn(
		"herdr",
		["agent", "prompt", target, text],
		{
			stdio: "ignore",
			detached: true,
			env: process.env,
		},
	);
	child.unref();
	child.on("error", (err) => {
		// Surface via uncaught? Session already notified on throw only.
		// spawn errors are async — log-free; caller may not hear this.
		void err;
	});
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
