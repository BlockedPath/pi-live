/**
 * Mock-WS unit tests for RealtimeClient (VS2 / issue #9).
 * No live API key; runs via `node --experimental-strip-types --test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildDefaultSessionConfig,
	CONVERSATIONAL_INSTRUCTIONS,
	mergeSessionConfig,
	PI_TURN_TOOL,
	RealtimeClient,
	type RealtimeServerEvent,
	type WebSocketFactory,
	type WebSocketLike,
} from "./realtime-client.ts";
import type { FunctionCallEvent, TranscriptEvent } from "./types.ts";

/** Minimal EventEmitter-style mock matching the `ws` surface we use. */
class MockWebSocket implements WebSocketLike {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = MockWebSocket.CONNECTING;
	readonly sent: string[] = [];
	readonly url: string;
	readonly headers: Record<string, string>;

	#listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	#closeCode: number | undefined;
	#closeReason: string | undefined;

	constructor(url: string, options: { headers: Record<string, string> }) {
		this.url = url;
		this.headers = { ...options.headers };
	}

	on(event: string, listener: (...args: unknown[]) => void): void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener);
	}

	send(data: string): void {
		if (this.readyState !== MockWebSocket.OPEN) {
			throw new Error("MockWebSocket is not OPEN");
		}
		this.sent.push(data);
	}

	close(code = 1000, reason = ""): void {
		if (
			this.readyState === MockWebSocket.CLOSED ||
			this.readyState === MockWebSocket.CLOSING
		) {
			return;
		}
		this.readyState = MockWebSocket.CLOSING;
		this.#closeCode = code;
		this.#closeReason = reason;
		this.readyState = MockWebSocket.CLOSED;
		this.#emit("close", code, Buffer.from(reason));
	}

	removeAllListeners(): void {
		this.#listeners.clear();
	}

	/** Test helper: transition to OPEN and fire `open`. */
	open(): void {
		this.readyState = MockWebSocket.OPEN;
		this.#emit("open");
	}

	/** Test helper: deliver a JSON server event. */
	receive(event: RealtimeServerEvent | Record<string, unknown>): void {
		this.#emit("message", Buffer.from(JSON.stringify(event)));
	}

	/** Test helper: fire a socket error. */
	error(err: Error): void {
		this.#emit("error", err);
	}

	get lastSent(): unknown {
		const raw = this.sent[this.sent.length - 1];
		return raw ? JSON.parse(raw) : undefined;
	}

	sentOfType(type: string): unknown[] {
		return this.sent
			.map((s) => JSON.parse(s) as { type: string })
			.filter((e) => e.type === type);
	}

	get closeCode(): number | undefined {
		return this.#closeCode;
	}

	get closeReason(): string | undefined {
		return this.#closeReason;
	}

	#emit(event: string, ...args: unknown[]): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const listener of set) listener(...args);
	}
}

function createHarness(options?: {
	waitForSessionCreated?: boolean;
}): {
	client: RealtimeClient;
	sockets: MockWebSocket[];
	factory: WebSocketFactory;
} {
	const sockets: MockWebSocket[] = [];
	const factory: WebSocketFactory = (url, opts) => {
		const ws = new MockWebSocket(url, opts);
		sockets.push(ws);
		// Open on next tick so connect() can attach listeners first.
		queueMicrotask(() => ws.open());
		return ws;
	};
	const client = new RealtimeClient({
		webSocketFactory: factory,
		waitForSessionCreated: options?.waitForSessionCreated,
	});
	return { client, sockets, factory };
}

async function connectReady(
	client: RealtimeClient,
	sockets: MockWebSocket[],
	headers: Record<string, string> = { Authorization: "Bearer test-token" },
): Promise<MockWebSocket> {
	const pending = client.connect(headers, {
		model: "gpt-realtime-2.1",
		sampleRate: 24_000,
		voice: "marin",
		mode: "transcription",
	});
	// Allow microtask open to run.
	await Promise.resolve();
	const ws = sockets[0];
	assert.ok(ws, "expected mock socket");
	// Deliver session.created so connect() resolves (default wait).
	ws.receive({
		type: "session.created",
		event_id: "evt_1",
		session: { id: "sess_1", model: "gpt-realtime-2.1" },
	});
	await pending;
	return ws;
}

describe("buildDefaultSessionConfig", () => {
	it("always sets type realtime and nested PCM audio", () => {
		const session = buildDefaultSessionConfig({
			model: "gpt-realtime-2.1",
			sampleRate: 24_000,
			voice: "marin",
			mode: "transcription",
		});
		assert.equal(session.type, "realtime");
		assert.equal(session.model, "gpt-realtime-2.1");
		assert.deepEqual(session.output_modalities, ["text"]);
		assert.deepEqual(session.audio?.input?.format, {
			type: "audio/pcm",
			rate: 24_000,
		});
		assert.deepEqual(session.audio?.output?.format, {
			type: "audio/pcm",
			rate: 24_000,
		});
		assert.equal(session.audio?.output?.voice, "marin");
		assert.equal(
			session.audio?.input?.transcription?.model,
			"gpt-4o-mini-transcribe",
		);
	});

	it("uses audio output modalities in conversational mode", () => {
		const session = buildDefaultSessionConfig({
			model: "gpt-realtime-2.1",
			mode: "conversational",
		});
		assert.deepEqual(session.output_modalities, ["audio"]);
		assert.equal(session.instructions, CONVERSATIONAL_INSTRUCTIONS);
		assert.deepEqual(session.tools, [PI_TURN_TOOL]);
		assert.equal(session.tool_choice, "auto");
		assert.equal(
			(session.audio?.input?.turn_detection as { create_response?: boolean })
				?.create_response,
			true,
		);
	});

	it("clears tools in transcription mode", () => {
		const session = buildDefaultSessionConfig({
			model: "gpt-realtime-2.1",
			mode: "transcription",
		});
		assert.deepEqual(session.tools, []);
		assert.equal(session.tool_choice, "none");
	});
});

describe("mergeSessionConfig", () => {
	it("forces type realtime even if partial omits or overrides it", () => {
		const merged = mergeSessionConfig(
			{ type: "realtime", model: "a" },
			{ model: "b", instructions: "hi" } as never,
		);
		assert.equal(merged.type, "realtime");
		assert.equal(merged.model, "b");
		assert.equal(merged.instructions, "hi");
	});

	it("deep-merges audio.input / audio.output", () => {
		const merged = mergeSessionConfig(
			buildDefaultSessionConfig({ model: "m", sampleRate: 24_000 }),
			{
				audio: {
					input: {
						transcription: { model: "whisper-1", language: "en" },
					},
					output: { voice: "cedar" },
				},
			},
		);
		assert.equal(merged.type, "realtime");
		assert.deepEqual(merged.audio?.input?.format, {
			type: "audio/pcm",
			rate: 24_000,
		});
		assert.equal(merged.audio?.input?.transcription?.model, "whisper-1");
		assert.equal(merged.audio?.input?.transcription?.language, "en");
		assert.equal(merged.audio?.output?.voice, "cedar");
	});
});

describe("RealtimeClient", () => {
	it("connects with injected headers and no beta header", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets, {
			Authorization: "Bearer sk-test",
			"ChatGPT-Account-Id": "acct_1",
			"OpenAI-Beta": "realtime=v1",
		});

		assert.equal(
			ws.url,
			"wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
		);
		assert.equal(ws.headers.Authorization, "Bearer sk-test");
		assert.equal(ws.headers["ChatGPT-Account-Id"], "acct_1");
		assert.equal(ws.headers["OpenAI-Beta"], undefined);
		assert.equal(
			Object.keys(ws.headers).some((k) => k.toLowerCase() === "openai-beta"),
			false,
		);
		assert.equal(client.connected, true);

		client.close();
	});

	it("sends session.update with type realtime on open", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);

		const updates = ws.sentOfType("session.update") as Array<{
			type: string;
			session: { type: string; audio?: { input?: unknown; output?: unknown } };
		}>;
		assert.ok(updates.length >= 1);
		const first = updates[0]!;
		assert.equal(first.session.type, "realtime");
		assert.ok(first.session.audio?.input);
		assert.ok(first.session.audio?.output);

		client.close();
	});

	it("emits session.created", async () => {
		const { client, sockets } = createHarness();
		const seen: unknown[] = [];
		client.on("session.created", (session) => {
			seen.push(session);
		});

		await connectReady(client, sockets);
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0], { id: "sess_1", model: "gpt-realtime-2.1" });

		client.close();
	});

	it("appendAudio sends input_audio_buffer.append (base64 + buffer)", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);

		client.appendAudio("AAAA"); // already base64
		const pcm = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
		client.appendAudio(pcm);

		const appends = ws.sentOfType("input_audio_buffer.append") as Array<{
			type: string;
			audio: string;
		}>;
		assert.equal(appends.length, 2);
		assert.equal(appends[0]!.audio, "AAAA");
		assert.equal(appends[1]!.audio, Buffer.from(pcm).toString("base64"));

		client.close();
	});

	it("emits transcript.delta and transcript.done", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);

		const deltas: TranscriptEvent[] = [];
		const dones: TranscriptEvent[] = [];
		client.on("transcript.delta", (ev) => {
			deltas.push(ev);
		});
		client.on("transcript.done", (ev) => {
			dones.push(ev);
		});

		ws.receive({
			type: "conversation.item.input_audio_transcription.delta",
			item_id: "item_1",
			delta: "hello ",
		});
		ws.receive({
			type: "conversation.item.input_audio_transcription.completed",
			item_id: "item_1",
			transcript: "hello world",
		});

		assert.equal(deltas.length, 1);
		assert.equal(deltas[0]!.type, "partial");
		assert.equal(deltas[0]!.text, "hello ");
		assert.equal(deltas[0]!.itemId, "item_1");

		assert.equal(dones.length, 1);
		assert.equal(dones[0]!.type, "final");
		assert.equal(dones[0]!.text, "hello world");
		assert.equal(dones[0]!.itemId, "item_1");

		client.close();
	});

	it("emits typed error events from server error payloads", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);

		const errors: Array<{ message: string; code?: string }> = [];
		client.on("error", (err) => {
			errors.push(err);
		});

		ws.receive({
			type: "error",
			event_id: "evt_err",
			error: {
				type: "invalid_request_error",
				code: "invalid_value",
				message: "bad field",
			},
		});

		assert.equal(errors.length, 1);
		assert.equal(errors[0]!.message, "bad field");
		assert.equal(errors[0]!.code, "invalid_value");

		// Benign barge-in cancel noise must not surface.
		ws.receive({
			type: "error",
			error: {
				message: "Cancellation failed: no active response found",
			},
		});
		assert.equal(errors.length, 1);

		client.close();
	});

	it("updateSession always stamps type realtime", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);

		client.updateSession({
			instructions: "be brief",
			// Prove client forces GA session.type even if a caller passes garbage.
			type: "transcription" as unknown as "realtime",
		});

		const updates = ws.sentOfType("session.update") as Array<{
			session: { type: string; instructions?: string };
		}>;
		const last = updates[updates.length - 1]!;
		assert.equal(last.session.type, "realtime");
		assert.equal(last.session.instructions, "be brief");

		client.close();
	});

	it("close is idempotent and emits close", async () => {
		const { client, sockets } = createHarness();
		await connectReady(client, sockets);

		const closes: Array<{ code: number; reason: string }> = [];
		client.on("close", (info) => {
			closes.push(info);
		});

		client.close();
		client.close();

		assert.equal(client.connected, false);
		assert.equal(closes.length, 1);
		assert.equal(closes[0]!.code, 1000);
		assert.equal(sockets[0]!.closeCode, 1000);
	});

	it("throws on appendAudio when not connected", () => {
		const { client } = createHarness();
		assert.throws(() => client.appendAudio("AAAA"), /not connected/);
	});

	it("emits speech.started / speech.stopped", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);

		const events: string[] = [];
		client.on("speech.started", () => events.push("started"));
		client.on("speech.stopped", () => events.push("stopped"));

		ws.receive({ type: "input_audio_buffer.speech_started", item_id: "i1" });
		ws.receive({ type: "input_audio_buffer.speech_stopped", item_id: "i1" });

		assert.deepEqual(events, ["started", "stopped"]);
		client.close();
	});

	it("emits function_call from response.function_call_arguments.done", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);
		const calls: FunctionCallEvent[] = [];
		client.on("function_call", (ev) => calls.push(ev));

		ws.receive({
			type: "response.function_call_arguments.done",
			name: "pi_turn",
			call_id: "call_1",
			arguments: '{"message":"list files"}',
			item_id: "item_fc",
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.name, "pi_turn");
		assert.equal(calls[0]!.callId, "call_1");
		assert.equal(calls[0]!.arguments, '{"message":"list files"}');
		client.close();
	});

	it("emits function_call from response.done output (deduped)", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);
		const calls: FunctionCallEvent[] = [];
		client.on("function_call", (ev) => calls.push(ev));

		// arguments.done first
		ws.receive({
			type: "response.function_call_arguments.done",
			name: "pi_turn",
			call_id: "call_dup",
			arguments: '{"message":"once"}',
		});
		// response.done with same call_id must not double-emit
		ws.receive({
			type: "response.done",
			response: {
				id: "resp_1",
				status: "completed",
				output: [
					{
						type: "function_call",
						id: "item_1",
						name: "pi_turn",
						call_id: "call_dup",
						arguments: '{"message":"once"}',
					},
				],
			},
		});
		assert.equal(calls.length, 1);

		// Fresh call only via response.done
		ws.receive({
			type: "response.done",
			response: {
				output: [
					{
						type: "function_call",
						name: "pi_turn",
						call_id: "call_only_done",
						arguments: '{"message":"via done"}',
					},
				],
			},
		});
		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.callId, "call_only_done");
		client.close();
	});

	it("sendFunctionCallOutput + createResponse send expected events", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);

		client.sendFunctionCallOutput("call_9", '{"ok":true,"summary":"done"}');
		client.createResponse();

		const creates = ws.sentOfType("conversation.item.create") as Array<{
			item: { type: string; call_id: string; output: string };
		}>;
		assert.equal(creates.length, 1);
		assert.equal(creates[0]!.item.type, "function_call_output");
		assert.equal(creates[0]!.item.call_id, "call_9");
		assert.equal(creates[0]!.item.output, '{"ok":true,"summary":"done"}');

		const responses = ws.sentOfType("response.create");
		assert.equal(responses.length, 1);
		client.close();
	});

	it("emits audio.delta / audio.done for output audio", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);
		const deltas: string[] = [];
		const dones: number[] = [];
		client.on("audio.delta", (ev) => deltas.push(ev.delta));
		client.on("audio.done", () => dones.push(1));

		ws.receive({
			type: "response.output_audio.delta",
			item_id: "a1",
			delta: "AAAA",
		});
		ws.receive({ type: "response.output_audio.done", item_id: "a1" });

		assert.deepEqual(deltas, ["AAAA"]);
		assert.equal(dones.length, 1);
		client.close();
	});

	it("cancelResponse and truncateConversationItem send client events", async () => {
		const { client, sockets } = createHarness();
		const ws = await connectReady(client, sockets);
		client.cancelResponse();
		client.truncateConversationItem("item_x", 1500, 0);
		assert.equal(ws.sentOfType("response.cancel").length, 1);
		const truncs = ws.sentOfType("conversation.item.truncate") as Array<{
			item_id: string;
			audio_end_ms: number;
		}>;
		assert.equal(truncs.length, 1);
		assert.equal(truncs[0]!.item_id, "item_x");
		assert.equal(truncs[0]!.audio_end_ms, 1500);
		client.close();
	});
});
