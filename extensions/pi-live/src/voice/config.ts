/**
 * Typed voice config resolved from `PI_VOICE_*` environment variables.
 *
 * Defaults match the voice realtime plan (issue #7 / epic #6).
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { VoiceAuthPrefer, VoiceMode } from "./types.js";

export type VoiceRelayMode = "local" | "relay" | "both";

export interface VoiceConfig {
	/** `transcription` (MVP) or `conversational` (later). */
	mode: VoiceMode;
	/** Realtime model id, e.g. `gpt-realtime-2.1`. */
	model: string;
	/** TTS voice name when playback is enabled. */
	voice: string;
	/** Auth preference passed to resolveVoiceAuth (#8). */
	auth: VoiceAuthPrefer;
	/** Codex home directory (auth.json location). `~` is expanded. */
	codexHome: string;
	/** PCM sample rate in Hz (OpenAI Realtime GA default: 24000). */
	sampleRate: number;
	/**
	 * Optional CoreAudio / SoX input device name.
	 * Examples: `iPhone Microphone`, `MacBook Air Microphone`.
	 * Empty/undefined → system default (`rec` / `sox -d`).
	 */
	inputDevice?: string;
	/**
	 * When set, final transcripts are also (or only) sent via
	 * `herdr agent prompt <target> <text>`. Use a unique agent name or pane id
	 * for the main coding session (mic often works only in a local pane).
	 */
	relayTarget?: string;
	/**
	 * How to deliver finals when `relayTarget` is set.
	 * - `local` — only this pi (`sendUserMessage`) [default without relay]
	 * - `relay` — only Herdr target (satellite voice pane)
	 * - `both` — local + Herdr
	 */
	relayMode: VoiceRelayMode;
	/** Optional explicit API key override (never logged). */
	apiKey?: string;
}

const DEFAULTS = {
	mode: "transcription" as VoiceMode,
	model: "gpt-realtime-2.1",
	voice: "marin",
	auth: "auto" as VoiceAuthPrefer,
	sampleRate: 24_000,
	relayMode: "local" as VoiceRelayMode,
} as const;

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function parseMode(raw: string | undefined): VoiceMode {
	if (raw === "conversational" || raw === "transcription") return raw;
	return DEFAULTS.mode;
}

function parseAuth(raw: string | undefined): VoiceAuthPrefer {
	if (raw === "auto" || raw === "codex" || raw === "api-key") return raw;
	return DEFAULTS.auth;
}

function parseSampleRate(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULTS.sampleRate;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULTS.sampleRate;
}

function parseRelayMode(
	raw: string | undefined,
	hasTarget: boolean,
): VoiceRelayMode {
	if (raw === "local" || raw === "relay" || raw === "both") return raw;
	// Sensible default: satellite pane when a target is configured.
	return hasTarget ? "relay" : DEFAULTS.relayMode;
}

/**
 * Read voice settings from `env` (defaults to `process.env`).
 * Safe to call repeatedly; performs no I/O beyond env access.
 */
export function loadVoiceConfig(
	env: NodeJS.ProcessEnv = process.env,
): VoiceConfig {
	const codexHomeRaw = env.PI_VOICE_CODEX_HOME?.trim() || "~/.codex";

	const apiKey =
		env.PI_VOICE_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || undefined;

	const relayTarget = env.PI_VOICE_RELAY_TARGET?.trim() || undefined;
	return {
		mode: parseMode(env.PI_VOICE_MODE?.trim()),
		model: env.PI_VOICE_MODEL?.trim() || DEFAULTS.model,
		voice: env.PI_VOICE_VOICE?.trim() || DEFAULTS.voice,
		auth: parseAuth(env.PI_VOICE_AUTH?.trim()),
		codexHome: expandHome(codexHomeRaw),
		sampleRate: parseSampleRate(env.PI_VOICE_SAMPLE_RATE?.trim()),
		inputDevice: env.PI_VOICE_INPUT_DEVICE?.trim() || undefined,
		relayTarget,
		relayMode: parseRelayMode(env.PI_VOICE_RELAY_MODE?.trim(), Boolean(relayTarget)),
		apiKey: apiKey || undefined,
	};
}

/** Frozen default config snapshot (useful for tests / status fallbacks). */
export const defaultVoiceConfig: Readonly<VoiceConfig> = Object.freeze(
	loadVoiceConfig({}),
);
