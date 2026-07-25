/**
 * Unit tests for the optional Codex app-server voice backend (VS9 / #16).
 *
 * No real `codex` process and no network are used. Tests inject a fake
 * {@link CodexTransport} that records outbound JSON-RPC lines and lets the
 * test push inbound lines (responses + `thread/realtime/*` notifications).
 *
 * Run: npm test  (node --experimental-strip-types --test)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadVoiceConfig } from "../config.ts";
import { RealtimeClient } from "../realtime-client.ts";
import { createVoiceClient } from "./index.ts";

import {
	CodexAppServerBackend,
	CodexBackendError,
	type CodexSpawnFn,
	type CodexTransport,
} from "./codex-app-server.ts";
import type {
	WrtcAudioFrame,
	WrtcAudioSink,
	WrtcAudioSource,
	WrtcModule,
	WrtcPeerConnection,
	WrtcTrack,
	WrtcTrackEvent,
} from "./codex-webrtc.ts";

/**
 * Mock `@koush/wrtc`. Conversational/audio mode defaults to the WebRTC
 * transport, so tests MUST inject this — otherwise they load the real native
 * addon, open a real peer connection, and keep the event loop alive forever.
 */
class MockWrtc implements WrtcModule {
	/** Every peer connection the backend created (usually one). */
	readonly pcs: MockPeerConnection[] = [];
	readonly sources: MockAudioSource[] = [];
	readonly sinks: MockAudioSink[] = [];

	/** Constructor-callable factories (the backend uses `new`). */
	RTCPeerConnection: WrtcModule["RTCPeerConnection"];
	RTCSessionDescription: WrtcModule["RTCSessionDescription"];
	nonstandard: WrtcModule["nonstandard"];

	constructor() {
		const self = this;
		this.RTCPeerConnection = function () {
			const pc = new MockPeerConnection();
			self.pcs.push(pc);
			return pc;
		} as unknown as WrtcModule["RTCPeerConnection"];
		this.RTCSessionDescription = function (init: {
			type: string;
			sdp: string;
		}) {
			return { type: init.type, sdp: init.sdp };
		} as unknown as WrtcModule["RTCSessionDescription"];
		this.nonstandard = {
			RTCAudioSource: function () {
				const src = new MockAudioSource();
				self.sources.push(src);
				return src;
			} as unknown as WrtcModule["nonstandard"]["RTCAudioSource"],
			RTCAudioSink: function (track: WrtcTrack) {
				const sink = new MockAudioSink(track);
				self.sinks.push(sink);
				return sink;
			} as unknown as WrtcModule["nonstandard"]["RTCAudioSink"],
		};
	}
}

class MockPeerConnection implements WrtcPeerConnection {
	localDescription: { type: string; sdp: string } | null = null;
	remoteDescription: { type: string; sdp: string } | null = null;
	connectionState = "new";
	/** Already complete so createOffer() never polls/waits. */
	iceGatheringState = "complete";
	ontrack: ((e: WrtcTrackEvent) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	readonly addedTracks: WrtcTrack[] = [];
	closed = false;

	addTrack(track: WrtcTrack) {
		this.addedTracks.push(track);
		return { track };
	}
	async createOffer() {
		return {
			type: "offer",
			sdp: "v=0\r\no=- MOCK OFFER\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
		};
	}
	async setLocalDescription(desc: { type: string; sdp: string }) {
		this.localDescription = desc;
	}
	async setRemoteDescription(desc: { type: string; sdp: string }) {
		this.remoteDescription = desc;
	}
	close() {
		this.closed = true;
	}
	/** Simulate the remote assistant audio track arriving. */
	emitTrack(track: WrtcTrack) {
		this.ontrack?.({ track, receiver: { track }, transceivers: [] });
	}
}

class MockAudioSource implements WrtcAudioSource {
	/** Every 10 ms frame the backend pushed. */
	readonly pushed: Int16Array[] = [];
	readonly track: WrtcTrack = { kind: "audio", enabled: true, stop() {} };
	createTrack() {
		return this.track;
	}
	onData(data: { samples: Int16Array }) {
		this.pushed.push(data.samples);
	}
}

class MockAudioSink implements WrtcAudioSink {
	stopped = false;
	ondata: ((frame: WrtcAudioFrame) => void) | null = null;
	readonly track: WrtcTrack;
	constructor(track: WrtcTrack) {
		this.track = track;
	}
	stop() {
		this.stopped = true;
	}
	/** Simulate decoded remote PCM arriving from the peer. */
	emit(frame: WrtcAudioFrame) {
		this.ondata?.(frame);
	}
}

/** Minimal fake transport — captures sent lines, lets tests deliver lines. */
class FakeTransport implements CodexTransport {
	readonly sent: string[] = [];
	#lineCbs = new Set<(line: string) => void>();
	#errCbs = new Set<(err: Error) => void>();
	#closeCbs = new Set<() => void>();
	#closed = false;

	send(line: string): void {
		if (this.#closed) throw new Error("transport closed");
		this.sent.push(line);
	}
	onLine(cb: (line: string) => void): void {
		this.#lineCbs.add(cb);
	}
	onError(cb: (err: Error) => void): void {
		this.#errCbs.add(cb);
	}
	onClose(cb: () => void): void {
		this.#closeCbs.add(cb);
	}
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const cb of this.#closeCbs) cb();
	}

	/** Test helper: deliver a raw (possibly malformed) line to the backend. */
	pushRawLine(line: string): void {
		for (const cb of this.#lineCbs) cb(line);
	}
	/** Test helper: deliver one JSON-RPC message (object → JSON line). */
	receive(msg: Record<string, unknown>): void {
		for (const cb of this.#lineCbs) cb(JSON.stringify(msg));
	}
	/** Test helper: fire a transport error. */
	fail(err: Error): void {
		for (const cb of this.#errCbs) cb(err);
	}
	/** Test helper: signal the transport closed unexpectedly. */
	drop(): void {
		this.#closed = true;
		for (const cb of this.#closeCbs) cb();
	}

	sentOfType(type: string): unknown[] {
		return this.sent
			.map((s) => JSON.parse(s) as { method?: string })
			.filter((m) => m.method === type);
	}
	lastSentOfType(type: string): Record<string, unknown> | undefined {
		const arr = this.sentOfType(type) as Array<{ params?: unknown }>;
		const params = arr[arr.length - 1]?.params;
		return params && typeof params === "object"
			? (params as Record<string, unknown>)
			: undefined;
	}
}

/**
 * Drive the full handshake for a happy-path connect.
 * Returns the backend after `thread/realtime/started` resolves connect.
 */
async function happyConnect(
	backend: CodexAppServerBackend,
	transport: FakeTransport,
	mode: "transcription" | "conversational" = "transcription",
): Promise<void> {
	const connectPromise = backend.connect(
		{},
		{
			model: "gpt-realtime-2.1",
			voice: "marin",
			sampleRate: 24_000,
			mode,
		},
	);
	// initialize response
	await waitSent(transport, "initialize", 1);
	transport.receive({ id: 1, result: { codexHome: "/tmp/codex" } });
	// initialized notification (no id) — server just acks; thread/start next
	await waitSent(transport, "thread/start", 1);
	transport.receive({ id: 2, result: { thread: { id: "thr_123" } } });
	// thread/realtime/start
	await waitSent(transport, "thread/realtime/start", 1);
	transport.receive({ id: 3, result: {} });
	// thread/realtime/started notification
	transport.receive({
		method: "thread/realtime/started",
		params: {
			threadId: "thr_123",
			realtimeSessionId: "rsess_1",
			version: mode === "transcription" ? "v2" : "v3",
		},
	});
	await connectPromise;
}

/** Wait until `n` messages of `type` have been sent. */
function waitSent(
	transport: FakeTransport,
	type: string,
	n: number,
): Promise<void> {
	return new Promise((resolve) => {
		const check = () => {
			if (transport.sentOfType(type).length >= n) resolve();
			else setImmediate(check);
		};
		check();
	});
}

describe("voice backend selection", () => {
	it("keeps openai as the default and ignores invalid values", () => {
		assert.equal(loadVoiceConfig({}).backend, "openai");
		assert.equal(loadVoiceConfig({ PI_VOICE_BACKEND: "unknown" }).backend, "openai");
		assert.ok(createVoiceClient(loadVoiceConfig({})) instanceof RealtimeClient);
	});

	it("selects Codex only with PI_VOICE_BACKEND=codex", () => {
		const config = loadVoiceConfig({ PI_VOICE_BACKEND: "codex" });
		assert.equal(config.backend, "codex");
		assert.ok(createVoiceClient(config) instanceof CodexAppServerBackend);
	});
});

describe("CodexAppServerBackend — handshake", () => {
	it("reports cli_missing clearly when Codex is absent", async () => {
		const spawnMissing: CodexSpawnFn = () => {
			throw new Error("spawn codex ENOENT");
		};
		const backend = new CodexAppServerBackend({ spawn: spawnMissing });
		await assert.rejects(backend.connect({}, {}), (err: unknown) => {
			assert.ok(err instanceof CodexBackendError);
			assert.equal((err as CodexBackendError).code, "cli_missing");
			assert.match((err as Error).message, /Codex CLI on PATH/);
			return true;
		});
	});

	it("connects via initialize → thread/start → thread/realtime/start (v2 text)", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);
		assert.equal(backend.connected, true);

		const init = transport.lastSentOfType("initialize");
		const clientInfo = init?.clientInfo as { name?: string } | undefined;
		const capabilities = init?.capabilities as
			| { experimentalApi?: boolean }
			| undefined;
		assert.equal(clientInfo?.name, "pi-live-voice");
		assert.equal(capabilities?.experimentalApi, true);

		const realtime = transport.lastSentOfType("thread/realtime/start");
		assert.equal(realtime?.threadId, "thr_123");
		assert.equal(realtime?.outputModality, "text");
		assert.equal(realtime?.version, "v2");
		assert.equal(realtime?.model, "gpt-realtime-2.1");
		assert.equal(realtime?.voice, "marin");
	});

	it("uses audio outputModality over WebRTC in conversational mode", async () => {
		const transport = new FakeTransport();
		const wrtc = new MockWrtc();
		const backend = new CodexAppServerBackend({
			transport,
			skipDetect: true,
			wrtc,
		});
		await happyConnect(backend, transport, "conversational");
		const realtime = transport.lastSentOfType("thread/realtime/start");
		assert.equal(realtime?.outputModality, "audio");
		assert.equal(realtime?.version, "v3");
		// Default `marin` is NOT a V3 voice — it must be dropped, not forwarded.
		assert.equal(realtime?.voice, undefined);
		// G7: audio realtime must negotiate WebRTC (the only OAuth-capable path),
		// carrying a locally generated SDP offer.
		const rtcTransport = realtime?.transport as
			| { type?: string; sdp?: string }
			| undefined;
		assert.equal(rtcTransport?.type, "webrtc");
		assert.match(String(rtcTransport?.sdp), /^v=0/);
		assert.match(String(rtcTransport?.sdp), /m=audio/);
		// A local audio track was added to the peer connection.
		assert.equal(wrtc.pcs.length, 1);
		assert.equal(wrtc.pcs[0]?.addedTracks.length, 1);
		backend.close();
	});

	it("transcription mode stays on the WebSocket transport (no WebRTC)", async () => {
		const transport = new FakeTransport();
		const wrtc = new MockWrtc();
		const backend = new CodexAppServerBackend({
			transport,
			skipDetect: true,
			wrtc,
		});
		await happyConnect(backend, transport, "transcription");
		const realtime = transport.lastSentOfType("thread/realtime/start");
		assert.equal(realtime?.transport, undefined);
		assert.equal(wrtc.pcs.length, 0, "no peer connection for text mode");
	});

	it("forwards a supported V3 voice in conversational mode", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({
			transport,
			skipDetect: true,
			wrtc: new MockWrtc(),
		});
		const connectPromise = backend.connect(
			{},
			{ model: "gpt-realtime-2.1", voice: "juniper", mode: "conversational" },
		);
		await waitSent(transport, "initialize", 1);
		transport.receive({ id: 1, result: { codexHome: "/tmp/codex" } });
		await waitSent(transport, "thread/start", 1);
		transport.receive({ id: 2, result: { thread: { id: "thr_123" } } });
		await waitSent(transport, "thread/realtime/start", 1);
		transport.receive({ id: 3, result: {} });
		transport.receive({
			method: "thread/realtime/started",
			params: { threadId: "thr_123", realtimeSessionId: "rsess_1", version: "v3" },
		});
		await connectPromise;
		const realtime = transport.lastSentOfType("thread/realtime/start");
		assert.equal(realtime?.voice, "juniper");
		// G8: the WebRTC session is minted from Codex's own config and rejects a
		// client-supplied model, so PI_VOICE_MODEL must not be forwarded here.
		assert.equal(realtime?.model, undefined);
		backend.close();
	});

	it("forwards the model on the WebSocket transport but not over WebRTC (G8)", async () => {
		// Transcription/text keeps the WebSocket path, which does accept a model.
		const wsTransport = new FakeTransport();
		const wsBackend = new CodexAppServerBackend({
			transport: wsTransport,
			skipDetect: true,
			wrtc: new MockWrtc(),
		});
		await happyConnect(wsBackend, wsTransport, "transcription");
		assert.equal(
			wsTransport.lastSentOfType("thread/realtime/start")?.model,
			"gpt-realtime-2.1",
		);
		wsBackend.close();

		// An explicit webrtc override on text must also drop the model.
		const rtcTransport = new FakeTransport();
		const rtcBackend = new CodexAppServerBackend({
			transport: rtcTransport,
			skipDetect: true,
			wrtc: new MockWrtc(),
			realtimeTransport: "webrtc",
		});
		await happyConnect(rtcBackend, rtcTransport, "transcription");
		assert.equal(
			rtcTransport.lastSentOfType("thread/realtime/start")?.model,
			undefined,
		);
		rtcBackend.close();
	});

	it("rejects when thread/realtime/error arrives before started", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		const p = backend.connect({}, { mode: "transcription" });
		await waitSent(transport, "initialize", 1);
		transport.receive({ id: 1, result: { codexHome: "/tmp" } });
		await waitSent(transport, "thread/start", 1);
		transport.receive({ id: 2, result: { thread: { id: "thr_x" } } });
		await waitSent(transport, "thread/realtime/start", 1);
		transport.receive({ id: 3, result: {} });
		transport.receive({
			method: "thread/realtime/error",
			params: { threadId: "thr_x", message: "realtime disabled" },
		});
		await assert.rejects(p, (err: unknown) => {
			assert.ok(
				err instanceof CodexBackendError,
				"should be CodexBackendError",
			);
			assert.equal((err as CodexBackendError).code, "no_realtime");
			return true;
		});
	});

	it("handles a realtime start request error without an unhandled waiter", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		const p = backend.connect({}, { mode: "transcription" });
		await waitSent(transport, "initialize", 1);
		transport.receive({ id: 1, result: { codexHome: "/tmp" } });
		await waitSent(transport, "thread/start", 1);
		transport.receive({ id: 2, result: { thread: { id: "thr_x" } } });
		await waitSent(transport, "thread/realtime/start", 1);
		transport.receive({
			id: 3,
			error: { code: -32600, message: "experimental capability required" },
		});
		await assert.rejects(p, /experimental capability required/);
	});

	it("rejects with not_running when the transport closes before started", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		const p = backend.connect({}, { mode: "transcription" });
		await waitSent(transport, "initialize", 1);
		transport.receive({ id: 1, result: { codexHome: "/tmp" } });
		await waitSent(transport, "thread/start", 1);
		// App-server exits before thread/start responds.
		transport.drop();
		await assert.rejects(p, (err: unknown) => {
			assert.ok(err instanceof CodexBackendError);
			assert.equal((err as CodexBackendError).code, "closed");
			return true;
		});
	});

	it("rejects when thread/start returns no thread id", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		const p = backend.connect({}, { mode: "transcription" });
		await waitSent(transport, "initialize", 1);
		transport.receive({ id: 1, result: {} });
		await waitSent(transport, "thread/start", 1);
		transport.receive({ id: 2, result: { thread: {} } });
		await assert.rejects(p, (err: unknown) => {
			assert.ok(err instanceof CodexBackendError);
			assert.equal((err as CodexBackendError).code, "handshake");
			return true;
		});
	});
});

describe("CodexAppServerBackend — event mapping", () => {
	it("maps user transcript/delta + transcript/done to transcript.delta/done and synthesized speech markers", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);

		const deltas: unknown[] = [];
		const dones: unknown[] = [];
		const speeches: unknown[] = [];
		backend.on("transcript.delta", (e) => deltas.push(e));
		backend.on("transcript.done", (e) => dones.push(e));
		backend.on("speech.started", (e) => speeches.push(e));
		backend.on("speech.stopped", (e) => speeches.push(e));

		transport.receive({
			method: "thread/realtime/transcript/delta",
			params: { threadId: "thr_123", role: "user", delta: "list " },
		});
		transport.receive({
			method: "thread/realtime/transcript/delta",
			params: { threadId: "thr_123", role: "user", delta: "files" },
		});
		transport.receive({
			method: "thread/realtime/transcript/done",
			params: { threadId: "thr_123", role: "user", text: "list files" },
		});

		assert.equal(deltas.length, 2);
		assert.equal((deltas[0] as { text: string }).text, "list ");
		assert.equal(dones.length, 1);
		assert.equal(
			(dones[0] as { text: string; type: string }).text,
			"list files",
		);
		assert.equal((dones[0] as { type: string }).type, "final");
		// G2: synthesized speech.started then speech.stopped
		assert.equal(speeches.length, 2);
		assert.equal((speeches[0] as { type: string }).type, "speech_started");
		assert.equal((speeches[1] as { type: string }).type, "speech_stopped");
	});

	it("maps assistant transcript events to assistant_transcript.* and emits audio.done (G3)", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);

		const aDeltas: unknown[] = [];
		const aDones: unknown[] = [];
		const audioDones: unknown[] = [];
		backend.on("assistant_transcript.delta", (e) => aDeltas.push(e));
		backend.on("assistant_transcript.done", (e) => aDones.push(e));
		backend.on("audio.done", (e) => audioDones.push(e));

		transport.receive({
			method: "thread/realtime/transcript/delta",
			params: { threadId: "thr_123", role: "assistant", delta: "ok" },
		});
		transport.receive({
			method: "thread/realtime/transcript/done",
			params: { threadId: "thr_123", role: "assistant", text: "ok, done" },
		});

		assert.equal(aDeltas.length, 1);
		assert.equal(aDones.length, 1);
		assert.equal((aDones[0] as { text: string }).text, "ok, done");
		assert.equal(audioDones.length, 1);
	});

	it("maps outputAudio/delta to audio.delta with base64 data", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);

		const audioDeltas: unknown[] = [];
		backend.on("audio.delta", (e) => audioDeltas.push(e));
		transport.receive({
			method: "thread/realtime/outputAudio/delta",
			params: {
				threadId: "thr_123",
				audio: {
					data: "AQID",
					sampleRate: 24000,
					numChannels: 1,
					itemId: "i_1",
				},
			},
		});
		assert.equal(audioDeltas.length, 1);
		assert.equal((audioDeltas[0] as { delta: string }).delta, "AQID");
		assert.equal((audioDeltas[0] as { itemId: string }).itemId, "i_1");
	});

	it("surfaces thread/realtime/error as a client error event", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);
		const errors: unknown[] = [];
		backend.on("error", (e) => errors.push(e));
		transport.receive({
			method: "thread/realtime/error",
			params: { threadId: "thr_123", message: "boom" },
		});
		assert.equal(errors.length, 1);
		assert.match((errors[0] as { message: string }).message, /boom/);
	});

	it("surfaces thread/realtime/closed as a client close event", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);
		const closes: unknown[] = [];
		backend.on("close", (e) => closes.push(e));
		transport.receive({
			method: "thread/realtime/closed",
			params: { threadId: "thr_123", reason: "session ended" },
		});
		assert.equal(closes.length, 1);
		assert.equal((closes[0] as { reason: string }).reason, "session ended");
	});
});

describe("CodexAppServerBackend — audio + lifecycle", () => {
	it("appendAudio sends thread/realtime/appendAudio with base64 PCM", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);
		transport.sent.length = 0; // clear handshake
		const pcm = new Uint8Array([1, 2, 3, 4]);
		backend.appendAudio(pcm);
		await waitSent(transport, "thread/realtime/appendAudio", 1);
		const msg = transport.lastSentOfType("thread/realtime/appendAudio");
		assert.equal(msg?.threadId, "thr_123");
		const audio = msg?.audio as
			| { data?: string; sampleRate?: number; numChannels?: number }
			| undefined;
		assert.equal(typeof audio?.data, "string");
		assert.equal(audio?.sampleRate, 24_000);
		assert.equal(audio?.numChannels, 1);
		// round-trips to the original bytes
		assert.deepEqual(
			Array.from(Buffer.from(audio?.data ?? "", "base64")),
			[1, 2, 3, 4],
		);
	});

	it("appendAudio before connect is a safe no-op (no throw, no send)", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		backend.appendAudio(new Uint8Array([9, 9]));
		assert.equal(transport.sentOfType("thread/realtime/appendAudio").length, 0);
	});

	it("close sends thread/realtime/stop and emits a client close event", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);
		const closes: unknown[] = [];
		backend.on("close", (e) => closes.push(e));
		backend.close();
		// stop was requested (best-effort) before teardown
		assert.ok(
			transport.sentOfType("thread/realtime/stop").length >= 1,
			"should send thread/realtime/stop",
		);
		assert.ok(closes.length >= 1, "should emit a close event");
		assert.equal(backend.connected, false);
	});

	it("an unexpected transport close after connect emits a close event (reconnect path)", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);
		const closes: unknown[] = [];
		backend.on("close", (e) => closes.push(e));
		transport.drop();
		assert.ok(closes.length >= 1);
		assert.equal((closes[closes.length - 1] as { code: number }).code, 1006);
	});

	it("updateSession is a safe no-op (G5)", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);
		transport.sent.length = 0;
		assert.doesNotThrow(() =>
			backend.updateSession({ mode: "conversational" }),
		);
		// No session.update-style message sent to codex.
		assert.equal(transport.sent.length, 0);
	});
});

describe("CodexAppServerBackend — WebRTC media (G7)", () => {
	/** Connect in conversational mode with a mock wrtc, returning the pieces. */
	async function connectWebRtc() {
		const transport = new FakeTransport();
		const wrtc = new MockWrtc();
		const backend = new CodexAppServerBackend({
			transport,
			skipDetect: true,
			wrtc,
		});
		await happyConnect(backend, transport, "conversational");
		return { backend, transport, wrtc };
	}

	it("applies the app-server SDP answer to the peer connection", async () => {
		const { backend, transport, wrtc } = await connectWebRtc();
		const answer = "v=0\r\no=- MOCK ANSWER\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
		transport.receive({
			method: "thread/realtime/sdp",
			params: { threadId: "thr_123", sdp: answer },
		});
		// setRemoteDescription is async; let the microtask queue drain.
		await new Promise((r) => setImmediate(r));
		const pc = wrtc.pcs[0];
		assert.equal(pc?.remoteDescription?.type, "answer");
		assert.equal(pc?.remoteDescription?.sdp, answer);
		backend.close();
	});

	it("feeds mic PCM into the audio track as 10 ms frames (not JSON-RPC)", async () => {
		const { backend, transport, wrtc } = await connectWebRtc();
		transport.sent.length = 0;
		// 25 ms of 24 kHz mono PCM16 = 600 samples = 1200 bytes.
		const samples = 600;
		const pcm = new Uint8Array(samples * 2);
		for (let i = 0; i < samples; i++) {
			// Include negative values to catch signed-encoding bugs.
			const v = i % 2 === 0 ? 1000 : -1000;
			pcm[i * 2] = v & 0xff;
			pcm[i * 2 + 1] = (v >> 8) & 0xff;
		}
		backend.appendAudio(pcm);

		const src = wrtc.sources[0];
		// 600 samples @ 24 kHz = two full 240-sample frames, 120 buffered.
		assert.equal(src?.pushed.length, 2);
		assert.equal(src?.pushed[0]?.length, 240);
		assert.equal(src?.pushed[0]?.[0], 1000);
		assert.equal(src?.pushed[0]?.[1], -1000, "negative PCM must survive");
		// Nothing went over JSON-RPC on the WebRTC path.
		assert.equal(transport.sentOfType("thread/realtime/appendAudio").length, 0);

		// The remaining 120 samples flush once another 120 arrive.
		backend.appendAudio(new Uint8Array(120 * 2));
		assert.equal(src?.pushed.length, 3);
		backend.close();
	});

	it("emits remote track audio as audio.delta, resampled 48k→24k mono", async () => {
		const { backend, wrtc } = await connectWebRtc();
		const audioDeltas: unknown[] = [];
		backend.on("audio.delta", (e) => audioDeltas.push(e));

		// Simulate the assistant's remote track arriving, then decoded PCM.
		const pc = wrtc.pcs[0];
		assert.ok(pc, "peer connection exists");
		pc.emitTrack({ kind: "audio", enabled: true, stop() {} });
		const sink = wrtc.sinks[0];
		assert.ok(sink, "sink was created for the remote track");

		// 20 ms of 48 kHz mono = 960 samples → 480 samples at 24 kHz.
		const frame = new Int16Array(960);
		for (let i = 0; i < 960; i++) frame[i] = i % 2 === 0 ? 2000 : -2000;
		sink.emit({
			samples: frame,
			sampleRate: 48_000,
			bitsPerSample: 16,
			channelCount: 1,
			numberOfFrames: 960,
		});

		assert.equal(audioDeltas.length, 1);
		const delta = (audioDeltas[0] as { delta: string }).delta;
		const bytes = Buffer.from(delta, "base64");
		// Downsampled to 24 kHz → 480 samples → 960 bytes.
		assert.equal(bytes.length, 960);
		backend.close();
	});

	it("downmixes stereo remote audio to mono", async () => {
		const { backend, wrtc } = await connectWebRtc();
		const audioDeltas: unknown[] = [];
		backend.on("audio.delta", (e) => audioDeltas.push(e));
		wrtc.pcs[0]?.emitTrack({ kind: "audio", enabled: true, stop() {} });
		const sink = wrtc.sinks[0];
		// 10 ms stereo @ 24 kHz = 240 frames × 2 channels = 480 samples.
		const interleaved = new Int16Array(480);
		for (let i = 0; i < 240; i++) {
			interleaved[i * 2] = 1000; // L
			interleaved[i * 2 + 1] = 3000; // R → mono average 2000
		}
		sink?.emit({
			samples: interleaved,
			sampleRate: 24_000,
			bitsPerSample: 16,
			channelCount: 2,
			numberOfFrames: 240,
		});
		const bytes = Buffer.from(
			(audioDeltas[0] as { delta: string }).delta,
			"base64",
		);
		// 240 mono samples, each the average of L/R.
		assert.equal(bytes.length, 480);
		assert.equal(bytes.readInt16LE(0), 2000);
		backend.close();
	});

	it("close() tears down the peer connection, track, and sink", async () => {
		const { backend, wrtc } = await connectWebRtc();
		wrtc.pcs[0]?.emitTrack({ kind: "audio", enabled: true, stop() {} });
		backend.close();
		assert.equal(wrtc.pcs[0]?.closed, true, "peer connection closed");
		assert.equal(wrtc.sinks[0]?.stopped, true, "audio sink stopped");
	});

	it("an SDP answer with no active media plane is ignored", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		// Transcription mode → no WebRTC media; a stray sdp must not throw.
		await happyConnect(backend, transport, "transcription");
		assert.doesNotThrow(() => {
			transport.receive({
				method: "thread/realtime/sdp",
				params: { threadId: "thr_123", sdp: "v=0\r\n" },
			});
		});
		assert.equal(backend.connected, true);
	});
});

describe("CodexAppServerBackend — malformed input", () => {
	it("ignores non-JSON inbound lines without throwing", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);
		// Push a non-JSON line directly via the raw-line helper.
		transport.pushRawLine("not json {{{");
		// No throw, still connected.
		assert.equal(backend.connected, true);
	});

	it("ignores notifications for unknown methods", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport);
		assert.doesNotThrow(() => {
			transport.receive({
				method: "thread/realtime/itemAdded",
				params: { threadId: "thr_123", item: { type: "handoff_request" } },
			});
		});
		assert.equal(backend.connected, true);
	});
});
