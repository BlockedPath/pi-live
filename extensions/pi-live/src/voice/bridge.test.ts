/**
 * Unit tests for VS4 pi message bridge — fake pi / idle flag, no TUI.
 *
 * Run:
 *   npx tsx --test src/voice/bridge.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverVoiceText, type VoiceBridgePi } from "./bridge.js";

type SendCall = {
	text: string;
	opts?: { deliverAs?: "steer" | "followUp" };
};

function fakePi(): { pi: VoiceBridgePi; calls: SendCall[] } {
	const calls: SendCall[] = [];
	const pi: VoiceBridgePi = {
		sendUserMessage(text, opts) {
			calls.push({ text, opts });
		},
	};
	return { pi, calls };
}

describe("deliverVoiceText", () => {
	it("sends bare message when idle", () => {
		const { pi, calls } = fakePi();
		deliverVoiceText(pi, "list files", { isIdle: () => true });
		assert.deepEqual(calls, [{ text: "list files", opts: undefined }]);
	});

	it("defaults to idle when isIdle is omitted", () => {
		const { pi, calls } = fakePi();
		deliverVoiceText(pi, "hello");
		assert.deepEqual(calls, [{ text: "hello", opts: undefined }]);
	});

	it("uses deliverAs steer by default when busy", () => {
		const { pi, calls } = fakePi();
		deliverVoiceText(pi, "focus on tests", { isIdle: () => false });
		assert.deepEqual(calls, [
			{ text: "focus on tests", opts: { deliverAs: "steer" } },
		]);
	});

	it("uses deliverAs followUp when whenBusy is followUp", () => {
		const { pi, calls } = fakePi();
		deliverVoiceText(pi, "then summarize", {
			isIdle: () => false,
			whenBusy: "followUp",
		});
		assert.deepEqual(calls, [
			{ text: "then summarize", opts: { deliverAs: "followUp" } },
		]);
	});

	it("honors whenBusy steer explicitly", () => {
		const { pi, calls } = fakePi();
		deliverVoiceText(pi, "interrupt", {
			isIdle: () => false,
			whenBusy: "steer",
		});
		assert.deepEqual(calls, [
			{ text: "interrupt", opts: { deliverAs: "steer" } },
		]);
	});

	it("trims whitespace around text", () => {
		const { pi, calls } = fakePi();
		deliverVoiceText(pi, "  padded message  \n", { isIdle: () => true });
		assert.deepEqual(calls, [{ text: "padded message", opts: undefined }]);
	});

	it("no-ops on empty string", () => {
		const { pi, calls } = fakePi();
		deliverVoiceText(pi, "", { isIdle: () => true });
		deliverVoiceText(pi, "", { isIdle: () => false });
		assert.deepEqual(calls, []);
	});

	it("no-ops on whitespace-only string", () => {
		const { pi, calls } = fakePi();
		deliverVoiceText(pi, "   \n\t  ", { isIdle: () => false, whenBusy: "followUp" });
		assert.deepEqual(calls, []);
	});

	it("never bare-sends while busy (always includes deliverAs)", () => {
		const { pi, calls } = fakePi();
		deliverVoiceText(pi, "busy path", { isIdle: () => false });
		assert.equal(calls.length, 1);
		assert.ok(calls[0]?.opts?.deliverAs, "deliverAs must be set when busy");
		assert.notEqual(calls[0]?.opts, undefined);
	});
});
