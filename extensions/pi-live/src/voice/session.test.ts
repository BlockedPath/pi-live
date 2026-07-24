/**
 * Unit tests for VoiceSession state machine (VS5 / #12).
 * Fake auth / client / capture / bridge — no network, no mic.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultVoiceConfig } from "./config.ts";
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
	readonly #listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	connect(authHeaders: Record<string, string>, config: unknown): Promise<void> {
		this.headers = authHeaders;
		this.config = config;
		this.connected = true;
		return Promise.resolve();
	}

	close(): void {
		this.closed = true;
		this.connected = false;
		this.#emit("close", { code: 1000, reason: "client close" });
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

	updateSession(_partial: unknown): void {}

	emitTranscriptDone(text: string): void {
		const event: TranscriptEvent = {
			type: "final",
			text,
			timestamp: Date.now(),
		};
		this.#emit("transcript.done", event);
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

function makeSession(overrides?: {
	client?: FakeClient;
	capture?: FakeCapture;
	auth?: VoiceAuth;
	deliver?: (text: string) => void;
	failAuth?: Error;
	failConnect?: Error;
}): {
	session: VoiceSession;
	client: FakeClient;
	capture: FakeCapture;
	delivered: string[];
	uiLines: string[];
	statuses: Array<string | undefined>;
} {
	const client = overrides?.client ?? new FakeClient();
	const capture = overrides?.capture ?? new FakeCapture();
	const delivered: string[] = [];
	const uiLines: string[] = [];
	const statuses: Array<string | undefined> = [];

	if (overrides?.failConnect) {
		const err = overrides.failConnect;
		client.connect = async () => {
			throw err;
		};
	}

	const ui: VoiceSessionUi = {
		notify: (message) => {
			uiLines.push(message);
		},
		setStatus: (_key, text) => {
			statuses.push(text);
		},
	};

	const session = new VoiceSession({
		config: { ...defaultVoiceConfig },
		resolveAuth: async () => {
			if (overrides?.failAuth) throw overrides.failAuth;
			return overrides?.auth ?? fakeAuth();
		},
		createClient: () => client,
		createCapture: () => capture,
		deliverText: (_pi, text) => {
			delivered.push(text);
			overrides?.deliver?.(text);
		},
	});
	session.bindUi(ui);

	return { session, client, capture, delivered, uiLines, statuses };
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
		assert.equal(session.getStatus(), "pi working…");
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
});
