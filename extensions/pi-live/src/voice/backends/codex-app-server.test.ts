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

	it("uses audio outputModality in conversational mode", async () => {
		const transport = new FakeTransport();
		const backend = new CodexAppServerBackend({ transport, skipDetect: true });
		await happyConnect(backend, transport, "conversational");
		const realtime = transport.lastSentOfType("thread/realtime/start");
		assert.equal(realtime?.outputModality, "audio");
		assert.equal(realtime?.version, "v3");
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
