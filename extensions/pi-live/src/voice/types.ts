/**
 * Public contracts for the pi-live voice module (VS0 foundation).
 *
 * Implementations land in later slices:
 *   #8 auth · #9 realtime-client · #10 capture · #11 bridge · #12 session MVP
 */

/** How Realtime credentials were (or will be) resolved. */
export type VoiceAuthMode = "chatgpt" | "api-key";

/** Preferred auth strategy from config / resolveVoiceAuth options. */
export type VoiceAuthPrefer = "auto" | "codex" | "api-key";

/**
 * Resolved credentials for the Realtime WebSocket (#8).
 * `headers` always includes `Authorization`; chatgpt mode also sets
 * `ChatGPT-Account-Id`. Never log token values.
 */
export interface VoiceAuth {
	mode: VoiceAuthMode;
	headers: Record<string, string>;
	accountId?: string;
	expiresAt?: number;
}

/** Options for `resolveVoiceAuth` (#8). */
export interface ResolveVoiceAuthOptions {
	codexHome?: string;
	prefer?: VoiceAuthPrefer;
}

/**
 * Placeholder signature for #8. VS0 only exports the type — no implementation.
 * Callers in later slices should import the real function from `./auth.js`.
 */
export type ResolveVoiceAuth = (
	options?: ResolveVoiceAuthOptions,
) => Promise<VoiceAuth>;

/** High-level operating mode for the voice session. */
export type VoiceMode = "transcription" | "conversational";

/**
 * Lifecycle state of a voice session.
 * Full machine: idle → connecting → listening → stopping → idle (+ error).
 */
export type VoiceSessionState =
	| "idle"
	| "connecting"
	| "listening"
	| "stopping"
	| "error";

/** Snapshot returned by session status helpers. */
export interface VoiceSessionStatus {
	state: VoiceSessionState;
	/** Human-readable one-liner suitable for notify / setStatus. */
	status: string;
	mode: VoiceMode;
	/** Configured auth preference (not a resolved secret). */
	auth: VoiceAuthPrefer;
	/**
	 * Resolved credential mode after a successful connect (`chatgpt` | `api-key`).
	 * Omitted while idle / before auth resolves. Never includes secrets.
	 */
	authMode?: VoiceAuthMode;
	model: string;
	voice: string;
	sampleRate: number;
	/** Speak-back backend (`PI_VOICE_TTS`). */
	tts?: string;
	/** True when mic chunks are gated (e.g. while the agent is working). */
	capturePaused?: boolean;
	/** True while TTS speak-back is in progress. */
	speaking?: boolean;
	/** Server VAD currently detects speech. */
	hearing?: boolean;
	/** Latest partial transcript (may be empty). */
	partial?: string;
	/** Mic PCM chunks received since start (capture path alive). */
	audioChunks?: number;
	/** 0–1 rough input level from recent PCM (silence ≈ 0). */
	audioLevel?: number;
	/** Named input device when set (`PI_VOICE_INPUT_DEVICE`). */
	inputDevice?: string;
	/** Capture backend label (`rec`, `sox:coreaudio:…`). */
	captureBackend?: string;
	/** Herdr agent/pane target when relaying finals. */
	relayTarget?: string;
	/** Delivery mode: local | relay | both. */
	relayMode?: string;
	/** Present when `state === "error"`. */
	error?: string;
}

/** Streaming / final transcript events from the Realtime client (#9 / #12). */
export type TranscriptEventType =
	| "partial"
	| "final"
	| "speech_started"
	| "speech_stopped";

export interface TranscriptEvent {
	type: TranscriptEventType;
	/** Transcript text (empty for speech_started / speech_stopped). */
	text: string;
	/** Monotonic item / utterance id from the provider when available. */
	itemId?: string;
	timestamp: number;
}

/**
 * How to deliver voice text into the pi agent loop when a turn is already running (#11).
 * Idle delivery is always a bare `sendUserMessage` (not represented here).
 */
export type BridgeDeliveryMode = "steer" | "followUp";

export interface DeliverVoiceTextOptions {
	whenBusy?: BridgeDeliveryMode;
}

/**
 * Placeholder signature for #11. VS0 only exports the type.
 * Real implementation lives in `./bridge.js`.
 */
export type DeliverVoiceText = (
	// ExtensionAPI is structural here to avoid a hard runtime dep from types.
	pi: {
		sendUserMessage: (
			text: string,
			opts?: { deliverAs?: BridgeDeliveryMode },
		) => void;
	},
	text: string,
	opts?: DeliverVoiceTextOptions,
) => void;

/** Minimal surface the Realtime client (#9) is expected to expose. */
export interface RealtimeClientLike {
	connect(authHeaders: Record<string, string>, config: unknown): Promise<void>;
	close(): void;
	appendAudio(pcm16Base64OrBuffer: string | Uint8Array): void;
	on(event: string, handler: (...args: unknown[]) => void): void;
	updateSession(partial: unknown): void;
}

/** Minimal surface the mic capture module (#10) is expected to expose. */
export interface MicCaptureLike {
	start(onChunk: (pcm: Uint8Array) => void): Promise<void>;
	stop(): Promise<void>;
	readonly backend: string;
}
