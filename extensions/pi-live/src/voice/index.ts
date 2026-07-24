/**
 * Public barrel for the pi-live voice module.
 *
 * Stable export surface for parallel slices #8–#11 and integration #12.
 * Implementations are added by those slices; VS0 ships types + config + idle stub.
 */

export {
	defaultVoiceConfig,
	loadVoiceConfig,
	type VoiceConfig,
} from "./config.js";

export {
	deliverVoiceText,
	type DeliverVoiceTextCallOptions,
	type VoiceBridgePi,
} from "./bridge.js";

export {
	getSharedVoiceSession,
	resetSharedVoiceSession,
	VoiceSession,
} from "./session.js";

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
