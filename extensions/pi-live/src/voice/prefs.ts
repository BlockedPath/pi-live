/**
 * Voice preference persistence (VS7 / issue #14).
 *
 * Stored via `pi.appendEntry("voice-state", …)` — custom session entries that
 * do not enter the LLM context. Restored on `session_start` so mode/tts/device
 * survive `/reload` and session resume when env vars are not forcing values.
 *
 * Never store secrets (tokens, API keys) here.
 */
import type { TtsBackend } from "./playback.js";
import type { VoiceMode } from "./types.js";

/** Custom entry type written with `pi.appendEntry`. */
export const VOICE_STATE_TYPE = "voice-state";

/** Shape persisted under `voice-state`. Keep additive / versioned. */
export interface VoiceStatePrefs {
	/** Schema version. */
	v: 1;
	mode?: VoiceMode;
	tts?: TtsBackend;
	/** TTS voice name (`PI_VOICE_VOICE`). */
	voice?: string;
	/**
	 * Named input device. `null` means "system default" (clears a prior device).
	 * `undefined` means "leave unchanged" when merging.
	 */
	inputDevice?: string | null;
}

/** Minimal session entry shape we read (avoids hard dep on SessionManager types). */
export interface VoiceStateEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

const TTS_VALUES: ReadonlySet<string> = new Set(["say", "openai", "off"]);
const MODE_VALUES: ReadonlySet<string> = new Set([
	"transcription",
	"conversational",
]);

/** Type-guard / normalize unknown entry data. */
export function parseVoiceStatePrefs(data: unknown): VoiceStatePrefs | undefined {
	if (!data || typeof data !== "object") return undefined;
	const raw = data as Record<string, unknown>;
	// Accept v:1 explicitly; also tolerate missing v from early drafts.
	if (raw.v !== undefined && raw.v !== 1) return undefined;

	const prefs: VoiceStatePrefs = { v: 1 };

	if (typeof raw.mode === "string" && MODE_VALUES.has(raw.mode)) {
		prefs.mode = raw.mode as VoiceMode;
	}
	if (typeof raw.tts === "string" && TTS_VALUES.has(raw.tts)) {
		prefs.tts = raw.tts as TtsBackend;
	}
	if (typeof raw.voice === "string" && raw.voice.trim()) {
		prefs.voice = raw.voice.trim();
	}
	if (raw.inputDevice === null) {
		prefs.inputDevice = null;
	} else if (typeof raw.inputDevice === "string") {
		const d = raw.inputDevice.trim();
		prefs.inputDevice = d ? d : null;
	}

	// Ignore empty payloads (only version).
	if (
		prefs.mode === undefined &&
		prefs.tts === undefined &&
		prefs.voice === undefined &&
		prefs.inputDevice === undefined
	) {
		return undefined;
	}
	return prefs;
}

/** Latest `voice-state` custom entry in a session transcript, if any. */
export function readLatestVoiceStatePrefs(
	entries: readonly VoiceStateEntryLike[],
): VoiceStatePrefs | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type === "custom" && e.customType === VOICE_STATE_TYPE) {
			const parsed = parseVoiceStatePrefs(e.data);
			if (parsed) return parsed;
		}
	}
	return undefined;
}

/**
 * Build a prefs patch that honors explicit env overrides.
 * When `PI_VOICE_*` is set for a field, that field is omitted (env wins).
 */
export function prefsHonoringEnv(
	prefs: VoiceStatePrefs,
	env: NodeJS.ProcessEnv = process.env,
): VoiceStatePrefs {
	const out: VoiceStatePrefs = { v: 1 };
	if (prefs.mode !== undefined && !env.PI_VOICE_MODE?.trim()) {
		out.mode = prefs.mode;
	}
	if (prefs.tts !== undefined && !env.PI_VOICE_TTS?.trim()) {
		out.tts = prefs.tts;
	}
	if (prefs.voice !== undefined && !env.PI_VOICE_VOICE?.trim()) {
		out.voice = prefs.voice;
	}
	if (
		prefs.inputDevice !== undefined &&
		!env.PI_VOICE_INPUT_DEVICE?.trim()
	) {
		out.inputDevice = prefs.inputDevice;
	}
	return out;
}

/** Snapshot of current runtime prefs for persistence. */
export function voiceStateFromFields(fields: {
	mode: VoiceMode;
	tts: TtsBackend;
	voice: string;
	inputDevice?: string;
}): VoiceStatePrefs {
	return {
		v: 1,
		mode: fields.mode,
		tts: fields.tts,
		voice: fields.voice,
		inputDevice: fields.inputDevice ?? null,
	};
}
