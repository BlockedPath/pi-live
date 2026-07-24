/**
 * Unit tests for voice auth helpers (VS1 / #8).
 * No live network — fetch and filesystem are faked.
 *
 * Run: npm test  (node --experimental-strip-types --test)
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	ACCESS_TOKEN_REFRESH_SKEW_MS,
	CODEX_OAUTH_CLIENT_ID,
	CODEX_REFRESH_TOKEN_URL,
	VoiceAuthError,
	accountIdFromJwt,
	buildApiKeyAuthHeaders,
	buildChatgptAuthHeaders,
	getJwtExpiryMs,
	parseCodexChatgptAuth,
	refreshCodexAccessToken,
	resolveVoiceAuth,
	tokenNeedsRefresh,
} from "./auth.ts";

function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj), "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function fakeJwt(claims: Record<string, unknown>): string {
	const header = b64url({ alg: "none", typ: "JWT" });
	const payload = b64url(claims);
	return `${header}.${payload}.sig`;
}

const ACCOUNT = "acct-test-123";
const AUTH_NS = "https://api.openai.com/auth";

const temps: string[] = [];

afterEach(async () => {
	while (temps.length > 0) {
		const dir = temps.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function tempCodexHome(
	auth: unknown,
): Promise<{ codexHome: string; authPath: string }> {
	const codexHome = await mkdtemp(join(tmpdir(), "pi-live-voice-auth-"));
	temps.push(codexHome);
	const authPath = join(codexHome, "auth.json");
	await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
	return { codexHome, authPath };
}

describe("buildChatgptAuthHeaders", () => {
	it("sets Authorization Bearer and ChatGPT-Account-Id", () => {
		const headers = buildChatgptAuthHeaders("tok_abc", ACCOUNT);
		assert.deepEqual(headers, {
			Authorization: "Bearer tok_abc",
			"ChatGPT-Account-Id": ACCOUNT,
		});
	});
});

describe("buildApiKeyAuthHeaders", () => {
	it("sets Authorization Bearer only", () => {
		const headers = buildApiKeyAuthHeaders("sk-test");
		assert.equal(Object.keys(headers).sort().join(","), "Authorization");
		assert.equal(headers.Authorization, "Bearer sk-test");
	});
});

describe("JWT expiry helpers", () => {
	it("reads exp as epoch ms", () => {
		const expSec = 1_700_000_000;
		const token = fakeJwt({ exp: expSec, sub: "u" });
		assert.equal(getJwtExpiryMs(token), expSec * 1000);
	});

	it("tokenNeedsRefresh is true inside skew window", () => {
		const now = 1_700_000_000_000;
		const expMs = now + ACCESS_TOKEN_REFRESH_SKEW_MS - 1;
		const token = fakeJwt({ exp: expMs / 1000 });
		assert.equal(tokenNeedsRefresh(token, now), true);
	});

	it("tokenNeedsRefresh is false when far from expiry", () => {
		const now = 1_700_000_000_000;
		const expMs = now + ACCESS_TOKEN_REFRESH_SKEW_MS + 60_000;
		const token = fakeJwt({ exp: expMs / 1000 });
		assert.equal(tokenNeedsRefresh(token, now), false);
	});

	it("tokenNeedsRefresh is false when exp undecodable", () => {
		assert.equal(tokenNeedsRefresh("not-a-jwt", Date.now()), false);
	});

	it("accountIdFromJwt reads chatgpt_account_id claim", () => {
		const token = fakeJwt({
			[AUTH_NS]: { chatgpt_account_id: ACCOUNT },
		});
		assert.equal(accountIdFromJwt(token), ACCOUNT);
	});
});

describe("parseCodexChatgptAuth", () => {
	it("accepts chatgpt auth_mode with tokens.account_id", () => {
		const parsed = parseCodexChatgptAuth({
			auth_mode: "chatgpt",
			tokens: {
				access_token: fakeJwt({ exp: 9_999_999_999 }),
				refresh_token: "refresh-1",
				account_id: ACCOUNT,
			},
		});
		assert.equal(parsed.accountId, ACCOUNT);
		assert.equal(parsed.refreshToken, "refresh-1");
		assert.ok(parsed.expiresAt);
	});

	it("falls back to JWT account id when file omits account_id", () => {
		const access = fakeJwt({
			exp: 9_999_999_999,
			[AUTH_NS]: { chatgpt_account_id: ACCOUNT },
		});
		const parsed = parseCodexChatgptAuth({
			auth_mode: "chatgpt",
			tokens: { access_token: access },
		});
		assert.equal(parsed.accountId, ACCOUNT);
	});

	it("rejects non-chatgpt auth_mode", () => {
		assert.throws(
			() =>
				parseCodexChatgptAuth({
					auth_mode: "apikey",
					tokens: { access_token: "x", account_id: ACCOUNT },
				}),
			(err: unknown) =>
				err instanceof VoiceAuthError && err.code === "codex_unavailable",
		);
	});

	it("rejects missing access_token", () => {
		assert.throws(
			() =>
				parseCodexChatgptAuth({
					auth_mode: "chatgpt",
					tokens: { account_id: ACCOUNT },
				}),
			(err: unknown) =>
				err instanceof VoiceAuthError && err.code === "invalid_auth_file",
		);
	});
});

describe("refreshCodexAccessToken", () => {
	it("POSTs to oauth/token with client_id and grant_type (mocked fetch)", async () => {
		let sawUrl = "";
		let sawBody: Record<string, unknown> | undefined;
		const fetchImpl: typeof fetch = async (input, init) => {
			sawUrl = String(input);
			sawBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					access_token: "new-access",
					refresh_token: "new-refresh",
					id_token: "new-id",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await refreshCodexAccessToken({
			refreshToken: "old-refresh",
			fetchImpl,
			env: {},
		});

		assert.equal(sawUrl, CODEX_REFRESH_TOKEN_URL);
		assert.deepEqual(sawBody, {
			client_id: CODEX_OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: "old-refresh",
		});
		assert.equal(result.accessToken, "new-access");
		assert.equal(result.refreshToken, "new-refresh");
	});

	it("maps HTTP errors to VoiceAuthError without embedding body secrets", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(JSON.stringify({ access_token: "should-not-leak" }), {
				status: 401,
			});

		await assert.rejects(
			() =>
				refreshCodexAccessToken({
					refreshToken: "dead",
					fetchImpl,
					env: {},
				}),
			(err: unknown) => {
				assert.ok(err instanceof VoiceAuthError);
				assert.equal(err.code, "token_refresh_failed");
				assert.equal(err.message.includes("should-not-leak"), false);
				assert.equal(err.message.includes("dead"), false);
				return true;
			},
		);
	});
});

describe("resolveVoiceAuth", () => {
	it("reads chatgpt auth.json and builds headers", async () => {
		const access = fakeJwt({
			exp: Math.floor(Date.now() / 1000) + 3600,
			[AUTH_NS]: { chatgpt_account_id: ACCOUNT },
		});
		const { codexHome } = await tempCodexHome({
			auth_mode: "chatgpt",
			tokens: {
				access_token: access,
				refresh_token: "r1",
				account_id: ACCOUNT,
			},
		});

		const auth = await resolveVoiceAuth({
			codexHome,
			prefer: "codex",
			env: {},
		});

		assert.equal(auth.mode, "chatgpt");
		assert.equal(auth.accountId, ACCOUNT);
		assert.equal(auth.headers.Authorization, `Bearer ${access}`);
		assert.equal(auth.headers["ChatGPT-Account-Id"], ACCOUNT);
		assert.ok(auth.expiresAt);
	});

	it("falls back to PI_VOICE_API_KEY when codex missing (prefer auto)", async () => {
		const missingHome = join(tmpdir(), `pi-live-missing-${Date.now()}`);
		const auth = await resolveVoiceAuth({
			codexHome: missingHome,
			prefer: "auto",
			env: { PI_VOICE_API_KEY: "sk-from-pi" },
		});
		assert.equal(auth.mode, "api-key");
		assert.deepEqual(auth.headers, {
			Authorization: "Bearer sk-from-pi",
		});
	});

	it("prefers OPENAI_API_KEY when prefer=api-key", async () => {
		const auth = await resolveVoiceAuth({
			prefer: "api-key",
			env: { OPENAI_API_KEY: "sk-openai" },
		});
		assert.equal(auth.mode, "api-key");
		assert.equal(auth.headers.Authorization, "Bearer sk-openai");
	});

	it("throws typed missing_auth when nothing available", async () => {
		const missingHome = join(tmpdir(), `pi-live-missing-${Date.now()}-b`);
		await assert.rejects(
			() =>
				resolveVoiceAuth({
					codexHome: missingHome,
					prefer: "auto",
					env: {},
				}),
			(err: unknown) =>
				err instanceof VoiceAuthError &&
				(err.code === "codex_unavailable" || err.code === "missing_auth"),
		);
	});

	it("refreshes near-expiry tokens via mocked fetch and persists", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		const staleAccess = fakeJwt({
			exp: nowSec + 60, // inside 5-minute skew
			[AUTH_NS]: { chatgpt_account_id: ACCOUNT },
		});
		const freshAccess = fakeJwt({
			exp: nowSec + 10_000,
			[AUTH_NS]: { chatgpt_account_id: ACCOUNT },
		});
		const { codexHome, authPath } = await tempCodexHome({
			auth_mode: "chatgpt",
			tokens: {
				access_token: staleAccess,
				refresh_token: "refresh-old",
				account_id: ACCOUNT,
				id_token: "id-old",
			},
		});

		let fetchCalls = 0;
		const fetchImpl: typeof fetch = async () => {
			fetchCalls += 1;
			return new Response(
				JSON.stringify({
					access_token: freshAccess,
					refresh_token: "refresh-new",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const auth = await resolveVoiceAuth({
			codexHome,
			prefer: "codex",
			env: {},
			fetchImpl,
			nowMs: () => Date.now(),
		});

		assert.equal(fetchCalls, 1);
		assert.equal(auth.mode, "chatgpt");
		assert.equal(auth.headers.Authorization, `Bearer ${freshAccess}`);

		const written = JSON.parse(await readFile(authPath, "utf8")) as {
			tokens: { access_token: string; refresh_token: string };
			last_refresh?: string;
		};
		assert.equal(written.tokens.access_token, freshAccess);
		assert.equal(written.tokens.refresh_token, "refresh-new");
		assert.ok(written.last_refresh);
	});

	it("does not call fetch when token is fresh", async () => {
		const access = fakeJwt({
			exp: Math.floor(Date.now() / 1000) + 86_400,
			[AUTH_NS]: { chatgpt_account_id: ACCOUNT },
		});
		const { codexHome } = await tempCodexHome({
			auth_mode: "chatgpt",
			tokens: {
				access_token: access,
				refresh_token: "r1",
				account_id: ACCOUNT,
			},
		});

		let fetchCalls = 0;
		const fetchImpl: typeof fetch = async () => {
			fetchCalls += 1;
			throw new Error("should not network");
		};

		const auth = await resolveVoiceAuth({
			codexHome,
			prefer: "codex",
			env: {},
			fetchImpl,
		});
		assert.equal(fetchCalls, 0);
		assert.equal(auth.headers.Authorization, `Bearer ${access}`);
	});
});
