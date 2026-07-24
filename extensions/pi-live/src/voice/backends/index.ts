/**
 * Voice backend selection (VS9 / issue #16).
 *
 * The default backend is the pi-native OpenAI Realtime WebSocket client
 * (`PI_VOICE_BACKEND=openai`). Setting `PI_VOICE_BACKEND=codex` swaps in the
 * optional Codex app-server realtime adapter (V2 text / V3 audio), which drives
 * the local `codex` CLI and maps `thread/realtime/*` events into the same
 * `RealtimeClientLike` surface the session already consumes.
 *
 * Both backends implement {@link RealtimeClientLike}, so the rest of the
 * session (capture, bridge, playback, widget, prefs) is unchanged.
 */
import type { VoiceConfig } from "../config.js";
import { RealtimeClient } from "../realtime-client.js";
import type { RealtimeClientLike } from "../types.js";

import {
	CodexAppServerBackend,
	type CodexSpawnFn,
} from "./codex-app-server.js";

export interface CreateVoiceClientOptions {
	/** Injectable spawn for the codex app-server child (tests). */
	spawn?: CodexSpawnFn;
}

/**
 * Build the realtime client for the configured backend. Used as the default
 * `createClient` in `VoiceSession`. The openai path is 100% unchanged.
 */
export function createVoiceClient(
	config: VoiceConfig,
	options: CreateVoiceClientOptions = {},
): RealtimeClientLike {
	if (config.backend === "codex") {
		return new CodexAppServerBackend({ spawn: options.spawn });
	}
	return new RealtimeClient();
}

export {
	CodexAppServerBackend,
	CodexBackendError,
	CODEX_V3_VOICES,
	DEFAULT_CODEX_BIN,
	detectCodexCli,
	type CodexAppServerBackendOptions,
	type CodexBackendErrorCode,
	type CodexDetectResult,
	type CodexSpawnFn,
	type CodexTransport,
} from "./codex-app-server.js";
