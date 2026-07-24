/**
 * Voice auth resolution (VS1 / #8).
 *
 * Priority (when prefer === "auto"):
 * 1. ChatGPT/Codex OAuth from `~/.codex/auth.json` (`auth_mode === "chatgpt"`)
 * 2. `PI_VOICE_API_KEY` / `OPENAI_API_KEY` fallback
 *
 * Refresh endpoint (Codex-compatible):
 *   POST https://auth.openai.com/oauth/token
 *   body: { client_id, grant_type: "refresh_token", refresh_token }
 *   client_id: app_EMoamEEZ73f0CkXaXp7hrann
 *
 * Never log token values.
 */

import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
	ResolveVoiceAuthOptions,
	VoiceAuth,
	VoiceAuthPrefer,
} from "./types.js";

/** Codex OAuth client id (same as openai/codex CLI). */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/**
 * Token refresh endpoint used by Codex ChatGPT auth.
 * Override with `CODEX_REFRESH_TOKEN_URL_OVERRIDE` (Codex env name).
 */
export const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Refresh when access token expires within this window (matches Codex / ChatGPT web). */
export const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

const AUTH_CLAIM_NS = "https://api.openai.com/auth";

export type VoiceAuthErrorCode =
	| "missing_auth"
	| "invalid_auth_file"
	| "codex_unavailable"
	| "token_refresh_failed"
	| "missing_account_id";

/** Typed auth failure — messages must never include secret values. */
export class VoiceAuthError extends Error {
	readonly code: VoiceAuthErrorCode;

	constructor(
		code: VoiceAuthErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "VoiceAuthError";
		this.code = code;
	}
}

/** Optional hooks for tests / DI. Not part of the stable VS1 contract surface. */
export interface ResolveVoiceAuthHooks {
	/** Env source (defaults to `process.env`). */
	env?: NodeJS.ProcessEnv;
	/** Clock (epoch ms). */
	nowMs?: () => number;
	/** Fetch implementation (defaults to global `fetch`). */
	fetchImpl?: typeof fetch;
	/** When false, skip writing refreshed tokens back to auth.json (default true). */
	persistRefresh?: boolean;
	/** Explicit API key override (takes precedence over env). Never log. */
	apiKey?: string;
}

export type ResolveVoiceAuthInput = ResolveVoiceAuthOptions &
	ResolveVoiceAuthHooks;

/** Shape of `~/.codex/auth.json` (fields we care about). */
export interface CodexAuthFile {
	auth_mode?: string | null;
	OPENAI_API_KEY?: string | null;
	tokens?: {
		id_token?: string;
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	} | null;
	last_refresh?: string | null;
}

export interface CodexChatgptTokens {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	accountId: string;
	/** JWT `exp` in epoch ms when decodable. */
	expiresAt?: number;
}

/** Build Realtime / OpenAI headers for ChatGPT OAuth mode. */
export function buildChatgptAuthHeaders(
	accessToken: string,
	accountId: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"ChatGPT-Account-Id": accountId,
	};
}

/** Build Realtime / OpenAI headers for API key mode. */
export function buildApiKeyAuthHeaders(apiKey: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
	};
}

/**
 * Decode JWT payload without verifying the signature.
 * Used only for proactive expiry checks — the server is authoritative.
 */
export function decodeJwtPayload(
	token: string,
): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length < 2) return undefined;
	try {
		const json = base64UrlDecodeToString(parts[1]!);
		const payload = JSON.parse(json) as unknown;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return undefined;
		}
		return payload as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** JWT `exp` claim as epoch milliseconds, or undefined if missing/undecodable. */
export function getJwtExpiryMs(token: string): number | undefined {
	const payload = decodeJwtPayload(token);
	if (!payload) return undefined;
	const exp = payload.exp;
	if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
	return exp * 1000;
}

/**
 * True when the token is expired or within `skewMs` of expiry.
 * Returns false when exp cannot be decoded (caller may still attempt use).
 */
export function tokenNeedsRefresh(
	token: string,
	nowMs: number,
	skewMs: number = ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean {
	const expMs = getJwtExpiryMs(token);
	if (expMs === undefined) return false;
	return expMs <= nowMs + skewMs;
}

/** Extract ChatGPT account id from access/id token claims when file omits it. */
export function accountIdFromJwt(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	if (!payload) return undefined;
	const auth = payload[AUTH_CLAIM_NS];
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
	const id = (auth as Record<string, unknown>).chatgpt_account_id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Parse and validate a Codex auth.json document for ChatGPT mode.
 * Throws VoiceAuthError on structural problems (never embeds secrets).
 */
export function parseCodexChatgptAuth(raw: unknown): CodexChatgptTokens {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new VoiceAuthError(
			"invalid_auth_file",
			"Codex auth.json is not a JSON object.",
		);
	}
	const doc = raw as CodexAuthFile;
	if (doc.auth_mode !== "chatgpt") {
		throw new VoiceAuthError(
			"codex_unavailable",
			`Codex auth.json auth_mode is ${JSON.stringify(doc.auth_mode ?? null)}, expected "chatgpt".`,
		);
	}
	const tokens = doc.tokens;
	if (!tokens || typeof tokens !== "object") {
		throw new VoiceAuthError(
			"invalid_auth_file",
			"Codex auth.json is missing tokens for ChatGPT auth.",
		);
	}
	const accessToken = tokens.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new VoiceAuthError(
			"invalid_auth_file",
			"Codex auth.json is missing tokens.access_token.",
		);
	}
	const accountId =
		(typeof tokens.account_id === "string" && tokens.account_id) ||
		accountIdFromJwt(accessToken) ||
		(typeof tokens.id_token === "string"
			? accountIdFromJwt(tokens.id_token)
			: undefined);
	if (!accountId) {
		throw new VoiceAuthError(
			"missing_account_id",
			"Codex auth.json has no account id (tokens.account_id or JWT chatgpt_account_id).",
		);
	}
	const refreshToken =
		typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0
			? tokens.refresh_token
			: undefined;
	const idToken =
		typeof tokens.id_token === "string" && tokens.id_token.length > 0
			? tokens.id_token
			: undefined;
	return {
		accessToken,
		refreshToken,
		idToken,
		accountId,
		expiresAt: getJwtExpiryMs(accessToken),
	};
}

function resolveCodexHome(
	codexHome: string | undefined,
	env: NodeJS.ProcessEnv,
): string {
	if (codexHome && codexHome.trim()) return expandHome(codexHome.trim());
	const fromEnv = env.PI_VOICE_CODEX_HOME?.trim() || env.CODEX_HOME?.trim();
	if (fromEnv) return expandHome(fromEnv);
	return join(homedir(), ".codex");
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function resolveApiKey(
	options: ResolveVoiceAuthInput,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const explicit = options.apiKey?.trim();
	if (explicit) return explicit;
	return (
		env.PI_VOICE_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || undefined
	);
}

function refreshEndpoint(env: NodeJS.ProcessEnv): string {
	const override = env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim();
	return override || CODEX_REFRESH_TOKEN_URL;
}

function oauthClientId(env: NodeJS.ProcessEnv): string {
	const override = env.CODEX_APP_SERVER_LOGIN_CLIENT_ID?.trim();
	return override || CODEX_OAUTH_CLIENT_ID;
}

async function readCodexAuthFile(path: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		const code =
			err && typeof err === "object" && "code" in err
				? String((err as { code: unknown }).code)
				: undefined;
		if (code === "ENOENT") {
			throw new VoiceAuthError(
				"codex_unavailable",
				`Codex auth file not found at ${path}. Run \`codex login\` or set PI_VOICE_API_KEY / OPENAI_API_KEY.`,
				{ cause: err },
			);
		}
		throw new VoiceAuthError(
			"invalid_auth_file",
			`Failed to read Codex auth file at ${path}.`,
			{ cause: err },
		);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (err) {
		throw new VoiceAuthError(
			"invalid_auth_file",
			`Codex auth file at ${path} is not valid JSON.`,
			{ cause: err },
		);
	}
}

interface RefreshResult {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
}

/**
 * Exchange a refresh_token at the Codex OAuth token endpoint.
 * Endpoint: POST https://auth.openai.com/oauth/token
 */
export async function refreshCodexAccessToken(options: {
	refreshToken: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}): Promise<RefreshResult> {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") {
		throw new VoiceAuthError(
			"token_refresh_failed",
			"No fetch implementation available to refresh Codex OAuth tokens.",
		);
	}

	const url = refreshEndpoint(env);
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: oauthClientId(env),
				grant_type: "refresh_token",
				refresh_token: options.refreshToken,
			}),
		});
	} catch (err) {
		throw new VoiceAuthError(
			"token_refresh_failed",
			"Network error while refreshing Codex OAuth token.",
			{ cause: err },
		);
	}

	if (!response.ok) {
		// Do not include response body — it may echo tokens or codes we still avoid logging.
		throw new VoiceAuthError(
			"token_refresh_failed",
			`Codex OAuth token refresh failed with HTTP ${response.status}. Re-run \`codex login\` if this persists.`,
		);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		throw new VoiceAuthError(
			"token_refresh_failed",
			"Codex OAuth token refresh returned a non-JSON body.",
			{ cause: err },
		);
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new VoiceAuthError(
			"token_refresh_failed",
			"Codex OAuth token refresh returned an unexpected payload.",
		);
	}
	const record = body as Record<string, unknown>;
	const accessToken = record.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new VoiceAuthError(
			"token_refresh_failed",
			"Codex OAuth token refresh response missing access_token.",
		);
	}
	const refreshToken =
		typeof record.refresh_token === "string" && record.refresh_token.length > 0
			? record.refresh_token
			: undefined;
	const idToken =
		typeof record.id_token === "string" && record.id_token.length > 0
			? record.id_token
			: undefined;
	return { accessToken, refreshToken, idToken };
}

/** Atomically merge refreshed tokens into auth.json (0600). */
async function persistRefreshedTokens(
	authPath: string,
	existing: unknown,
	refreshed: RefreshResult,
): Promise<void> {
	const base: Record<string, unknown> =
		existing && typeof existing === "object" && !Array.isArray(existing)
			? { ...(existing as Record<string, unknown>) }
			: { auth_mode: "chatgpt" };
	const prevTokensRaw = base.tokens;
	const prevTokens: Record<string, unknown> =
		prevTokensRaw &&
		typeof prevTokensRaw === "object" &&
		!Array.isArray(prevTokensRaw)
			? { ...(prevTokensRaw as Record<string, unknown>) }
			: {};
	prevTokens.access_token = refreshed.accessToken;
	if (refreshed.refreshToken) prevTokens.refresh_token = refreshed.refreshToken;
	if (refreshed.idToken) prevTokens.id_token = refreshed.idToken;
	base.tokens = prevTokens;
	base.last_refresh = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

	const dir = dirname(authPath);
	const tmp = join(
		dir,
		`.auth.${process.pid}.${randomBytes(8).toString("hex")}.json.tmp`,
	);
	const json = `${JSON.stringify(base, null, 2)}\n`;
	try {
		await writeFile(tmp, json, { encoding: "utf8", mode: 0o600 });
		await rename(tmp, authPath);
	} catch (err) {
		try {
			await unlink(tmp);
		} catch {
			// ignore cleanup failure
		}
		throw new VoiceAuthError(
			"token_refresh_failed",
			"Refreshed Codex tokens but failed to persist auth.json.",
			{ cause: err },
		);
	}
}

async function resolveCodexAuth(
	options: ResolveVoiceAuthInput,
	env: NodeJS.ProcessEnv,
	nowMs: number,
): Promise<VoiceAuth> {
	const codexHome = resolveCodexHome(options.codexHome, env);
	const authPath = join(codexHome, "auth.json");
	const raw = await readCodexAuthFile(authPath);
	let tokens = parseCodexChatgptAuth(raw);

	if (tokenNeedsRefresh(tokens.accessToken, nowMs)) {
		if (!tokens.refreshToken) {
			throw new VoiceAuthError(
				"token_refresh_failed",
				"Codex access token is expired/near-expiry and no refresh_token is available. Run `codex login`.",
			);
		}
		const refreshed = await refreshCodexAccessToken({
			refreshToken: tokens.refreshToken,
			env,
			fetchImpl: options.fetchImpl,
		});
		if (options.persistRefresh !== false) {
			try {
				await persistRefreshedTokens(authPath, raw, refreshed);
			} catch (err) {
				// Prefer in-memory success if disk write fails — still usable this process.
				if (!(err instanceof VoiceAuthError)) throw err;
				// swallow persist errors only after successful refresh; tokens still returned
			}
		}
		const accessToken = refreshed.accessToken;
		const accountId =
			tokens.accountId ||
			accountIdFromJwt(accessToken) ||
			(refreshed.idToken ? accountIdFromJwt(refreshed.idToken) : undefined);
		if (!accountId) {
			throw new VoiceAuthError(
				"missing_account_id",
				"Refreshed Codex token is missing account id.",
			);
		}
		tokens = {
			accessToken,
			refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
			idToken: refreshed.idToken ?? tokens.idToken,
			accountId,
			expiresAt: getJwtExpiryMs(accessToken),
		};
	}

	return {
		mode: "chatgpt",
		headers: buildChatgptAuthHeaders(tokens.accessToken, tokens.accountId),
		accountId: tokens.accountId,
		expiresAt: tokens.expiresAt,
	};
}

function resolveApiKeyAuth(apiKey: string): VoiceAuth {
	return {
		mode: "api-key",
		headers: buildApiKeyAuthHeaders(apiKey),
	};
}

/**
 * Resolve Realtime credentials: ChatGPT/Codex OAuth first, API key second.
 *
 * @example
 * ```ts
 * const auth = await resolveVoiceAuth({ prefer: "auto" });
 * // auth.headers → Authorization (+ ChatGPT-Account-Id in chatgpt mode)
 * ```
 */
export async function resolveVoiceAuth(
	options: ResolveVoiceAuthInput = {},
): Promise<VoiceAuth> {
	const env = options.env ?? process.env;
	const nowMs = options.nowMs?.() ?? Date.now();
	const prefer: VoiceAuthPrefer = options.prefer ?? "auto";
	const apiKey = resolveApiKey(options, env);

	if (prefer === "api-key") {
		if (!apiKey) {
			throw new VoiceAuthError(
				"missing_auth",
				"No API key found. Set PI_VOICE_API_KEY or OPENAI_API_KEY.",
			);
		}
		return resolveApiKeyAuth(apiKey);
	}

	if (prefer === "codex") {
		return resolveCodexAuth(options, env, nowMs);
	}

	// auto: codex first, then api key
	try {
		return await resolveCodexAuth(options, env, nowMs);
	} catch (err) {
		if (apiKey) return resolveApiKeyAuth(apiKey);
		if (err instanceof VoiceAuthError) throw err;
		throw new VoiceAuthError(
			"missing_auth",
			"No voice auth available (Codex OAuth failed and no API key is set).",
			{ cause: err },
		);
	}
}

function base64UrlDecodeToString(input: string): string {
	const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
	const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(b64, "base64").toString("utf8");
}
