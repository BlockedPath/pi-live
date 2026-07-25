/**
 * WebRTC media bridge for the Codex app-server realtime V3 backend (VS9).
 *
 * The app-server's V3 bidirectional realtime authenticates with ChatGPT/Codex
 * OAuth ONLY over the WebRTC transport. The WebSocket transport (PCM via
 * `thread/realtime/appendAudio`) requires an OpenAI API key on ChatGPT-OAuth
 * accounts. This module owns the `RTCPeerConnection`:
 *
 *   mic PCM (24 kHz Int16) ─► RTCAudioSource.onData ─► (Opus/RTP) ─► peer
 *   peer ─► RTCAudioSink.ondata ─► resample 48→24 kHz mono ─► audio.delta
 *
 * Signaling (SDP offer/answer) is exchanged over JSON-RPC by the backend:
 *   thread/realtime/start  → { transport:{type:"webrtc", sdp:<offer>} }
 *   thread/realtime/sdp    ← { sdp:<answer> }   (notification)
 *
 * `@koush/wrtc` (a Node WebRTC native addon, N-API v3) provides the
 * `RTCPeerConnection` + nonstandard `RTCAudioSource`/`RTCAudioSink`. It is
 * loaded lazily so the default install only pays for it when the codex WebRTC
 * path is used. The module is injectable for unit tests (no native binary).
 *
 * Audio is 16-bit PCM. The mic arrives at the session's 24 kHz rate (Opus
 * accepts 24 kHz input natively, so no upsampling is needed). The remote track
 * is Opus decoded — usually 48 kHz — and is resampled to 24 kHz mono for the
 * existing `PcmStreamPlayer`.
 */

import { createRequire } from "node:module";

/** Decoded audio frame from {@link WrtcAudioSink}. */
export interface WrtcAudioFrame {
	samples: Int16Array;
	sampleRate: number;
	bitsPerSample: number;
	channelCount: number;
	numberOfFrames: number;
}

/** PCM chunk pushed into the audio source (10 ms of 16-bit mono). */
export interface WrtcAudioData {
	samples: Int16Array;
	sampleRate: number;
	bitsPerSample?: number;
	channelCount?: number;
	numberOfFrames?: number;
}

export interface WrtcTrack {
	kind: string;
	enabled: boolean;
	stop(): void;
}

export interface WrtcRtpReceiver {
	track: WrtcTrack;
}

export interface WrtcTrackEvent {
	track: WrtcTrack;
	receiver: WrtcRtpReceiver;
	transceivers: unknown[];
}

export interface WrtcSessionDescription {
	type: string;
	sdp: string;
}

export interface WrtcPeerConnection {
	readonly localDescription: WrtcSessionDescription | null;
	readonly connectionState: string;
	readonly iceGatheringState: string;
	addTrack(track: WrtcTrack): WrtcRtpReceiver;
	createOffer(): Promise<WrtcSessionDescription>;
	setLocalDescription(desc: WrtcSessionDescription): Promise<void>;
	setRemoteDescription(desc: WrtcSessionDescription): Promise<void>;
	ontrack: ((e: WrtcTrackEvent) => void) | null;
	onconnectionstatechange: (() => void) | null;
	close(): void;
}

export interface WrtcAudioSource {
	createTrack(): WrtcTrack;
	onData(data: WrtcAudioData): void;
}

export interface WrtcAudioSink {
	readonly stopped: boolean;
	ondata: ((frame: WrtcAudioFrame) => void) | null;
	stop(): void;
}

/** Injectable shape of the `@koush/wrtc` module (loaded lazily in production). */
export interface WrtcModule {
	RTCPeerConnection: new (config?: unknown) => WrtcPeerConnection;
	RTCSessionDescription: new (init: {
		type: string;
		sdp: string;
	}) => WrtcSessionDescription;
	nonstandard: {
		RTCAudioSource: new () => WrtcAudioSource;
		RTCAudioSink: new (track: WrtcTrack) => WrtcAudioSink;
	};
}

let cachedWrtc: WrtcModule | undefined;

/**
 * Lazily require `@koush/wrtc`. Throws a typed error if the native binary is
 * missing (e.g. install scripts were blocked) so the backend can surface it.
 */
export function loadWrtc(): WrtcModule {
	if (cachedWrtc) return cachedWrtc;
	const req = createRequire(import.meta.url);
	let mod: WrtcModule;
	try {
		mod = req("@koush/wrtc") as WrtcModule;
	} catch {
		throw new Error(
			"codex WebRTC backend requires the `@koush/wrtc` native module. " +
				"Run `npm install @koush/wrtc` in extensions/pi-live and ensure its " +
				"prebuilt binary downloaded (npm install-scripts may need approval, " +
				"or run `npx node-pre-gyp install --directory=node_modules/@koush/wrtc`).",
		);
	}
	if (!mod?.RTCPeerConnection || !mod?.nonstandard?.RTCAudioSource) {
		throw new Error(
			"`@koush/wrtc` loaded but is missing the nonstandard audio APIs — " +
				"the prebuilt binary likely did not install. See the README install note.",
		);
	}
	cachedWrtc = mod;
	return mod;
}

/** Inject a (mock) module for tests, or pre-load the real one. */
export function setWrtc(mod: WrtcModule | undefined): void {
	cachedWrtc = mod;
}

/** 10 ms of 16-bit mono PCM at the session rate (24 kHz → 240 samples). */
function framesPerTick(sampleRate: number): number {
	return Math.round(sampleRate / 100);
}

/** Downmix an interleaved Int16 frame to mono by averaging channels. */
function downmixMono(frame: WrtcAudioFrame): Int16Array {
	if (frame.channelCount <= 1) return frame.samples;
	const out = new Int16Array(frame.numberOfFrames);
	const ch = frame.channelCount;
	for (let i = 0; i < frame.numberOfFrames; i++) {
		let sum = 0;
		for (let c = 0; c < ch; c++) sum += frame.samples[i * ch + c] ?? 0;
		out[i] = Math.round(sum / ch);
	}
	return out;
}

/**
 * Linear-resample a mono Int16 buffer from `inRate` to `outRate`.
 * Good enough for voice; avoids a heavy resampler dependency.
 */
export function resampleMono(
	input: Int16Array,
	inRate: number,
	outRate: number,
): Int16Array {
	if (inRate === outRate) return input;
	const ratio = inRate / outRate;
	const outLen = Math.round(input.length / ratio);
	const out = new Int16Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const srcPos = i * ratio;
		const i0 = Math.floor(srcPos);
		const i1 = Math.min(i0 + 1, input.length - 1);
		const frac = srcPos - i0;
		const s0 = input[i0] ?? 0;
		const s1 = input[i1] ?? 0;
		out[i] = Math.round(s0 + (s1 - s0) * frac);
	}
	return out;
}

export interface CodexWebRtcMediaOptions {
	/** Injectable wrtc (tests). Production loads lazily via {@link loadWrtc}. */
	wrtc?: WrtcModule;
	/** Called with base64 PCM16 @ 24 kHz mono for each decoded remote frame. */
	onAudio: (base64: string, itemId?: string) => void;
	/** Optional state-change logger (connectionState transitions). */
	onState?: (state: string) => void;
	/** Session PCM rate the mic arrives at (default 24000). */
	micSampleRate?: number;
	/** Output PCM rate for the remote audio delta (default 24000). */
	outSampleRate?: number;
}

/**
 * Owns one WebRTC peer connection + audio source/sink for a Codex realtime
 * V3 audio session. The backend drives SDP exchange; this class handles the
 * media plane and emits `audio.delta`-shaped base64 PCM for the session.
 */
export class CodexWebRtcMedia {
	readonly #wrtc: WrtcModule;
	readonly #onAudio: (base64: string, itemId?: string) => void;
	readonly #onState?: (state: string) => void;
	readonly #micRate: number;
	readonly #outRate: number;

	#pc: WrtcPeerConnection | undefined;
	#source: WrtcAudioSource | undefined;
	#track: WrtcTrack | undefined;
	#sink: WrtcAudioSink | undefined;
	/** Leftover mic samples buffered until a full 10 ms frame is available. */
	#micBuf: number[] = [];
	#closed = false;

	constructor(options: CodexWebRtcMediaOptions) {
		this.#wrtc = options.wrtc ?? loadWrtc();
		this.#onAudio = options.onAudio;
		this.#onState = options.onState;
		this.#micRate = options.micSampleRate ?? 24_000;
		this.#outRate = options.outSampleRate ?? 24_000;
	}

	/** Build the local SDP offer (with gathered ICE candidates) to send to the app-server. */
	async createOffer(): Promise<string> {
		const pc = new this.#wrtc.RTCPeerConnection();
		this.#pc = pc;
		const source = new this.#wrtc.nonstandard.RTCAudioSource();
		this.#source = source;
		const track = source.createTrack();
		this.#track = track;
		pc.addTrack(track);

		pc.ontrack = (e) => {
			const sink = new this.#wrtc.nonstandard.RTCAudioSink(e.track);
			this.#sink = sink;
			sink.ondata = (frame) => this.#onRemoteFrame(frame);
		};
		pc.onconnectionstatechange = () => {
			this.#onState?.(pc.connectionState);
		};

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		await this.#waitForIceGathering();
		const sdp = pc.localDescription?.sdp;
		if (!sdp) throw new Error("WebRTC local description (offer) was empty");
		return sdp;
	}

	/** Apply the app-server's SDP answer. */
	async setAnswer(sdp: string): Promise<void> {
		const pc = this.#pc;
		if (!pc) throw new Error("setAnswer before createOffer");
		await pc.setRemoteDescription(
			new this.#wrtc.RTCSessionDescription({ type: "answer", sdp }),
		);
	}

	/**
	 * Feed mic PCM16 mono (little-endian bytes) into the audio source.
	 * Buffers partial 10 ms frames. Called by the backend's `appendAudio`.
	 */
	feedMicBytes(bytes: Uint8Array): void {
		const source = this.#source;
		if (!source || this.#closed) return;
		// Bytes → Int16 (little-endian, signed).
		for (let i = 0; i + 1 < bytes.length; i += 2) {
			const lo = bytes[i] ?? 0;
			const hi = bytes[i + 1] ?? 0;
			this.#micBuf.push((hi << 8) | lo);
		}
		const tick = framesPerTick(this.#micRate);
		while (this.#micBuf.length >= tick) {
			const frame = new Int16Array(tick);
			for (let i = 0; i < tick; i++) frame[i] = this.#micBuf.shift() ?? 0;
			try {
				source.onData({
					samples: frame,
					sampleRate: this.#micRate,
					bitsPerSample: 16,
					channelCount: 1,
					numberOfFrames: tick,
				});
			} catch {
				// Drop a bad frame rather than tear down the session.
			}
		}
	}

	#onRemoteFrame(frame: WrtcAudioFrame): void {
		if (this.#closed) return;
		const mono = downmixMono(frame);
		const resampled = resampleMono(mono, frame.sampleRate, this.#outRate);
		if (resampled.length === 0) return;
		// Int16Array → little-endian bytes → base64.
		const buf = Buffer.allocUnsafe(resampled.length * 2);
		for (let i = 0; i < resampled.length; i++) {
			buf.writeInt16LE(resampled[i] ?? 0, i * 2);
		}
		this.#onAudio(buf.toString("base64"));
	}

	/** Tear down the peer connection and audio source/sink. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#micBuf = [];
		try {
			this.#sink?.stop();
		} catch {
			// ignore
		}
		try {
			this.#track?.stop();
		} catch {
			// ignore
		}
		try {
			this.#pc?.close();
		} catch {
			// ignore
		}
		this.#pc = undefined;
		this.#source = undefined;
		this.#track = undefined;
		this.#sink = undefined;
	}

	#waitForIceGathering(timeoutMs = 5000): Promise<void> {
		const pc = this.#pc;
		if (!pc) return Promise.resolve();
		if (pc.iceGatheringState === "complete") return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(), timeoutMs);
			(timer as NodeJS.Timeout).unref?.();
			const check = () => {
				if (pc.iceGatheringState === "complete") {
					clearTimeout(timer);
					resolve();
				} else {
					setTimeout(check, 50);
				}
			};
			check();
		});
	}
}
