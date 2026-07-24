/**
 * Mic capture via CLI `sox` / `rec` (VS3 / issue #10).
 *
 * Streams PCM16 LE mono at the configured sample rate (default 24 kHz) from the
 * system default input device, or a named device via `device` /
 * `PI_VOICE_INPUT_DEVICE` (e.g. Continuity "iPhone Microphone" on macOS).
 *
 * Requires SoX on PATH (`brew install sox` on macOS). `rec` is preferred for
 * the default device; named devices use `sox -t coreaudio "…"` on Darwin.
 *
 * Manual check (optional):
 *   PI_VOICE_INPUT_DEVICE='iPhone Microphone' \\
 *     node --input-type=module -e "
 *       import { MicCapture } from './src/voice/capture.ts';
 *       const m = new MicCapture({ device: process.env.PI_VOICE_INPUT_DEVICE });
 *       await m.start((c) => console.log('chunk', c.byteLength, m.backend));
 *       setTimeout(() => m.stop(), 2000);
 *     "
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import { defaultVoiceConfig } from "./config.js";
import type { MicCaptureLike } from "./types.js";

const INSTALL_HINT =
	"sox/rec not found on PATH. Install with: brew install sox";

/** Default PCM framing matches OpenAI Realtime GA input (PCM16 LE mono). */
const DEFAULT_SAMPLE_RATE = defaultVoiceConfig.sampleRate;

export interface MicCaptureOptions {
	/** Target sample rate in Hz (SoX resamples the device if needed). */
	sampleRate?: number;
	/**
	 * Named input device (macOS CoreAudio name, e.g. `iPhone Microphone`).
	 * When set, uses `sox -t coreaudio "<name>"` instead of the default device.
	 */
	device?: string;
}

/**
 * Locate an executable on PATH. Returns the first match among `names`.
 */
function findOnPath(names: readonly string[]): string | undefined {
	const pathEnv = process.env.PATH ?? "";
	const dirs = pathEnv.split(delimiter).filter(Boolean);
	for (const name of names) {
		for (const dir of dirs) {
			const full = join(dir, name);
			try {
				accessSync(full, constants.X_OK);
				return full;
			} catch {
				// try next
			}
		}
	}
	return undefined;
}

interface Backend {
	/** Short label exposed as `MicCapture.backend`. */
	label: string;
	command: string;
	args: string[];
	/** Device name when a non-default input was requested. */
	device?: string;
}

function pcmOutputArgs(sampleRate: number): string[] {
	const rate = String(sampleRate);
	// signed-integer 16-bit LE mono raw PCM on stdout
	return [
		"-c",
		"1",
		"-r",
		rate,
		"-b",
		"16",
		"-e",
		"signed-integer",
		"-t",
		"raw",
		"-", // stdout
	];
}

function resolveBackend(sampleRate: number, device?: string): Backend {
	const outArgs = pcmOutputArgs(sampleRate);
	const named = device?.trim() || undefined;

	// Named device: prefer sox + coreaudio on Darwin; fall back to sox -d style name.
	if (named) {
		const sox = findOnPath(["sox"]);
		if (!sox) throw new Error(INSTALL_HINT);
		if (process.platform === "darwin") {
			return {
				label: `sox:coreaudio:${named}`,
				command: sox,
				device: named,
				args: ["-q", "-t", "coreaudio", named, ...outArgs],
			};
		}
		// Non-macOS: treat name as SoX input path/device string.
		return {
			label: `sox:${named}`,
			command: sox,
			device: named,
			args: ["-q", named, ...outArgs],
		};
	}

	const rec = findOnPath(["rec"]);
	if (rec) {
		// rec ≡ sox -d: records from the default capture device.
		return {
			label: "rec",
			command: rec,
			args: ["-q", ...outArgs],
		};
	}

	const sox = findOnPath(["sox"]);
	if (sox) {
		return {
			label: "sox",
			command: sox,
			args: ["-q", "-d", ...outArgs],
		};
	}

	throw new Error(INSTALL_HINT);
}

/**
 * CLI microphone capture → PCM16 LE mono chunks.
 *
 * `start` / `stop` are idempotent-safe: repeated calls do not throw or spawn
 * extra processes. Chunks are raw little-endian int16 frames (2 bytes/sample).
 */
export class MicCapture implements MicCaptureLike {
	readonly #sampleRate: number;
	readonly #device: string | undefined;
	#backendLabel = "none";
	#child: ChildProcessByStdio<null, Readable, Readable> | null = null;
	#stopping: Promise<void> | null = null;
	#onChunk: ((pcm: Buffer) => void) | null = null;
	/** Leftover byte when a chunk ends on an odd boundary (PCM16 = 2 bytes/sample). */
	#pending: Buffer | null = null;

	constructor(options: MicCaptureOptions = {}) {
		const rate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
		if (!Number.isFinite(rate) || rate <= 0) {
			throw new Error(`invalid sampleRate: ${String(options.sampleRate)}`);
		}
		this.#sampleRate = Math.trunc(rate);
		const dev = options.device?.trim();
		this.#device = dev || undefined;
	}

	/** Active capture backend (`rec`, `sox`, `sox:coreaudio:…`, or `none`). */
	get backend(): string {
		return this.#backendLabel;
	}

	/** Configured named input device, if any. */
	get device(): string | undefined {
		return this.#device;
	}

	/** Configured output sample rate in Hz. */
	get sampleRate(): number {
		return this.#sampleRate;
	}

	/** True while a capture child is running. */
	get isRunning(): boolean {
		return this.#child !== null && this.#stopping === null;
	}

	/**
	 * Begin streaming mic PCM to `onChunk`.
	 * No-op if already capturing. Rejects with an install hint if sox/rec is missing.
	 */
	async start(onChunk: (pcm: Buffer) => void): Promise<void> {
		if (this.#child) {
			// Already running — swap callback so callers can re-bind safely.
			this.#onChunk = onChunk;
			return;
		}

		// If a prior stop is draining, wait it out before respawning.
		if (this.#stopping) {
			await this.#stopping;
		}

		const backend = resolveBackend(this.#sampleRate, this.#device);
		this.#backendLabel = backend.label;
		this.#onChunk = onChunk;

		const child = spawn(backend.command, backend.args, {
			stdio: ["ignore", "pipe", "pipe"],
			// Detach from a controlling TTY so SoX device prompts don't steal input.
			detached: false,
			env: process.env,
		});

		this.#child = child;

		child.stdout.on("data", (chunk: Buffer) => {
			this.#emitPcm(chunk);
		});

		// Surface spawn-time failures (ENOENT etc.) before we resolve.
		await new Promise<void>((resolve, reject) => {
			let settled = false;

			const onSpawn = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};

			const onError = (err: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				this.#cleanupChild();
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new Error(INSTALL_HINT));
					return;
				}
				reject(err);
			};

			// If the process exits immediately, treat it as a failure to start.
			const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
				if (settled) return;
				settled = true;
				cleanup();
				this.#cleanupChild();
				let detail = "unknown reason";
				if (code !== null) detail = `exit code ${code}`;
				else if (signal) detail = `signal ${signal}`;
				reject(new Error(`mic capture failed to start (${backend.label}: ${detail})`));
			};

			const cleanup = (): void => {
				child.off("spawn", onSpawn);
				child.off("error", onError);
				child.off("exit", onExit);
			};

			child.once("spawn", onSpawn);
			child.once("error", onError);
			child.once("exit", onExit);

			// Some Node versions emit neither spawn nor error if the binary is
			// missing until the next tick — also check killed/exitCode quickly.
			if (child.exitCode !== null || child.killed) {
				onExit(child.exitCode, null);
			}
		});

		// After a successful start, clear child state when the process ends so
		// a later start() can respawn without an explicit stop().
		child.once("exit", () => {
			if (this.#child === child) {
				this.#cleanupChild();
			}
		});
		child.once("error", () => {
			if (this.#child === child) {
				this.#cleanupChild();
			}
		});
	}

	/**
	 * Stop capture and wait for the child to exit.
	 * No-op if not running. Safe to call concurrently (shares one stop promise).
	 */
	async stop(): Promise<void> {
		if (this.#stopping) {
			return this.#stopping;
		}

		const child = this.#child;
		if (!child) {
			return;
		}

		this.#stopping = new Promise<void>((resolve) => {
			const finish = (): void => {
				this.#cleanupChild();
				this.#stopping = null;
				resolve();
			};

			if (child.exitCode !== null || child.killed) {
				finish();
				return;
			}

			const onExit = (): void => {
				child.off("error", onExit);
				finish();
			};

			child.once("exit", onExit);
			child.once("error", onExit);

			// SIGTERM first; escalate if the device backend hangs.
			try {
				child.kill("SIGTERM");
			} catch {
				finish();
				return;
			}

			const forceTimer = setTimeout(() => {
				try {
					if (child.exitCode === null && !child.killed) {
						child.kill("SIGKILL");
					}
				} catch {
					// ignore
				}
			}, 1500);
			forceTimer.unref?.();

			child.once("exit", () => clearTimeout(forceTimer));
		});

		return this.#stopping;
	}

	#emitPcm(chunk: Buffer): void {
		const cb = this.#onChunk;
		if (!cb || chunk.length === 0) return;

		const buf =
			this.#pending && this.#pending.length > 0
				? Buffer.concat([this.#pending, chunk])
				: chunk;
		const even = buf.length - (buf.length % 2);
		if (even > 0) {
			cb(even === buf.length ? buf : buf.subarray(0, even));
		}
		this.#pending = even < buf.length ? Buffer.from(buf.subarray(even)) : null;
	}

	#cleanupChild(): void {
		this.#child = null;
		this.#onChunk = null;
		this.#pending = null;
	}
}
