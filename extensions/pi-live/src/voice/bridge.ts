/**
 * Pi message bridge (VS4 / issue #11).
 *
 * Delivers finalized voice text into the pi agent loop with correct idle vs
 * busy semantics. Never calls bare `sendUserMessage` while the agent is
 * streaming — that throws without `deliverAs`.
 *
 * Does not import capture / realtime / auth (owned by parallel Wave 1 slices).
 */

import type {
	BridgeDeliveryMode,
	DeliverVoiceTextOptions,
} from "./types.js";

/** Minimal pi surface needed to inject a user message. */
export interface VoiceBridgePi {
	sendUserMessage: (
		text: string,
		opts?: { deliverAs?: BridgeDeliveryMode },
	) => void;
}

/**
 * Call options for {@link deliverVoiceText}.
 *
 * Extends the VS0 {@link DeliverVoiceTextOptions} with an injectable idle
 * probe so unit tests (and session wiring in #12) can avoid the TUI.
 */
export interface DeliverVoiceTextCallOptions extends DeliverVoiceTextOptions {
	/**
	 * Returns whether the agent is currently idle.
	 * When omitted, treated as idle (bare `sendUserMessage`).
	 */
	isIdle?: () => boolean;
}

/** Default busy delivery — steer interrupts the current turn promptly. */
const DEFAULT_WHEN_BUSY: BridgeDeliveryMode = "steer";

/**
 * Deliver voice transcript text into the pi agent loop.
 *
 * - Trims `text`; no-ops on empty / whitespace-only input.
 * - Idle → `pi.sendUserMessage(text)`
 * - Busy → `pi.sendUserMessage(text, { deliverAs })` (never bare while streaming)
 */
export function deliverVoiceText(
	pi: VoiceBridgePi,
	text: string,
	opts?: DeliverVoiceTextCallOptions,
): void {
	const trimmed = text.trim();
	if (!trimmed) {
		return;
	}

	const idle = opts?.isIdle?.() ?? true;
	if (idle) {
		pi.sendUserMessage(trimmed);
		return;
	}

	const deliverAs = opts?.whenBusy ?? DEFAULT_WHEN_BUSY;
	pi.sendUserMessage(trimmed, { deliverAs });
}
