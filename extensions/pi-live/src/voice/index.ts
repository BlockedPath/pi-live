/**
 * Public barrel for the pi-live voice module.
 *
 * Stable export surface for parallel slices #8–#11 and integration #12.
 * Implementations land per-slice; VS0 ships types + config + idle stub; VS1 adds auth.
 */

export {
	defaultVoiceConfig,
	loadVoiceConfig,
	type VoiceConfig,
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
} from "./session.js";

export {
	buildDefaultSessionConfig,
	connectConfigFromVoice,
	DEFAULT_REALTIME_URL,
	mergeSessionConfig,
	RealtimeClient,
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
