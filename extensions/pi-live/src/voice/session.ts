/**
 * Voice session stub (VS0).
 *
 * Always reports `idle`. The real state machine (connect / capture / bridge)
 * lands in #12 once #8–#11 modules exist.
 */

import { loadVoiceConfig, type VoiceConfig } from "./config.js";
import type { VoiceSessionState, VoiceSessionStatus } from "./types.js";

export class VoiceSession {
	readonly #config: VoiceConfig;
	#state: VoiceSessionState = "idle";
	#error: string | undefined;

	constructor(config: VoiceConfig = loadVoiceConfig()) {
		this.#config = config;
	}

	/** Current lifecycle state (always `"idle"` in VS0). */
	getState(): VoiceSessionState {
		return this.#state;
	}

	/** Short status string suitable for `/voice status` and footer setStatus. */
	getStatus(): string {
		if (this.#state === "error" && this.#error) {
			return `error: ${this.#error}`;
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
			model: this.#config.model,
			voice: this.#config.voice,
			sampleRate: this.#config.sampleRate,
			error: this.#error,
		};
	}

	/** Config used by this session (read-only view). */
	getConfig(): Readonly<VoiceConfig> {
		return this.#config;
	}
}

/** Process-wide stub session for the `/voice` command until #12 replaces it. */
let sharedSession: VoiceSession | undefined;

export function getSharedVoiceSession(): VoiceSession {
	if (!sharedSession) {
		sharedSession = new VoiceSession();
	}
	return sharedSession;
}

/** Test helper — resets the shared stub. */
export function resetSharedVoiceSession(): void {
	sharedSession = undefined;
}
