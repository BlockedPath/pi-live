/**
 * Voice playback / TTS (VS6 / issue #13).
 *
 * Optional speak-back after an agent turn settles:
 *   - `say` (default on macOS) — offline system TTS
 *   - `openai` — OpenAI audio/speech API + local player (`afplay`/`ffplay`)
 *   - `off` — disabled
 *
 * Coordinates with session via capture pause (caller) and stop-on-barge-in.
 */
import {
	spawn,
	type ChildProcess,
	type SpawnOptions,
} from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { platform } from "node:os";

/** Configured TTS backend. */
export type TtsBackend = "say" | "openai" | "off";

/** Voices that belong to OpenAI TTS — do not pass these to macOS `say -v`. */
const OPENAI_VOICE_NAMES = new Set([
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"fable",
	"marin",
	"nova",
	"onyx",
	"sage",
	"shimmer",
	"verse",
	"cedar",
]);

/** Default max spoken characters — keep talk-back short. */
export const DEFAULT_SPEAK_MAX_CHARS = 280;

export type SpawnFn = (
	command: string,
	args: readonly string[],
	options?: SpawnOptions,
) => ChildProcess;

/** Adapter so Node's overloaded `spawn` matches {@link SpawnFn}. */
const defaultSpawn: SpawnFn = (command, args, options) =>
	spawn(command, args as string[], options ?? {});

export type FetchFn = typeof fetch;

export interface SpeakOptions {
	/** TTS backend. Default: resolved from env / platform. */
	backend?: TtsBackend;
	/** Voice name (`PI_VOICE_VOICE`). OpenAI names ignored for `say`. */
	voice?: string;
	/** API key for OpenAI TTS. */
	apiKey?: string;
	/** OpenAI speech model. Default `gpt-4o-mini-tts`. */
	model?: string;
	/** Truncate spoken text to this many characters. */
	maxChars?: number;
	/** Injectable spawn (tests). */
	spawn?: SpawnFn;
	/** Injectable fetch (tests). */
	fetch?: FetchFn;
	/** Abort when another speak/stop wins. */
	signal?: AbortSignal;
}

export interface VoicePlaybackOptions {
	backend?: TtsBackend;
	voice?: string;
	apiKey?: string;
	model?: string;
	maxChars?: number;
	spawn?: SpawnFn;
	fetch?: FetchFn;
}

type SpeakingHandler = (speaking: boolean) => void;

/**
 * Resolve `PI_VOICE_TTS` (or equivalent raw string) to a backend.
 * Default: `say` on darwin, `off` elsewhere (no reliable offline CLI TTS).
 */
export function resolveTtsBackend(
	raw: string | undefined = process.env.PI_VOICE_TTS,
	os: NodeJS.Platform = platform(),
): TtsBackend {
	const v = raw?.trim().toLowerCase();
	if (v === "say" || v === "openai" || v === "off") return v;
	return os === "darwin" ? "say" : "off";
}

/**
 * Collapse assistant prose into a short speakable line.
 * Prefer the first sentence-ish chunk; hard-cap at `maxChars`.
 */
export function summarizeForSpeech(
	text: string,
	maxChars: number = DEFAULT_SPEAK_MAX_CHARS,
): string {
	let t = text.replace(/\s+/g, " ").trim();
	if (!t) return "";

	// Strip common markdown noise that sounds bad when read aloud.
	t = t
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "")
		.replace(/[*_~]{1,3}/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!t) return "";

	// Prefer a clean first sentence when the whole blob is long.
	if (t.length > maxChars) {
		const sentenceEnd = t.slice(0, maxChars).match(/^[\s\S]+?[.!?…](?=\s|$)/);
		if (sentenceEnd && sentenceEnd[0].length >= 40) {
			t = sentenceEnd[0].trim();
		} else {
			t = t.slice(0, maxChars).trim();
			// Avoid cutting mid-word when possible.
			const lastSpace = t.lastIndexOf(" ");
			if (lastSpace > maxChars * 0.6) t = t.slice(0, lastSpace).trim();
		}
	}

	if (t.length > maxChars) t = t.slice(0, maxChars).trim();
	return t;
}

/**
 * Extract plain text from the last assistant message in a messages array.
 * Structural typing so we do not hard-depend on pi-ai at runtime.
 */
export function extractLastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as {
			role?: unknown;
			content?: unknown;
		} | null;
		if (!msg || msg.role !== "assistant") continue;
		const content = msg.content;
		if (typeof content === "string") {
			const t = content.trim();
			if (t) return t;
			continue;
		}
		if (!Array.isArray(content)) continue;
		const parts: string[] = [];
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				const piece = (block as { text: string }).text.trim();
				if (piece) parts.push(piece);
			}
		}
		const joined = parts.join(" ").trim();
		if (joined) return joined;
	}
	return "";
}

function runProcess(
	command: string,
	args: readonly string[],
	spawnFn: SpawnFn,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("playback aborted"));
			return;
		}

		const child = spawnFn(command, args as string[], {
			stdio: "ignore",
			env: process.env,
		});

		let settled = false;
		const onAbort = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// ignore
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (err) reject(err);
			else resolve();
		};

		child.on("error", (err) => finish(err));
		child.on("close", (code, sig) => {
			if (signal?.aborted) {
				finish(new Error("playback aborted"));
				return;
			}
			if (code === 0 || code === null) {
				finish();
				return;
			}
			finish(new Error(`${command} exited ${code}${sig ? ` (${sig})` : ""}`));
		});
	});
}

async function speakWithSay(
	text: string,
	opts: {
		voice?: string;
		spawn: SpawnFn;
		signal?: AbortSignal;
	},
): Promise<void> {
	const args: string[] = [];
	const voice = opts.voice?.trim();
	if (voice && !OPENAI_VOICE_NAMES.has(voice.toLowerCase())) {
		args.push("-v", voice);
	}
	args.push(text);
	await runProcess("say", args, opts.spawn, opts.signal);
}

async function speakWithOpenAI(
	text: string,
	opts: {
		voice?: string;
		apiKey?: string;
		model?: string;
		spawn: SpawnFn;
		fetch: FetchFn;
		signal?: AbortSignal;
	},
): Promise<void> {
	const apiKey =
		opts.apiKey?.trim() ||
		process.env.PI_VOICE_API_KEY?.trim() ||
		process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"OpenAI TTS requires PI_VOICE_API_KEY or OPENAI_API_KEY (PI_VOICE_TTS=openai)",
		);
	}

	const voice = opts.voice?.trim() || "marin";
	const model = opts.model?.trim() || "gpt-4o-mini-tts";
	const res = await opts.fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			input: text,
			voice,
			response_format: "mp3",
		}),
		signal: opts.signal,
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		const snippet = body.replace(/\s+/g, " ").trim().slice(0, 160);
		throw new Error(
			`OpenAI TTS HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
		);
	}

	const buf = Buffer.from(await res.arrayBuffer());
	const file = join(
		tmpdir(),
		`pi-voice-tts-${randomBytes(8).toString("hex")}.mp3`,
	);
	await writeFile(file, buf);

	try {
		const player = platform() === "darwin" ? "afplay" : "ffplay";
		const args =
			player === "afplay"
				? [file]
				: ["-nodisp", "-autoexit", "-loglevel", "quiet", file];
		await runProcess(player, args, opts.spawn, opts.signal);
	} finally {
		await unlink(file).catch(() => undefined);
	}
}

/** One-shot speak helper (no shared state). */
export async function speak(
	text: string,
	options: SpeakOptions = {},
): Promise<void> {
	const backend = options.backend ?? resolveTtsBackend();
	if (backend === "off") return;

	const spoken = summarizeForSpeech(text, options.maxChars);
	if (!spoken) return;

	const spawnFn = options.spawn ?? defaultSpawn;
	const fetchFn = options.fetch ?? fetch;

	if (backend === "say") {
		await speakWithSay(spoken, {
			voice: options.voice,
			spawn: spawnFn,
			signal: options.signal,
		});
		return;
	}

	await speakWithOpenAI(spoken, {
		voice: options.voice,
		apiKey: options.apiKey,
		model: options.model,
		spawn: spawnFn,
		fetch: fetchFn,
		signal: options.signal,
	});
}

/**
 * Session-scoped playback controller — serializes speaks, supports stop().
 */
export class VoicePlayback {
	#backend: TtsBackend;
	#voice: string | undefined;
	#apiKey: string | undefined;
	#model: string | undefined;
	#maxChars: number;
	readonly #spawn: SpawnFn;
	readonly #fetch: FetchFn;

	#speaking = false;
	#generation = 0;
	#abort: AbortController | undefined;
	readonly #handlers = new Set<SpeakingHandler>();

	constructor(options: VoicePlaybackOptions = {}) {
		this.#backend = options.backend ?? resolveTtsBackend();
		this.#voice = options.voice;
		this.#apiKey = options.apiKey;
		this.#model = options.model;
		this.#maxChars = options.maxChars ?? DEFAULT_SPEAK_MAX_CHARS;
		this.#spawn = options.spawn ?? defaultSpawn;
		this.#fetch = options.fetch ?? fetch;
	}

	get backend(): TtsBackend {
		return this.#backend;
	}

	/** Update backend/voice/apiKey after construction (prefs restore). */
	configure(options: Partial<VoicePlaybackOptions>): void {
		if (options.backend !== undefined) this.#backend = options.backend;
		if (options.voice !== undefined) this.#voice = options.voice;
		if (options.apiKey !== undefined) this.#apiKey = options.apiKey;
		if (options.model !== undefined) this.#model = options.model;
		if (options.maxChars !== undefined) this.#maxChars = options.maxChars;
	}

	isSpeaking(): boolean {
		return this.#speaking;
	}

	/** Subscribe to speaking true/false transitions. */
	onSpeakingChange(handler: SpeakingHandler): () => void {
		this.#handlers.add(handler);
		return () => {
			this.#handlers.delete(handler);
		};
	}

	/** Stop any in-flight playback immediately. */
	stop(): void {
		this.#generation++;
		const abort = this.#abort;
		this.#abort = undefined;
		try {
			abort?.abort();
		} catch {
			// ignore
		}
		this.#setSpeaking(false);
	}

	/**
	 * Speak `text` (summarized). Cancels any prior utterance.
	 * No-op when backend is `off` or text is empty after summarize.
	 */
	async speak(text: string): Promise<void> {
		if (this.#backend === "off") return;

		const spoken = summarizeForSpeech(text, this.#maxChars);
		if (!spoken) return;

		// Cancel previous.
		this.#generation++;
		const gen = this.#generation;
		try {
			this.#abort?.abort();
		} catch {
			// ignore
		}
		const abort = new AbortController();
		this.#abort = abort;
		this.#setSpeaking(true);

		try {
			await speak(spoken, {
				backend: this.#backend,
				voice: this.#voice,
				apiKey: this.#apiKey,
				model: this.#model,
				// Already summarized — pass through without second hard cut issues
				maxChars: Math.max(spoken.length, this.#maxChars),
				spawn: this.#spawn,
				fetch: this.#fetch,
				signal: abort.signal,
			});
		} catch (err) {
			if (abort.signal.aborted || gen !== this.#generation) {
				return;
			}
			throw err;
		} finally {
			if (gen === this.#generation) {
				this.#abort = undefined;
				this.#setSpeaking(false);
			}
		}
	}

	#setSpeaking(next: boolean): void {
		if (this.#speaking === next) return;
		this.#speaking = next;
		for (const handler of this.#handlers) {
			try {
				handler(next);
			} catch {
				// listener errors must not break playback
			}
		}
	}
}


/**
 * Stream PCM16 mono realtime audio out (VS8 conversational).
 *
 * Streams chunks to sox `play` as they arrive so barge-in can kill playback
 * mid-utterance. `stop()` immediately SIGTERMs the player and reports
 * audio_end_ms for conversation.item.truncate.
 */
export interface PcmStreamPlayerOptions {
	sampleRate?: number;
	spawn?: SpawnFn;
	/** Streaming player binary (default: `play` from sox). */
	command?: string;
}

export class PcmStreamPlayer {
	readonly #sampleRate: number;
	readonly #spawn: SpawnFn;
	readonly #command: string;
	readonly #handlers = new Set<SpeakingHandler>();

	#child: ChildProcess | undefined;
	#stdinFailed = false;
	#bytesWritten = 0;
	#itemId: string | undefined;
	#speaking = false;
	#generation = 0;
	/** True once any audio has been accepted for the current assistant turn. */
	#hasAudio = false;

	constructor(options: PcmStreamPlayerOptions = {}) {
		this.#sampleRate = options.sampleRate ?? 24_000;
		this.#spawn = options.spawn ?? defaultSpawn;
		this.#command = options.command ?? "play";
	}

	isSpeaking(): boolean {
		return this.#speaking;
	}

	/** True if this turn received any assistant audio (playing or buffered). */
	hasAudio(): boolean {
		return this.#hasAudio || this.#speaking || Boolean(this.#itemId);
	}

	/** Milliseconds of PCM accepted so far for the current item. */
	getPlayedMs(): number {
		const samples = Math.floor(this.#bytesWritten / 2);
		return Math.floor((samples * 1000) / this.#sampleRate);
	}

	getCurrentItemId(): string | undefined {
		return this.#itemId;
	}

	onSpeakingChange(handler: SpeakingHandler): () => void {
		this.#handlers.add(handler);
		return () => {
			this.#handlers.delete(handler);
		};
	}

	/**
	 * Append a base64 PCM16 chunk and stream it to the player immediately.
	 */
	appendBase64(delta: string, itemId?: string): void {
		if (!delta) return;
		let buf: Buffer;
		try {
			buf = Buffer.from(delta, "base64");
		} catch {
			return;
		}
		if (buf.byteLength === 0) return;

		if (itemId && this.#itemId && itemId !== this.#itemId) {
			// New assistant item — restart the stream.
			this.stop();
		}
		if (itemId) this.#itemId = itemId;

		this.#hasAudio = true;
		this.#bytesWritten += buf.byteLength;
		this.#ensureChild();
		this.#setSpeaking(true);

		const child = this.#child;
		if (!child?.stdin || this.#stdinFailed || child.stdin.destroyed) {
			return;
		}
		try {
			child.stdin.write(buf);
		} catch {
			this.#stdinFailed = true;
		}
	}

	/**
	 * End-of-audio marker from the server. Keeps the player draining; does not
	 * block barge-in (stop() still kills immediately).
	 */
	done(): void {
		const child = this.#child;
		if (child?.stdin && !child.stdin.destroyed) {
			try {
				child.stdin.end();
			} catch {
				// ignore
			}
		}
	}

	/**
	 * Stop playback immediately (barge-in).
	 * @returns item id + audio_end_ms for conversation.item.truncate
	 */
	stop(): { itemId?: string; audioEndMs: number } {
		const itemId = this.#itemId;
		const audioEndMs = this.getPlayedMs();
		this.#generation++;
		const child = this.#child;
		this.#child = undefined;
		this.#stdinFailed = false;
		this.#bytesWritten = 0;
		this.#itemId = undefined;
		this.#hasAudio = false;
		if (child) {
			try {
				// Kill process group if possible so play/sox children die too.
				if (typeof child.pid === "number" && child.pid > 0) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				} else {
					child.kill("SIGKILL");
				}
			} catch {
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore
				}
			}
		}
		this.#setSpeaking(false);
		return { itemId, audioEndMs };
	}

	#ensureChild(): void {
		if (this.#child && !this.#child.killed) return;
		const gen = this.#generation;
		try {
			const child = this.#spawn(
				this.#command,
				[
					"-q",
					"-t",
					"raw",
					"-r",
					String(this.#sampleRate),
					"-e",
					"signed-integer",
					"-b",
					"16",
					"-c",
					"1",
					"--buffer",
					"256",
					"-",
				],
				{
					stdio: ["pipe", "ignore", "ignore"],
					env: process.env,
					// Detached so we can kill the whole group on barge-in.
					detached: true,
				},
			);
			this.#child = child;
			this.#stdinFailed = false;
			child.on("error", () => {
				if (gen !== this.#generation) return;
				this.#child = undefined;
				this.#stdinFailed = true;
				this.#setSpeaking(false);
			});
			child.on("close", () => {
				if (gen !== this.#generation) return;
				if (this.#child === child) this.#child = undefined;
				this.#setSpeaking(false);
			});
		} catch {
			this.#child = undefined;
			this.#stdinFailed = true;
		}
	}

	#setSpeaking(next: boolean): void {
		if (this.#speaking === next) return;
		this.#speaking = next;
		for (const handler of this.#handlers) {
			try {
				handler(next);
			} catch {
				// ignore
			}
		}
	}
}
