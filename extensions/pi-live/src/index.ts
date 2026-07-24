/**
 * pi-live extension — demo skeleton + voice transcription MVP (VS5 / #12)
 * with optional speak-back (VS6 / #13).
 *
 * Install locally (one of):
 *   - `cd extensions/pi-live && pi install .`
 *   - copy/symlink this directory into `.pi/extensions/` and run `/reload`
 *   - quick test: `pi -e ./src/index.ts`
 *
 * See CONTRIBUTING.md and ./README.md for the local development loop.
 *
 * Voice MVP: `/voice start|stop|status` (toggle with bare `/voice`).
 * Auth via Codex OAuth (`~/.codex`) or API key; mic via sox/rec; transcripts
 * bridge into pi via `sendUserMessage`.
 * Optional input device: `PI_VOICE_INPUT_DEVICE='iPhone Microphone'`.
 * Optional TTS: `PI_VOICE_TTS=say|openai|off` (default say on macOS).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	extractLastAssistantText,
	getSharedVoiceSession,
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
	if (info.relayMode && info.relayMode !== "local") parts.push(`relayMode=${info.relayMode}`);
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

export default function (pi: ExtensionAPI) {
	const session = getSharedVoiceSession();
	/** Last assistant text from agent_end — spoken on agent_settled. */
	let pendingSpeakText = "";

	// Surface a small note when a session starts so you can see the extension load.
	pi.on("session_start", async (_event, ctx) => {
		session.bindUi(voiceUiFromCtx(ctx));
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
	pi.on("agent_settled", async (_event, ctx) => {
		session.bindUi(voiceUiFromCtx(ctx));
		session.setAgentBusy(false);
		const text = pendingSpeakText;
		pendingSpeakText = "";
		if (text && session.isLive()) {
			// Fire-and-forget so other extensions are not blocked on TTS.
			void session.speakBack(text);
		}
	});

	// Best-effort teardown on shutdown so sox/ws/tts do not linger.
	pi.on("session_shutdown", async () => {
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

	// VS5+VS6: transcription MVP + optional speak-back.
	pi.registerCommand("voice", {
		description: "Voice: /voice [start|stop|status|toggle] (TTS via PI_VOICE_TTS)",
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
					await sessionRef.start(startOpts);
					// start already notifies; refresh detailed status line
					if (sessionRef.getState() === "listening") {
						reportVoiceStatus(ctx);
					}
					return;
				}

				if (sub === "stop") {
					await sessionRef.stop();
					return;
				}

				// Bare `/voice` or explicit toggle — start when idle, stop when live.
				if (sub === "" || sub === "toggle") {
					const action = await sessionRef.toggle(startOpts);
					if (action === "started" && sessionRef.getState() === "listening") {
						reportVoiceStatus(ctx);
					}
					return;
				}

				// Mode switch is reserved for conversational (#14); acknowledge politely.
				if (sub === "mode") {
					ctx.ui.notify(
						`/voice mode is not available yet (conversational lands in #14). Current mode=${sessionRef.getConfig().mode}.`,
						"warning",
					);
					return;
				}

				ctx.ui.notify(
					`Unknown /voice subcommand "${sub}". Try start|stop|status|toggle.`,
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
