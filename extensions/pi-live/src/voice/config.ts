/**
 * Typed voice config resolved from `PI_VOICE_*` environment variables.
 *
 * Defaults match the voice realtime plan (issue #7 / epic #6).
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { VoiceAuthPrefer, VoiceMode } from "./types.js";

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
	/** Optional explicit API key override (never logged). */
	apiKey?: string;
}

const DEFAULTS = {
	mode: "transcription" as VoiceMode,
	model: "gpt-realtime-2.1",
	voice: "marin",
	auth: "auto" as VoiceAuthPrefer,
	sampleRate: 24_000,
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

/**
 * Read voice settings from `env` (defaults to `process.env`).
 * Safe to call repeatedly; performs no I/O beyond env access.
 */
export function loadVoiceConfig(
	env: NodeJS.ProcessEnv = process.env,
): VoiceConfig {
	const codexHomeRaw = env.PI_VOICE_CODEX_HOME?.trim() || "~/.codex";

	const apiKey =
		env.PI_VOICE_API_KEY?.trim() ||
		env.OPENAI_API_KEY?.trim() ||
		undefined;

	return {
		mode: parseMode(env.PI_VOICE_MODE?.trim()),
		model: env.PI_VOICE_MODEL?.trim() || DEFAULTS.model,
		voice: env.PI_VOICE_VOICE?.trim() || DEFAULTS.voice,
		auth: parseAuth(env.PI_VOICE_AUTH?.trim()),
		codexHome: expandHome(codexHomeRaw),
		sampleRate: parseSampleRate(env.PI_VOICE_SAMPLE_RATE?.trim()),
		apiKey: apiKey || undefined,
	};
}

/** Frozen default config snapshot (useful for tests / status fallbacks). */
export const defaultVoiceConfig: Readonly<VoiceConfig> = Object.freeze(
	loadVoiceConfig({}),
);
