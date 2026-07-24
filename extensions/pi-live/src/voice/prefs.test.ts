/**
 * Unit tests for voice-state prefs helpers (VS7 / #14).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	parseVoiceStatePrefs,
	prefsHonoringEnv,
	readLatestVoiceStatePrefs,
	VOICE_STATE_TYPE,
	voiceStateFromFields,
} from "./prefs.ts";

describe("voice prefs", () => {
	it("parseVoiceStatePrefs accepts v1 payloads", () => {
		const prefs = parseVoiceStatePrefs({
			v: 1,
			mode: "transcription",
			tts: "say",
			voice: "marin",
			inputDevice: "iPhone Microphone",
		});
		assert.deepEqual(prefs, {
			v: 1,
			mode: "transcription",
			tts: "say",
			voice: "marin",
			inputDevice: "iPhone Microphone",
		});
	});

	it("parseVoiceStatePrefs rejects unknown versions and junk", () => {
		assert.equal(parseVoiceStatePrefs({ v: 2, tts: "say" }), undefined);
		assert.equal(parseVoiceStatePrefs(null), undefined);
		assert.equal(parseVoiceStatePrefs({ v: 1, tts: "nope" }), undefined);
		assert.equal(parseVoiceStatePrefs({ v: 1 }), undefined);
	});

	it("readLatestVoiceStatePrefs returns the newest custom entry", () => {
		const entries = [
			{ type: "message" },
			{
				type: "custom",
				customType: VOICE_STATE_TYPE,
				data: { v: 1, tts: "off" },
			},
			{
				type: "custom",
				customType: VOICE_STATE_TYPE,
				data: { v: 1, tts: "say", inputDevice: null },
			},
			{ type: "custom", customType: "other", data: { tts: "openai" } },
		];
		assert.deepEqual(readLatestVoiceStatePrefs(entries), {
			v: 1,
			tts: "say",
			inputDevice: null,
		});
	});

	it("prefsHonoringEnv drops fields set in the environment", () => {
		const saved = parseVoiceStatePrefs({
			v: 1,
			tts: "say",
			mode: "transcription",
			voice: "marin",
			inputDevice: "Mic",
		})!;
		const patch = prefsHonoringEnv(saved, {
			PI_VOICE_TTS: "off",
			PI_VOICE_VOICE: "",
		} as NodeJS.ProcessEnv);
		assert.equal(patch.tts, undefined); // env wins
		assert.equal(patch.mode, "transcription");
		assert.equal(patch.voice, "marin");
		assert.equal(patch.inputDevice, "Mic");
	});

	it("voiceStateFromFields snapshots runtime config", () => {
		assert.deepEqual(
			voiceStateFromFields({
				mode: "transcription",
				tts: "openai",
				voice: "alloy",
			}),
			{
				v: 1,
				mode: "transcription",
				tts: "openai",
				voice: "alloy",
				inputDevice: null,
			},
		);
	});
});
