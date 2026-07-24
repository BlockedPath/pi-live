# Plan: Realtime voice for pi-live

Status: **planned** (issues filed)
Owner: pi-live
Last updated: 2026-07-24

## Goal

Add hands-free voice control to the [pi-live](../extensions/pi-live) extension so a user can speak tasks into pi and have the normal pi agent loop execute them.

We copy the **architecture** of Codex realtime voice (voice plane + coding plane), not the private Frameless Bidi wire format on day one.

**Success (MVP):** with an existing ChatGPT Plus / Codex OAuth login (no API key required), the user runs `/voice start`, speaks a coding task, and pi executes it via `sendUserMessage`.

## GitHub issues (vertical slices)

Epic: [#6](https://github.com/BlockedPath/pi-live/issues/6) · label `voice` · project [Pi live #6](https://github.com/users/BlockedPath/projects/6)

| Wave | Issue | Slice | Priority | Parallel? | Owns | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | [#7](https://github.com/BlockedPath/pi-live/issues/7) | VS0 Foundation | P1 | serial | types/config/barrel/stub session/`ws`/`/voice status` | — |
| 1 | [#8](https://github.com/BlockedPath/pi-live/issues/8) | VS1 Auth | P1 | **with 9–11** | `auth.ts` | #7 |
| 1 | [#9](https://github.com/BlockedPath/pi-live/issues/9) | VS2 Realtime client | P1 | **with 8,10,11** | `realtime-client.ts` | #7 |
| 1 | [#10](https://github.com/BlockedPath/pi-live/issues/10) | VS3 Capture | P1 | **with 8,9,11** | `capture.ts` | #7 |
| 1 | [#11](https://github.com/BlockedPath/pi-live/issues/11) | VS4 Bridge | P1 | **with 8–10** | `bridge.ts` | #7 |
| 2 | [#12](https://github.com/BlockedPath/pi-live/issues/12) | VS5 Session MVP | P1 | serial | `session.ts` + `index.ts` wiring | #7–#11 |
| 3 | [#13](https://github.com/BlockedPath/pi-live/issues/13) | VS6 Playback/TTS | P2 | **with #14** | `playback.ts` | #12 |
| 3 | [#14](https://github.com/BlockedPath/pi-live/issues/14) | VS7 UX polish | P2 | **with #13** | widget/shortcut/prefs | #12 |
| 4 | [#15](https://github.com/BlockedPath/pi-live/issues/15) | VS8 Conversational | P2 | after MVP | `pi_turn` path | #12 (+#13 ideal) |
| 4 | [#16](https://github.com/BlockedPath/pi-live/issues/16) | VS9 Codex V3 backend | P2 | after MVP | `backends/codex-app-server.ts` | #12 |

### Worktree lanes

```text
main ──► #7 VS0 ──┬──► #8  auth     ──┐
                  ├──► #9  realtime ──┼──► #12 session MVP ──┬──► #13 playback ──┐
                  ├──► #10 capture  ──┤                      ├──► #14 polish   ──┼──► #15 conversational ──► #16 codex
                  └──► #11 bridge   ──┘                      └───────────────────┘
```

Suggested branch names: `lane-a-foundation`, `lane-b-auth`, `lane-c-realtime`, `lane-d-capture`, `lane-e-bridge`, `lane-f-session-mvp`, `lane-g-playback`, `lane-h-polish`, `lane-i-conversational`, `lane-j-codex-backend`.

**Conflict rule:** Wave 1 PRs edit only their owned file. Only #12 integrates. #13/#14 should use hooks left by #12 and rebase if both touch `session.ts`/`index.ts`.

## Non-goals (for now)

- Embedding ChatGPT GPT-Live product internals
- Cloning Codex Frameless Bidi / `delegation.*` wire protocol
- Requiring Codex desktop or `codex app-server` for the MVP
- Letting the realtime model edit files or run shell directly
- Perfect full-duplex UX on every platform in v1

## Background (research summary)

| Layer | What it is | Use in pi-live? |
| --- | --- | --- |
| GPT-Live (ChatGPT desktop) | Product full-duplex voice | No — not a public API |
| Codex realtime **V3** | Frameless Bidi + multi-agent handoff streaming | Architecture reference; optional later bridge |
| OpenAI Realtime API | Public WS/WebRTC speech + tools | **Yes — primary transport** |
| ChatGPT OAuth (`~/.codex/auth.json`) | Plus/Pro plan tokens | **Yes — primary auth** |

Codex split that we mirror:

```
Voice / control plane  →  holds conversation, STT/TTS, barge-in
Coding / worker plane  →  pi agent loop (tools, edits, shell)
```

Local evidence on this machine:

- `~/.codex/config.toml`: `realtime_conversation = true`, `[realtime] version = "v3"`, `transport = "webrtc"`
- `~/.codex/auth.json`: `auth_mode = "chatgpt"`, no API key
- Codex CLI 0.145.0 app-server surface: `thread/realtime/start|stop|appendAudio|…`

Full research notes live in session history; this doc is the execution plan only.

## Recommended approach

**Pi-native extension, OAuth-first, transcription MVP → conversational later → optional Codex bridge.**

```
Mic (CLI capture)
  → Realtime WS (OAuth Bearer + ChatGPT-Account-Id)
  → transcript
  → pi.sendUserMessage / steer / followUp
  → normal pi agent loop
  → (optional) TTS on agent_settled
```

### Why not start with Codex app-server V3?

- `realtime_conversation` is still **under development**
- Couples pi-live to the Codex binary and private protocol churn
- pi already has the coding plane (`sendUserMessage`, tools, models)
- We can add an app-server backend later without rewriting the UX

## Architecture

```
extensions/pi-live/
  src/
    index.ts                 # register /voice, shortcuts, lifecycle
    voice/
      types.ts               # shared types + config
      auth.ts                # Codex OAuth load/refresh + API key fallback
      realtime-client.ts     # GA Realtime WebSocket client
      capture.ts             # mic → PCM16 mono 24 kHz
      playback.ts            # PCM16 / system TTS playback
      session.ts             # start/stop/status state machine
      bridge.ts              # transcripts/tools ↔ pi.sendUserMessage
      config.ts              # env + defaults
```

### Auth

Priority order:

1. `~/.codex/auth.json` when `auth_mode === "chatgpt"`  
   - `Authorization: Bearer <access_token>`  
   - `ChatGPT-Account-Id: <account_id>`  
   - refresh via OpenAI auth account endpoints when near expiry  
2. `OPENAI_API_KEY` / `PI_VOICE_API_KEY` fallback  
3. Clear error if neither works

Never log tokens. Never commit `auth.json`.

### Config (env + optional future settings)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_VOICE_MODE` | `transcription` | `transcription` \| `conversational` |
| `PI_VOICE_MODEL` | `gpt-realtime-2.1` | Realtime model id |
| `PI_VOICE_VOICE` | `marin` | TTS voice (conversational / playback) |
| `PI_VOICE_AUTH` | `auto` | `auto` \| `codex` \| `api-key` |
| `PI_VOICE_CODEX_HOME` | `~/.codex` | Where to read `auth.json` |
| `PI_VOICE_SAMPLE_RATE` | `24000` | PCM rate |

### UX

```
/voice                 # toggle start/stop
/voice start [mode]
/voice stop
/voice status
/voice mode transcription|conversational
```

- Shortcut (TUI): `ctrl+shift+v` toggle (align with Codex desktop muscle memory)
- Footer: `ctx.ui.setStatus("voice", "● listening" | "transcribing" | "pi working…" | "speaking")`
- Widget: last partial/final transcript line
- Guard with `ctx.mode === "tui"` / `ctx.hasUI` where needed

### Bridge rules

| Agent state | Delivery |
| --- | --- |
| Idle | `pi.sendUserMessage(text)` |
| Busy | `pi.sendUserMessage(text, { deliverAs: "steer" })` or `followUp` (configurable; default steer for conversational interrupts, followUp for dictation batches) |

Never call bare `sendUserMessage` while streaming without `deliverAs`.

## Phases

### Phase 0 — Spike (½–1 day)

**Outcome:** prove OAuth + Realtime connectivity without full UX.

- [ ] `auth.ts`: load `~/.codex/auth.json`, decode exp, refresh if needed
- [ ] Minimal WS connect to `wss://api.openai.com/v1/realtime?model=…` with OAuth headers
- [ ] Log `session.created` / errors only (no secrets)
- [ ] Document failure modes (expired refresh, missing account id, 401/403)

**Exit criteria:** one successful `session.created` using ChatGPT OAuth on this machine.

### Phase 1 — Transcription MVP (1–3 days)

**Outcome:** usable voice → pi coding loop.

- [ ] `realtime-client.ts` (GA shape: nested `audio.input/output`, no beta header)
- [ ] `capture.ts` via `sox`/`rec` (PCM16 24 kHz mono); clear install hint if missing
- [ ] `session.ts` state machine: idle → connecting → listening → stopping
- [ ] `/voice start|stop|status` + status line
- [ ] On final transcript: bridge to `pi.sendUserMessage`
- [ ] Mute/gate capture while pi is noisy if needed (simple pause on `agent_start`)
- [ ] `npm run typecheck` clean
- [ ] Extension README: setup, auth, `/voice`, troubleshooting

**Exit criteria:** speak “list files in this repo” → pi runs the turn end-to-end.

### Phase 2 — Playback + polish (1–2 days)

**Outcome:** closed loop without full duplex complexity.

- [ ] Optional speak-back on `agent_settled` (OpenAI TTS **or** macOS `say`)
- [ ] Partial transcript widget
- [ ] Push-to-talk vs toggle (toggle default; PTT if editor-safe)
- [ ] Self-echo mitigation (pause capture during playback)
- [ ] Session persistence via `pi.appendEntry("voice-state", …)` for mode prefs
- [ ] Graceful reconnect / 60‑minute session limit handling

**Exit criteria:** hands-free dictate → work → short spoken “done” summary.

### Phase 3 — Conversational mode (2–4 days)

**Outcome:** Codex-like pair-programming feel; pi still does all coding.

- [ ] Realtime session with audio output + server VAD
- [ ] Register tool `pi_turn({ message })` only (narrow tool surface)
- [ ] On tool call: notify UI, `sendUserMessage`, wait `agent_settled`, return summary as `function_call_output`
- [ ] Prompt: voice model must not invent file contents; always delegate coding
- [ ] Barge-in: handle `input_audio_buffer.speech_started` / truncate playback
- [ ] Mode switch: `/voice mode conversational`

**Exit criteria:** spoken back-and-forth while pi edits code via `pi_turn`.

### Phase 4 — Optional Codex V3 bridge (later)

**Outcome:** true `thread/realtime/*` V3 path for users who want desktop-parity.

- [ ] Detect local `codex` binary / app-server
- [ ] Backend interface: `VoiceBackend` with `realtime-api` | `codex-app-server`
- [ ] Map `thread/realtime/*` events into the same session/bridge UI
- [ ] Use existing `~/.codex` config (`version = "v3"`, `transport = "webrtc"`)

**Exit criteria:** `/voice start --backend codex` works on a machine with Codex 0.145+.

## Dependencies

### Runtime (Phase 1)

- `ws` — WebSocket client
- system: `sox` or `rec` (capture), `afplay`/`ffplay` (optional playback)

### Dev

- existing `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typescript`

### Explicitly deferred

- native Node audio (`naudiodon` / `speaker`) until CLI path proves too high-latency
- browser/WebRTC companion window

## Security & privacy

- Tokens only in memory; refresh writes stay in `~/.codex/auth.json` ownership (prefer read-only from pi unless refresh requires update — then write atomically with user-file permissions)
- Never put access tokens in pi session transcripts or `appendEntry`
- Voice audio is sent to OpenAI Realtime — document that clearly in README
- Tool surface in conversational mode must stay narrow (`pi_turn`, maybe `status` / `cancel`)

## Testing strategy

| Level | What |
| --- | --- |
| Unit | auth header builder, transcript finalization, bridge delivery-mode selection |
| Typecheck | `npm run typecheck` (CI `ci` job) |
| Manual | OAuth session.created; full `/voice` dictate on macOS |
| Optional integration | mock WS server for event parsing (no live key in CI) |

CI must **not** require a mic or network Realtime call.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| OAuth refresh breaks | Fallback API key; clear `/voice status` errors; don’t crash pi |
| macOS mic permissions | Prefer CLI `rec`/`sox`; document TCC prompts |
| Self-echo loops | Pause capture during playback; optional PTT |
| Agent busy races | Always set `deliverAs` when not idle |
| Realtime cost | Default transcription; show status; easy `/voice stop` |
| GA protocol drift | Isolate client; pin event names; follow OpenAI GA docs + FLECT gotchas |
| Codex V3 churn | Keep behind optional backend; don’t block MVP |

## Milestone checklist

- [ ] **M0** Auth spike green — covered by #8 + connect path in #9/#12
- [ ] **M1** Transcription MVP — #7 → #8–#11 parallel → #12
- [ ] **M2** TTS/playback + polish — #13 + #14
- [ ] **M3** Conversational `pi_turn` — #15
- [ ] **M4** Optional Codex app-server backend — #16

## Implementation order (next actions)

1. Add `src/voice/` skeleton modules with types and no-op session.
2. Implement `auth.ts` against local `~/.codex/auth.json`.
3. Implement minimal `realtime-client.ts` connect/update/close.
4. Wire `/voice status` to show auth mode + connection state (safe debug).
5. Add capture + transcription → `sendUserMessage`.
6. Only then expand to playback and conversational tools.

## References

- OpenAI Realtime (GA): <https://developers.openai.com/api/docs/guides/realtime>
- Codex 0.145.0: <https://github.com/openai/codex/releases/tag/rust-v0.145.0>
- Codex V3 Frameless Bidi: <https://github.com/openai/codex/pull/33261>
- pi extensions: `@earendil-works/pi-coding-agent` → `docs/extensions.md`
- pi bridge example: `examples/extensions/send-user-message.ts`
- Community shape reference: FLECT `codex-realtime-voice-agent` (GA WS client patterns)

## Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-07-24 | Pi-native over Codex-first | pi owns coding plane; less coupling |
| 2026-07-24 | OAuth-first auth | Matches real user setup (`auth_mode=chatgpt`) |
| 2026-07-24 | Transcription before conversational | Faster path to useful hands-free coding |
| 2026-07-24 | CLI audio before native Node | Fewer install failures; good enough latency for MVP |
| 2026-07-24 | Codex app-server is Phase 4 | Optional parity, not blocker |
