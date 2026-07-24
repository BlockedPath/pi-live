/**
 * Public barrel for the pi-live voice module.
 *
 * Stable export surface across voice slices (#7–#15+).
 * VS5: VoiceSession state machine. VS6: playback / TTS speak-back.
 * VS7: prefs, reconnect, widget polish.
 * VS8: conversational mode + pi_turn.
 */

export {
	defaultVoiceConfig,
	loadVoiceConfig,
	type VoiceConfig,
	type VoiceRelayMode,
} from "./config.js";

export { MicCapture, type MicCaptureOptions } from "./capture.js";

export {
	deliverVoiceText,
	type DeliverVoiceTextCallOptions,
	type VoiceBridgePi,
} from "./bridge.js";

export {
	VoiceAuthError,
	resolveVoiceAuth,
} from "./auth.js";

export {
	getSharedVoiceSession,
	resetSharedVoiceSession,
	VoiceSession,
	type VoiceSessionDeps,
	type VoiceSessionStartOptions,
	type VoiceSessionUi,
} from "./session.js";

export {
	parseVoiceStatePrefs,
	prefsHonoringEnv,
	readLatestVoiceStatePrefs,
	VOICE_STATE_TYPE,
	voiceStateFromFields,
	type VoiceStateEntryLike,
	type VoiceStatePrefs,
} from "./prefs.js";

export {
	DEFAULT_SPEAK_MAX_CHARS,
	extractLastAssistantText,
	PcmStreamPlayer,
	resolveTtsBackend,
	speak,
	summarizeForSpeech,
	VoicePlayback,
	type FetchFn,
	type PcmStreamPlayerOptions,
	type SpeakOptions,
	type SpawnFn,
	type TtsBackend,
	type VoicePlaybackOptions,
} from "./playback.js";

export {
	buildDefaultSessionConfig,
	connectConfigFromVoice,
	CONVERSATIONAL_INSTRUCTIONS,
	DEFAULT_REALTIME_URL,
	mergeSessionConfig,
	PI_TURN_TOOL,
	RealtimeClient,
	type RealtimeAudioDeltaEvent,
	type RealtimeAudioDoneEvent,
	type RealtimeClientError,
	type RealtimeClientEvent,
	type RealtimeClientEventMap,
	type RealtimeClientOptions,
	type RealtimeConnectConfig,
	type RealtimeServerEvent,
	type RealtimeSessionConfig,
	type WebSocketFactory,
	type WebSocketLike,
} from "./realtime-client.js";

export type {
	BridgeDeliveryMode,
	DeliverVoiceText,
	DeliverVoiceTextOptions,
	FunctionCallEvent,
	MicCaptureLike,
	RealtimeClientLike,
	ResolveVoiceAuth,
	ResolveVoiceAuthOptions,
	TranscriptEvent,
	TranscriptEventType,
	VoiceAuth,
	VoiceAuthMode,
	VoiceAuthPrefer,
	VoiceMode,
	VoiceSessionState,
	VoiceSessionStatus,
} from "./types.js";
