/**
 * Unit tests for VS6 playback / TTS (issue #13).
 * Mocked spawn/fetch — no real audio or network.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import { platform } from "node:os";

import {
	DEFAULT_SPEAK_MAX_CHARS,
	extractLastAssistantText,
	resolveTtsBackend,
	speak,
	summarizeForSpeech,
	PcmStreamPlayer,
	VoicePlayback,
	type SpawnFn,
} from "./playback.ts";

function fakeChild(exitCode = 0, delayMs = 5): ChildProcess {
	const ee = new EventEmitter() as ChildProcess & EventEmitter;
	ee.kill = ((_signal?: NodeJS.Signals | number) => {
		queueMicrotask(() => ee.emit("close", null, "SIGTERM"));
		return true;
	}) as ChildProcess["kill"];
	setTimeout(() => ee.emit("close", exitCode, null), delayMs);
	return ee;
}

describe("resolveTtsBackend", () => {
	it("parses explicit values", () => {
		assert.equal(resolveTtsBackend("say"), "say");
		assert.equal(resolveTtsBackend("openai"), "openai");
		assert.equal(resolveTtsBackend("off"), "off");
		assert.equal(resolveTtsBackend(" OFF "), "off");
	});

	it("defaults to say on darwin and off elsewhere", () => {
		assert.equal(resolveTtsBackend(undefined, "darwin"), "say");
		assert.equal(resolveTtsBackend("", "linux"), "off");
		assert.equal(resolveTtsBackend("nope", "win32"), "off");
	});
});

describe("summarizeForSpeech", () => {
	it("returns empty for blank input", () => {
		assert.equal(summarizeForSpeech("   "), "");
		assert.equal(summarizeForSpeech(""), "");
	});

	it("strips markdown and collapses whitespace", () => {
		const out = summarizeForSpeech(
			"## Done\n\nI updated `foo.ts` and **shipped** it.\n\n```ts\nconst x = 1;\n```",
		);
		assert.match(out, /Done/);
		assert.match(out, /foo\.ts/);
		assert.doesNotMatch(out, /```/);
		assert.doesNotMatch(out, /\*\*/);
	});

	it("hard-caps length", () => {
		const long = "word ".repeat(200);
		const out = summarizeForSpeech(long, 80);
		assert.ok(out.length <= 80);
		assert.ok(out.length > 0);
	});

	it("prefers first sentence when long", () => {
		const text =
			"All tests pass and the feature is ready. " +
			"Here is a very long trailing monologue that should not be spoken in full. ".repeat(
				10,
			);
		const out = summarizeForSpeech(text, DEFAULT_SPEAK_MAX_CHARS);
		assert.match(out, /All tests pass/);
		assert.ok(out.length <= DEFAULT_SPEAK_MAX_CHARS);
	});
});

describe("extractLastAssistantText", () => {
	it("pulls text blocks from the last assistant message", () => {
		const messages = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "First reply." },
				],
			},
			{ role: "user", content: "again" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Second " },
					{ type: "text", text: "reply." },
					{ type: "toolCall", id: "1", name: "x", arguments: {} },
				],
			},
		];
		assert.equal(extractLastAssistantText(messages), "Second reply.");
	});

	it("returns empty when no assistant text", () => {
		assert.equal(
			extractLastAssistantText([{ role: "user", content: "x" }]),
			"",
		);
		assert.equal(extractLastAssistantText([]), "");
	});
});

describe("speak / VoicePlayback", () => {
	it("say backend spawns `say` with text", async () => {
		const calls: Array<{ cmd: string; args: readonly string[] }> = [];
		const spawnFn: SpawnFn = (cmd, args) => {
			calls.push({ cmd, args: [...args] });
			return fakeChild(0, 1);
		};
		await speak("Hello world", { backend: "say", spawn: spawnFn });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.cmd, "say");
		assert.deepEqual(calls[0]?.args, ["Hello world"]);
	});

	it("say backend omits OpenAI voice names from -v", async () => {
		const calls: Array<readonly string[]> = [];
		const spawnFn: SpawnFn = (_cmd, args) => {
			calls.push([...args]);
			return fakeChild(0, 1);
		};
		await speak("Hi", { backend: "say", voice: "marin", spawn: spawnFn });
		assert.deepEqual(calls[0], ["Hi"]);
		await speak("Hi", { backend: "say", voice: "Samantha", spawn: spawnFn });
		assert.deepEqual(calls[1], ["-v", "Samantha", "Hi"]);
	});

	it("off backend is a no-op", async () => {
		let spawned = 0;
		const spawnFn: SpawnFn = () => {
			spawned++;
			return fakeChild();
		};
		await speak("Hello", { backend: "off", spawn: spawnFn });
		assert.equal(spawned, 0);
	});

	it("openai backend fetches audio then plays", async () => {
		const calls: string[] = [];
		const spawnFn: SpawnFn = (cmd) => {
			calls.push(cmd);
			return fakeChild(0, 1);
		};
		const fetchFn: typeof fetch = async () =>
			new Response(new Uint8Array([1, 2, 3, 4]), {
				status: 200,
				headers: { "content-type": "audio/mpeg" },
			});
		await speak("Done.", {
			backend: "openai",
			apiKey: "sk-test",
			voice: "marin",
			spawn: spawnFn,
			fetch: fetchFn,
		});
		assert.equal(calls.length, 1);
		assert.ok(calls[0] === "afplay" || calls[0] === "ffplay");
	});

	it("VoicePlayback.stop aborts in-flight speak", async () => {
		const playback = new VoicePlayback({
			backend: "say",
			spawn: (_cmd, _args) => fakeChild(0, 200),
		});
		const transitions: boolean[] = [];
		playback.onSpeakingChange((s) => transitions.push(s));

		const p = playback.speak("Long monologue that would take a while.");
		// Allow speak to start
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(playback.isSpeaking(), true);
		playback.stop();
		assert.equal(playback.isSpeaking(), false);
		await p;
		assert.ok(transitions.includes(true));
		assert.equal(transitions.at(-1), false);
	});

	it("VoicePlayback off never speaks", async () => {
		let spawned = 0;
		const playback = new VoicePlayback({
			backend: "off",
			spawn: () => {
				spawned++;
				return fakeChild();
			},
		});
		await playback.speak("Nope");
		assert.equal(spawned, 0);
		assert.equal(playback.isSpeaking(), false);
	});
});

describe("PcmStreamPlayer", () => {
	function streamChild() {
		const child = new EventEmitter() as ChildProcess & EventEmitter;
		const stdin = new PassThrough();
		const written: Buffer[] = [];
		stdin.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));
		child.stdin = stdin;
		child.kill = ((_signal?: NodeJS.Signals | number) => {
			queueMicrotask(() => child.emit("close", null, "SIGTERM"));
			return true;
		}) as ChildProcess["kill"];
		return { child, stdin, written };
	}

	it("streams PCM immediately to one SoX process and closes stdin on done", () => {
		const calls: Array<{ command: string; args: readonly string[] }> = [];
		const spawned: ReturnType<typeof streamChild>[] = [];
		const player = new PcmStreamPlayer({
			spawn: (command, args) => {
				calls.push({ command, args: [...args] });
				const next = streamChild();
				spawned.push(next);
				return next.child;
			},
		});
		const speaking: boolean[] = [];
		player.onSpeakingChange((value) => speaking.push(value));
		player.appendBase64(Buffer.from([1, 2, 3, 4]).toString("base64"));
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.command, "play");
		assert.deepEqual(calls[0]?.args, [
			"-q",
			"-t",
			"raw",
			"-r",
			"24000",
			"-e",
			"signed-integer",
			"-b",
			"16",
			"-c",
			"1",
			"-",
		]);
		assert.deepEqual(Array.from(spawned[0]?.written[0] ?? []), [1, 2, 3, 4]);
		assert.equal(player.isSpeaking(), true);
		player.done();
		assert.equal(spawned[0]?.stdin.writableEnded, true);
		spawned[0]?.child.emit("close", 0, null);
		assert.equal(player.isSpeaking(), false);
		assert.deepEqual(speaking, [true, false]);
	});

	it("queues a later segment until the prior SoX process closes", () => {
		const spawned: ReturnType<typeof streamChild>[] = [];
		const player = new PcmStreamPlayer({
			spawn: () => {
				const next = streamChild();
				spawned.push(next);
				return next.child;
			},
		});
		player.appendBase64(Buffer.from([1, 1]).toString("base64"));
		player.done();
		player.done(); // Duplicate completion cannot launch another player.
		player.appendBase64(Buffer.from([2, 2]).toString("base64"));
		assert.equal(spawned.length, 1);
		spawned[0]?.child.emit("close", 0, null);
		assert.equal(spawned.length, 2, "next segment starts only after prior close");
		assert.deepEqual(Array.from(spawned[1]?.written[0] ?? []), [2, 2]);
		player.stop();
	});

	it("falls back to a WAV player after an asynchronous SoX stdin EPIPE", async () => {
		const spawned: ReturnType<typeof streamChild>[] = [];
		const commands: string[] = [];
		const player = new PcmStreamPlayer({
			spawn: (command) => {
				commands.push(command);
				if (command !== "play") return fakeChild(0, 1);
				const next = streamChild();
				spawned.push(next);
				return next.child;
			},
		});
		player.appendBase64(Buffer.from([1, 2, 3, 4]).toString("base64"));
		assert.doesNotThrow(() => {
			spawned[0]?.stdin.emit(
				"error",
				Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
			);
		});
		player.done();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(
			commands.includes(platform() === "darwin" ? "afplay" : "ffplay"),
		);
	});
});
