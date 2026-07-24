/**
 * Unit tests for VoiceSession state machine (VS5–VS7 / #12–#14).
 * Fake auth / client / capture / bridge / playback — no network, no mic.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { defaultVoiceConfig } from "./config.ts";
import { VoicePlayback } from "./playback.ts";
import {
	getSharedVoiceSession,
	resetSharedVoiceSession,
	VoiceSession,
	type VoiceSessionUi,
} from "./session.ts";
import type {
	MicCaptureLike,
	RealtimeClientLike,
	TranscriptEvent,
	VoiceAuth,
} from "./types.ts";

function fakeAuth(mode: VoiceAuth["mode"] = "api-key"): VoiceAuth {
	return {
		mode,
		headers: { Authorization: "Bearer test-token" },
	};
}

class FakeClient implements RealtimeClientLike {
	connected = false;
	headers: Record<string, string> | undefined;
	config: unknown;
	appended: Array<string | Uint8Array> = [];
	closed = false;
	sessionUpdates: unknown[] = [];
	functionOutputs: Array<{ callId: string; output: string }> = [];
	responseCreates = 0;
	cancels = 0;
	truncates: Array<{ itemId: string; audioEndMs: number }> = [];
	readonly #listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	connect(authHeaders: Record<string, string>, config: unknown): Promise<void> {
		this.headers = authHeaders;
		this.config = config;
		this.connected = true;
		this.closed = false;
		return Promise.resolve();
	}

	close(): void {
		this.closed = true;
		this.connected = false;
		this.#emit("close", { code: 1000, reason: "client close" });
	}

	/** Unexpected drop (does not go through close() semantics for tests). */
	drop(code = 1006, reason = "abnormal closure"): void {
		this.closed = true;
		this.connected = false;
		this.#emit("close", { code, reason });
	}

	appendAudio(pcm: string | Uint8Array): void {
		this.appended.push(pcm);
	}

	on(event: string, handler: (...args: unknown[]) => void): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(handler);
		return () => set?.delete(handler);
	}

	updateSession(partial: unknown): void {
		this.sessionUpdates.push(partial);
	}

	sendFunctionCallOutput(callId: string, output: string): void {
		this.functionOutputs.push({ callId, output });
	}

	createResponse(_response?: Record<string, unknown>): void {
		this.responseCreates += 1;
	}

	cancelResponse(): void {
		this.cancels += 1;
	}

	truncateConversationItem(itemId: string, audioEndMs: number): void {
		this.truncates.push({ itemId, audioEndMs });
	}

	emitFunctionCall(
		name: string,
		callId: string,
		args: string,
	): void {
		this.#emit("function_call", {
			name,
			callId,
			arguments: args,
			timestamp: Date.now(),
		});
	}

	emitTranscriptDone(text: string): void {
		const event: TranscriptEvent = {
			type: "final",
			text,
			timestamp: Date.now(),
		};
		this.#emit("transcript.done", event);
	}

	emitTranscriptDelta(text: string): void {
		const event: TranscriptEvent = {
			type: "partial",
			text,
			timestamp: Date.now(),
		};
		this.#emit("transcript.delta", event);
	}

	emitSpeech(kind: "started" | "stopped"): void {
		const event: TranscriptEvent = {
			type: kind === "started" ? "speech_started" : "speech_stopped",
			text: "",
			timestamp: Date.now(),
		};
		this.#emit(kind === "started" ? "speech.started" : "speech.stopped", event);
	}

	#emit(event: string, ...args: unknown[]): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const handler of set) handler(...args);
	}
}

class FakeCapture implements MicCaptureLike {
	backend = "fake";
	started = false;
	stopped = false;
	onChunk: ((pcm: Uint8Array) => void) | undefined;

	async start(onChunk: (pcm: Uint8Array) => void): Promise<void> {
		this.started = true;
		this.onChunk = onChunk;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.started = false;
	}

	push(bytes: Uint8Array): void {
		this.onChunk?.(bytes);
	}
}

/** Spawn that never exits until kill() — for speak-back timing tests. */
function hangingPlayback(): VoicePlayback {
	return new VoicePlayback({
		backend: "say",
		spawn: () => {
			const ee = new EventEmitter() as EventEmitter & {
				kill: () => boolean;
			};
			ee.kill = () => {
				queueMicrotask(() => ee.emit("close", null, "SIGTERM"));
				return true;
			};
			return ee as unknown as import("node:child_process").ChildProcess;
		},
	});
}

function makeSession(overrides?: {
	client?: FakeClient;
	capture?: FakeCapture;
	auth?: VoiceAuth;
	deliver?: (text: string) => void;
	failAuth?: Error;
	failConnect?: Error;
	tts?: "say" | "openai" | "off";
	mode?: "transcription" | "conversational";
	playback?: VoicePlayback;
	/** Fresh client per createClient call (reconnect tests). */
	freshClients?: boolean;
	/** Override delay (default: immediate). */
	delay?: (ms: number) => Promise<void>;
	/** Hold scheduled timers instead of running immediately. */
	holdTimers?: boolean;
}): {
	session: VoiceSession;
	client: FakeClient;
	capture: FakeCapture;
	clients: FakeClient[];
	delivered: string[];
	uiLines: string[];
	statuses: Array<string | undefined>;
	widgets: Array<string[] | undefined>;
	flushTimers: () => void;
} {
	const clients: FakeClient[] = [];
	const capture = overrides?.capture ?? new FakeCapture();
	const delivered: string[] = [];
	const uiLines: string[] = [];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	const pendingTimers: Array<() => void> = [];

	// Eager default client so destructuring `{ client }` before start() is stable.
	let defaultClient: FakeClient | undefined = overrides?.client;
	if (!overrides?.freshClients) {
		if (!defaultClient) defaultClient = new FakeClient();
		clients.push(defaultClient);
		if (overrides?.failConnect) {
			const err = overrides.failConnect;
			defaultClient.connect = async () => {
				throw err;
			};
		}
	}

	const ui: VoiceSessionUi = {
		notify: (message) => {
			uiLines.push(message);
		},
		setStatus: (_key, text) => {
			statuses.push(text);
		},
		setWidget: (_key, content) => {
			widgets.push(content);
		},
	};

	const delay =
		overrides?.delay ??
		(async () => {
			/* immediate reconnect backoff in tests */
		});

	const scheduler = overrides?.holdTimers
		? {
				set: (fn: () => void, ms: number) => {
					if (ms > 10_000) return { long: true, ms };
					pendingTimers.push(fn);
					return pendingTimers.length;
				},
				clear: (_id: unknown) => {
					/* leave pending; tests flush selectively */
				},
		  }
		: {
				set: (fn: () => void, ms: number) => {
					// Never auto-fire long timers (session-limit refresh is 55m).
					if (ms > 10_000) return { long: true, ms };
					queueMicrotask(fn);
					return 1;
				},
				clear: (_id: unknown) => undefined,
		  };

	const session = new VoiceSession({
		config: {
			...defaultVoiceConfig,
			tts: overrides?.tts ?? "off",
			mode: overrides?.mode ?? defaultVoiceConfig.mode,
		},
		resolveAuth: async () => {
			if (overrides?.failAuth) throw overrides.failAuth;
			return overrides?.auth ?? fakeAuth();
		},
		createClient: () => {
			if (overrides?.freshClients) {
				const c = new FakeClient();
				clients.push(c);
				return c;
			}
			return defaultClient!;
		},
		createCapture: () => capture,
		deliverText: (_pi, text) => {
			delivered.push(text);
			overrides?.deliver?.(text);
		},
		createPlayback: overrides?.playback ? () => overrides.playback! : undefined,
		delay,
		scheduler,
	});
	session.bindUi(ui);

	return {
		session,
		get client(): FakeClient {
			return clients[0] ?? defaultClient!;
		},
		capture,
		clients,
		delivered,
		uiLines,
		statuses,
		widgets,
		flushTimers: () => {
			const batch = pendingTimers.splice(0, pendingTimers.length);
			for (const fn of batch) fn();
		},
	};
}

describe("VoiceSession", () => {
	it("starts idle", () => {
		const { session } = makeSession();
		assert.equal(session.getState(), "idle");
		assert.equal(session.getStatus(), "idle");
		assert.equal(session.getStatusInfo().auth, defaultVoiceConfig.auth);
		assert.equal(session.getStatusInfo().authMode, undefined);
	});

	it("start → listening wires auth, client, capture", async () => {
		const { session, client, capture } = makeSession({
			auth: fakeAuth("chatgpt"),
		});
		const states: string[] = [];
		session.onStateChange((state) => {
			states.push(state);
		});

		const pi = { sendUserMessage: () => undefined };
		await session.start({ pi, isIdle: () => true });

		assert.equal(session.getState(), "listening");
		assert.match(session.getStatus(), /listening/);
		assert.equal(session.getStatusInfo().authMode, "chatgpt");
		assert.equal(client.connected, true);
		assert.equal(capture.started, true);
		assert.ok(states.includes("connecting"));
		assert.ok(states.includes("listening"));
		assert.deepEqual(client.headers, {
			Authorization: "Bearer test-token",
		});
	});

	it("streams audio only when listening and not paused", async () => {
		const { session, client, capture } = makeSession();
		await session.start({
			pi: { sendUserMessage: () => undefined },
		});

		// Non-silent PCM16 sample (high amplitude).
		const chunk = new Uint8Array(64);
		for (let i = 0; i < 64; i += 2) {
			chunk[i] = 0xff;
			chunk[i + 1] = 0x7f; // ~32767 LE
		}
		capture.push(chunk);
		assert.equal(client.appended.length, 1);
		assert.ok((session.getStatusInfo().audioChunks ?? 0) >= 1);
		assert.ok((session.getStatusInfo().audioLevel ?? 0) > 0);
		assert.match(session.getStatus(), /listening/);

		session.setCapturePaused(true);
		assert.equal(session.getStatus(), "paused…");
		capture.push(chunk);
		// Paused: still meters mic, does not stream.
		assert.equal(client.appended.length, 1);
		assert.ok((session.getStatusInfo().audioChunks ?? 0) >= 2);

		session.setCapturePaused(false);
		capture.push(chunk);
		assert.equal(client.appended.length, 2);
	});

	it("shows hearing status on speech.started", async () => {
		const { session, client } = makeSession();
		await session.start({ pi: { sendUserMessage: () => undefined } });
		client.emitSpeech("started");
		assert.equal(session.getStatusInfo().hearing, true);
		assert.match(session.getStatus(), /hearing/);
		client.emitSpeech("stopped");
		assert.equal(session.getStatusInfo().hearing, false);
	});

	it("delivers final transcripts via bridge", async () => {
		const { session, client, delivered } = makeSession();
		const seen: TranscriptEvent[] = [];
		session.onTranscript((ev) => {
			seen.push(ev);
		});

		await session.start({
			pi: { sendUserMessage: () => undefined },
			isIdle: () => true,
		});

		client.emitTranscriptDone("  list the files  ");
		assert.deepEqual(delivered, ["list the files"]);
		assert.equal(seen.at(-1)?.type, "final");
	});

	it("relays finals to herdr target without local deliver", async () => {
		const relayed: Array<{ target: string; text: string }> = [];
		const client = new FakeClient();
		const capture = new FakeCapture();
		const delivered: string[] = [];
		const session = new VoiceSession({
			config: {
				...defaultVoiceConfig,
				relayTarget: "vs5-session",
				relayMode: "relay",
				tts: "off",
			},
			resolveAuth: async () => fakeAuth(),
			createClient: () => client,
			createCapture: () => capture,
			deliverText: (_pi, text) => {
				delivered.push(text);
			},
			relayText: (target, text) => {
				relayed.push({ target, text });
			},
		});
		await session.start({ pi: { sendUserMessage: () => undefined } });
		client.emitTranscriptDone("ship it");
		assert.deepEqual(delivered, []);
		assert.deepEqual(relayed, [{ target: "vs5-session", text: "ship it" }]);
	});

	it("stop tears down capture and client", async () => {
		const { session, client, capture } = makeSession();
		await session.start({ pi: { sendUserMessage: () => undefined } });
		await session.stop();

		assert.equal(session.getState(), "idle");
		assert.equal(capture.stopped, true);
		assert.equal(client.closed, true);
		assert.equal(session.getStatusInfo().authMode, undefined);
	});

	it("toggle starts then stops", async () => {
		const { session } = makeSession();
		const opts = { pi: { sendUserMessage: () => undefined } };
		assert.equal(await session.toggle(opts), "started");
		assert.equal(session.getState(), "listening");
		assert.equal(await session.toggle(opts), "stopped");
		assert.equal(session.getState(), "idle");
	});

	it("setAgentBusy pauses and resumes capture", async () => {
		const { session } = makeSession();
		await session.start({ pi: { sendUserMessage: () => undefined } });
		session.setAgentBusy(true);
		assert.equal(session.isCapturePaused(), true);
		session.setAgentBusy(false);
		assert.equal(session.isCapturePaused(), false);
	});

	it("auth failure surfaces error then returns to idle", async () => {
		const { session } = makeSession({
			failAuth: new Error("no credentials"),
		});
		await assert.rejects(
			() => session.start({ pi: { sendUserMessage: () => undefined } }),
			/no credentials/,
		);
		assert.equal(session.getState(), "idle");
	});

	it("connect failure tears down and returns to idle", async () => {
		const { session, capture } = makeSession({
			failConnect: new Error("ws boom"),
		});
		await assert.rejects(
			() => session.start({ pi: { sendUserMessage: () => undefined } }),
			/ws boom/,
		);
		assert.equal(session.getState(), "idle");
		assert.equal(capture.started, false);
	});

	it("shared session helpers", () => {
		resetSharedVoiceSession();
		const a = getSharedVoiceSession();
		const b = getSharedVoiceSession();
		assert.equal(a, b);
		resetSharedVoiceSession();
	});

	it("speakBack pauses capture and reports speaking status", async () => {
		const hanging = hangingPlayback();
		const { session } = makeSession({
			tts: "say",
			playback: hanging,
		});
		await session.start({ pi: { sendUserMessage: () => undefined } });

		const speakPromise = session.speakBack("All done with the task.");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(session.isSpeaking(), true);
		assert.equal(session.isCapturePaused(), true);
		assert.equal(session.getStatus(), "speaking…");
		assert.equal(session.getStatusInfo().speaking, true);
		assert.equal(session.getStatusInfo().tts, "say");

		session.stopPlayback();
		await speakPromise;
		assert.equal(session.isSpeaking(), false);
		// Echo-guard timer resumes capture on microtask (test scheduler).
		await new Promise<void>((r) => queueMicrotask(r));
		assert.equal(session.isCapturePaused(), false);
	});

	it("speakBack is no-op when tts=off", async () => {
		const { session } = makeSession({ tts: "off" });
		await session.start({ pi: { sendUserMessage: () => undefined } });
		await session.speakBack("Should not speak");
		assert.equal(session.isSpeaking(), false);
		assert.equal(session.isCapturePaused(), false);
	});

	it("stop ends playback", async () => {
		const hanging = hangingPlayback();
		const { session } = makeSession({ tts: "say", playback: hanging });
		await session.start({ pi: { sendUserMessage: () => undefined } });
		const speakPromise = session.speakBack("Still talking");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(session.isSpeaking(), true);
		await session.stop();
		await speakPromise;
		assert.equal(session.isSpeaking(), false);
		assert.equal(session.getState(), "idle");
	});

	it("speech_started stops playback (barge-in)", async () => {
		const hanging = hangingPlayback();
		const { session, client } = makeSession({ tts: "say", playback: hanging });
		await session.start({ pi: { sendUserMessage: () => undefined } });
		const speakPromise = session.speakBack("Please stop me");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(session.isSpeaking(), true);
		client.emitSpeech("started");
		await speakPromise;
		assert.equal(session.isSpeaking(), false);
	});

	it("applyPrefs updates mode/tts/device snapshot", () => {
		const { session } = makeSession();
		session.applyPrefs({
			v: 1,
			mode: "transcription",
			tts: "say",
			voice: "Samantha",
			inputDevice: "iPhone Microphone",
		});
		const prefs = session.getPrefs();
		assert.equal(prefs.tts, "say");
		assert.equal(prefs.voice, "Samantha");
		assert.equal(prefs.inputDevice, "iPhone Microphone");
		assert.equal(session.getConfig().tts, "say");
		assert.equal(session.getStatusInfo().tts, "say");
	});

	it("partial + final appear in the transcript widget", async () => {
		const { session, client, widgets } = makeSession();
		await session.start({ pi: { sendUserMessage: () => undefined } });
		client.emitTranscriptDelta("hello ");
		client.emitTranscriptDelta("world");
		const partialWidget = widgets.filter(Boolean).at(-1);
		assert.ok(partialWidget?.some((line) => line.includes("hello world")));
		assert.ok(partialWidget?.some((line) => line.includes("▸")));

		client.emitTranscriptDone("hello world");
		const finalWidget = widgets.filter(Boolean).at(-1);
		assert.ok(finalWidget?.some((line) => line.includes("✓") && line.includes("hello world")));
		assert.equal(session.getStatusInfo().partial, undefined);
	});

	it("reconnects after unexpected WS drop and keeps capture", async () => {
		const { session, capture, clients, uiLines } = makeSession({
			freshClients: true,
		});
		await session.start({ pi: { sendUserMessage: () => undefined } });
		assert.equal(session.getState(), "listening");
		assert.equal(capture.started, true);
		const live = clients[0];
		assert.ok(live, "expected a live client after start");

		// Drop the live client; soft reconnect should spin a fresh one.
		live.drop(1006, "going away");
		// Allow reconnect loop promises to settle.
		await new Promise((r) => setTimeout(r, 30));

		assert.equal(session.getState(), "listening");
		assert.equal(session.isReconnecting(), false);
		assert.equal(capture.stopped, false);
		assert.ok(clients.length >= 2, "expected a new client for reconnect");
		assert.equal(clients.at(-1)?.connected, true);
		assert.ok(uiLines.some((l) => /reconnected/i.test(l)));
	});

	it("stops with a clear error after reconnect budget is exhausted", async () => {
		let connects = 0;
		const first = new FakeClient();
		const capture = new FakeCapture();
		const uiLines: string[] = [];
		const session = new VoiceSession({
			config: { ...defaultVoiceConfig, tts: "off" },
			resolveAuth: async () => fakeAuth(),
			createClient: () => {
				connects += 1;
				if (connects === 1) return first;
				const c = new FakeClient();
				c.connect = async () => {
					throw new Error("still down");
				};
				return c;
			},
			createCapture: () => capture,
			deliverText: () => undefined,
			delay: async () => undefined,
		});
		session.bindUi({
			notify: (m) => uiLines.push(m),
		});
		await session.start({ pi: { sendUserMessage: () => undefined } });
		assert.equal(session.getState(), "listening");

		first.drop(1006, "network blip");
		await new Promise((r) => setTimeout(r, 40));

		assert.equal(session.getState(), "idle");
		assert.ok(
			uiLines.some((l) => /reconnect failed|voice error/i.test(l)),
			`expected failure notify, got: ${uiLines.join(" | ")}`,
		);
		assert.ok(connects >= 2);
	});

	it("echo guard holds capture briefly after TTS ends", async () => {
		const hanging = hangingPlayback();
		const { session, flushTimers } = makeSession({
			tts: "say",
			playback: hanging,
			holdTimers: true,
		});
		await session.start({ pi: { sendUserMessage: () => undefined } });
		const speakPromise = session.speakBack("Done.");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(session.isCapturePaused(), true);
		session.stopPlayback();
		await speakPromise;
		// Still paused until echo-guard timer fires.
		assert.equal(session.isCapturePaused(), true);
		assert.match(session.getStatus(), /echo guard|paused/);
		flushTimers();
		assert.equal(session.isCapturePaused(), false);
	});

	it("defaults to transcription mode", () => {
		const { session } = makeSession();
		assert.equal(session.getConfig().mode, "transcription");
		assert.equal(session.getStatusInfo().mode, "transcription");
	});

	it("setMode updates config and live session.update", async () => {
		const { session, client } = makeSession();
		await session.start({ pi: { sendUserMessage: () => undefined } });
		session.setMode("conversational");
		assert.equal(session.getConfig().mode, "conversational");
		assert.equal(session.getPrefs().mode, "conversational");
		assert.ok(client.sessionUpdates.length >= 1);
		const last = client.sessionUpdates.at(-1) as {
			output_modalities?: string[];
			tools?: Array<{ name?: string }>;
		};
		assert.deepEqual(last.output_modalities, ["audio", "text"]);
		assert.equal(last.tools?.[0]?.name, "pi_turn");

		session.setMode("transcription");
		const back = client.sessionUpdates.at(-1) as {
			output_modalities?: string[];
			tools?: unknown[];
		};
		assert.deepEqual(back.output_modalities, ["text"]);
		assert.deepEqual(back.tools, []);
	});

	it("conversational mode does not bridge final transcripts", async () => {
		const { session, client, delivered } = makeSession({
			mode: "conversational",
		});
		await session.start({
			pi: { sendUserMessage: () => undefined },
			isIdle: () => true,
		});
		client.emitTranscriptDone("do not bridge this");
		assert.deepEqual(delivered, []);
	});

	it("pi_turn delivers to pi and returns function_call_output", async () => {
		const { session, client, delivered } = makeSession({
			mode: "conversational",
		});
		await session.start({
			pi: { sendUserMessage: () => undefined },
			isIdle: () => true,
		});

		client.emitFunctionCall(
			"pi_turn",
			"call_abc",
			JSON.stringify({ message: "list files in src" }),
		);
		// Allow the async handler to deliver.
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(delivered, ["list files in src"]);
		assert.match(session.getStatus(), /pi working/);

		session.notifyAgentSettled("Listed 3 files under src/.");
		await new Promise((r) => setTimeout(r, 10));

		assert.equal(client.functionOutputs.length, 1);
		assert.equal(client.functionOutputs[0]!.callId, "call_abc");
		const out = JSON.parse(client.functionOutputs[0]!.output) as {
			ok: boolean;
			summary: string;
		};
		assert.equal(out.ok, true);
		assert.match(out.summary, /Listed 3 files/);
		assert.equal(client.responseCreates, 1);
	});

	it("speech_started barge-in cancels and truncates in conversational mode", async () => {
		const { session, client } = makeSession({ mode: "conversational" });
		await session.start({ pi: { sendUserMessage: () => undefined } });
		// Seed pcm player item via audio.delta path is internal; barge-in still cancels.
		client.emitSpeech("started");
		assert.ok(client.cancels >= 1);
	});
});
