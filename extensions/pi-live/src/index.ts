/**
 * pi-live extension — demo skeleton + voice transcription MVP (VS5 / #12)
 * with optional speak-back (VS6 / #13), UX polish (VS7 / #14), and
 * conversational mode + pi_turn (VS8 / #15).
 *
 * Install locally (one of):
 *   - `cd extensions/pi-live && pi install .`
 *   - copy/symlink this directory into `.pi/extensions/` and run `/reload`
 *   - quick test: `pi -e ./src/index.ts`
 *
 * See CONTRIBUTING.md and ./README.md for the local development loop.
 *
 * Voice MVP: `/voice start|stop|status` (toggle with bare `/voice` or ctrl+shift+v).
 * Auth via Codex OAuth (`~/.codex`) or API key; mic via sox/rec; transcripts
 * bridge into pi via `sendUserMessage`.
 * Optional input device: `PI_VOICE_INPUT_DEVICE='iPhone Microphone'`.
 * Optional TTS: `PI_VOICE_TTS=say|openai|off` (default say on macOS).
 * Prefs (mode/tts/device/voice) persist via `appendEntry("voice-state")`.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	extractLastAssistantText,
	getSharedVoiceSession,
	prefsHonoringEnv,
	readLatestVoiceStatePrefs,
	VOICE_STATE_TYPE,
} from "./voice/index.js";

/**
 * A minimal custom tool the LLM can call. Replace this with your own.
 */
const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "Greet someone by name. A demo tool for the pi-live skeleton.",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		return {
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			details: { greeted: params.name },
		};
	},
});

function formatVoiceStatus(): string {
	const info = getSharedVoiceSession().getStatusInfo();
	const parts = [
		`voice: ${info.status}`,
		`state=${info.state}`,
		`mode=${info.mode}`,
		`auth=${info.auth}`,
	];
	if (info.authMode) parts.push(`authMode=${info.authMode}`);
	parts.push(
		`model=${info.model}`,
		`voice=${info.voice}`,
		`sampleRate=${info.sampleRate}`,
	);
	if (info.tts) parts.push(`tts=${info.tts}`);
	if (info.speaking) parts.push("speaking=yes");
	if (info.capturePaused) parts.push("capture=paused");
	if (info.hearing) parts.push("hearing=yes");
	if (info.inputDevice) parts.push(`in=${info.inputDevice}`);
	if (info.captureBackend) parts.push(`backend=${info.captureBackend}`);
	if (info.relayTarget) parts.push(`relay=${info.relayTarget}`);
	if (info.relayMode && info.relayMode !== "local")
		parts.push(`relayMode=${info.relayMode}`);
	if (typeof info.audioChunks === "number") {
		parts.push(`micChunks=${info.audioChunks}`);
	}
	if (typeof info.audioLevel === "number") {
		parts.push(`lvl=${Math.round(info.audioLevel * 100)}%`);
	}
	if (info.partial) parts.push(`partial=${JSON.stringify(info.partial)}`);
	if (info.error) parts.push(`error=${info.error}`);
	return parts.join(" · ");
}

function voiceUiFromCtx(ctx: {
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setStatus?(key: string, text: string | undefined): void;
		setWidget?(key: string, content: string[] | undefined): void;
	};
}): {
	notify: (message: string, type?: "info" | "warning" | "error") => void;
	setStatus?(key: string, text: string | undefined): void;
	setWidget?(key: string, content: string[] | undefined): void;
} {
	return {
		notify: (message, type) => ctx.ui.notify(message, type),
		setStatus: ctx.ui.setStatus?.bind(ctx.ui),
		setWidget: ctx.ui.setWidget?.bind(ctx.ui),
	};
}

function reportVoiceStatus(ctx: {
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setStatus?(key: string, text: string | undefined): void;
		setWidget?(key: string, content: string[] | undefined): void;
	};
}): void {
	const session = getSharedVoiceSession();
	session.bindUi(voiceUiFromCtx(ctx));
	const line = formatVoiceStatus();
	// Footer when available; always notify so the command is visible.
	ctx.ui.setStatus?.("voice", `voice: ${session.getStatus()}`);
	ctx.ui.notify(line, "info");
}

function parseVoiceArgs(args: string | undefined): {
	sub: string;
	rest: string[];
} {
	const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const sub = (tokens[0] ?? "").toLowerCase();
	return { sub, rest: tokens.slice(1) };
}

/** Persist non-secret voice prefs into the session transcript. */
function persistVoicePrefs(pi: ExtensionAPI): void {
	try {
		const prefs = getSharedVoiceSession().getPrefs();
		pi.appendEntry(VOICE_STATE_TYPE, prefs);
	} catch {
		// Session may be ephemeral / append unavailable — ignore.
	}
}

/** Restore last voice-state entry, honoring explicit PI_VOICE_* env overrides. */
function restoreVoicePrefs(pi: ExtensionAPI, ctx: {
	sessionManager: { getEntries: () => ReadonlyArray<{ type: string; customType?: string; data?: unknown }> };
}): void {
	try {
		const entries = ctx.sessionManager.getEntries();
		const saved = readLatestVoiceStatePrefs(entries);
		if (!saved) return;
		const patch = prefsHonoringEnv(saved);
		// Skip no-op empty patches (only v:1).
		if (
			patch.mode === undefined &&
			patch.tts === undefined &&
			patch.voice === undefined &&
			patch.inputDevice === undefined
		) {
			return;
		}
		getSharedVoiceSession().applyPrefs(patch);
	} catch {
		// Best-effort restore.
	}
}

export default function (pi: ExtensionAPI) {
	const session = getSharedVoiceSession();
	/** Last assistant text from agent_end — spoken on agent_settled. */
	let pendingSpeakText = "";

	// Surface a small note when a session starts so you can see the extension load.
	// Restore voice prefs from prior session entries when present.
	pi.on("session_start", async (_event, ctx) => {
		session.bindUi(voiceUiFromCtx(ctx));
		restoreVoicePrefs(pi, ctx);
		ctx.ui.notify("pi-live extension loaded", "info");
	});

	// Gate mic while the agent is working to cut keyboard/speaker noise.
	pi.on("agent_start", async (_event, ctx) => {
		session.bindUi(voiceUiFromCtx(ctx));
		session.setAgentBusy(true);
	});

	// Cache speakable assistant text from the low-level run.
	pi.on("agent_end", async (event) => {
		const text = extractLastAssistantText(event.messages ?? []);
		if (text) pendingSpeakText = text;
	});

	// Resume capture once the agent has fully settled; optional speak-back.
	// Conversational pi_turn waits on this via session.notifyAgentSettled.
	pi.on("agent_settled", async (_event, ctx) => {
		session.bindUi(voiceUiFromCtx(ctx));
		session.setAgentBusy(false);
		const text = pendingSpeakText;
		pendingSpeakText = "";
		// Unblock any in-flight pi_turn tool handler first.
		session.notifyAgentSettled(text || "done");
		if (text && session.isLive()) {
			// Transcription mode only — conversational uses Realtime audio out.
			void session.speakBack(text);
		}
	});

	// Best-effort teardown on shutdown so sox/ws/tts do not linger.
	pi.on("session_shutdown", async () => {
		// Persist prefs so a resume/reload can restore mode/tts/device.
		if (session.getState() !== "idle" || session.getPrefs()) {
			persistVoicePrefs(pi);
		}
		session.stopPlayback();
		if (session.isLive()) {
			try {
				await session.stop();
			} catch {
				// ignore teardown errors on shutdown
			}
		}
	});

	// Register the demo tool so the LLM can call it.
	pi.registerTool(helloTool);

	// Register a slash command for quick manual testing.
	pi.registerCommand("hello", {
		description: "Say hello (pi-live demo)",
		handler: async (args, ctx) => {
			ctx.ui.notify(`Hello ${args || "world"}!`, "info");
		},
	});

	// VS7: ctrl+shift+v toggles voice (same as bare `/voice`).
	pi.registerShortcut("ctrl+shift+v", {
		description: "Toggle voice transcription",
		handler: async (ctx) => {
			const sessionRef = getSharedVoiceSession();
			const ui = voiceUiFromCtx(ctx);
			sessionRef.bindUi(ui);
			const startOpts = {
				pi,
				isIdle: () => ctx.isIdle(),
				ui,
			};
			try {
				const action = await sessionRef.toggle(startOpts);
				if (action === "started") {
					persistVoicePrefs(pi);
					if (sessionRef.getState() === "listening") {
						reportVoiceStatus(ctx);
					}
				} else {
					persistVoicePrefs(pi);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`voice failed: ${message}`, "error");
				ctx.ui.setStatus?.("voice", `voice: error: ${message}`);
			}
		},
	});

	// VS5+VS6+VS7: transcription MVP + speak-back + polish.
	pi.registerCommand("voice", {
		description:
			"Voice: /voice [start|stop|status|toggle|mode] · shortcut ctrl+shift+v",
		handler: async (args, ctx) => {
			const { sub } = parseVoiceArgs(args);
			const sessionRef = getSharedVoiceSession();
			const ui = voiceUiFromCtx(ctx);
			sessionRef.bindUi(ui);

			const startOpts = {
				pi,
				isIdle: () => ctx.isIdle(),
				ui,
			};

			try {
				if (sub === "status") {
					reportVoiceStatus(ctx);
					return;
				}

				if (sub === "start") {
					const { rest } = parseVoiceArgs(args);
					const modeArg = (rest[0] ?? "").toLowerCase();
					if (modeArg === "transcription" || modeArg === "conversational") {
						sessionRef.setMode(modeArg);
					}
					await sessionRef.start(startOpts);
					persistVoicePrefs(pi);
					// start already notifies; refresh detailed status line
					if (sessionRef.getState() === "listening") {
						reportVoiceStatus(ctx);
					}
					return;
				}

				if (sub === "stop") {
					await sessionRef.stop();
					persistVoicePrefs(pi);
					return;
				}

				// Bare `/voice` or explicit toggle — start when idle, stop when live.
				if (sub === "" || sub === "toggle") {
					const action = await sessionRef.toggle(startOpts);
					persistVoicePrefs(pi);
					if (action === "started" && sessionRef.getState() === "listening") {
						reportVoiceStatus(ctx);
					}
					return;
				}

				if (sub === "mode") {
					const { rest } = parseVoiceArgs(args);
					const next = (rest[0] ?? "").toLowerCase();
					if (next !== "transcription" && next !== "conversational") {
						ctx.ui.notify(
							`Usage: /voice mode transcription|conversational (current=${sessionRef.getConfig().mode})`,
							"warning",
						);
						return;
					}
					const prev = sessionRef.getConfig().mode;
					sessionRef.setMode(next);
					persistVoicePrefs(pi);
					const live = sessionRef.isLive() ? " (applied to live session)" : "";
					ctx.ui.notify(
						prev === next
							? `voice mode already ${next}`
							: `voice mode ${prev} → ${next}${live}`,
						"info",
					);
					reportVoiceStatus(ctx);
					return;
				}

				ctx.ui.notify(
					`Unknown /voice subcommand "${sub}". Try start|stop|status|toggle|mode (or ctrl+shift+v).`,
					"warning",
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`voice failed: ${message}`, "error");
				ctx.ui.setStatus?.("voice", `voice: error: ${message}`);
			}
		},
	});
}
