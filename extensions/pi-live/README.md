# pi-live extension

A [pi](https://github.com/earendil-works/pi-coding-agent) extension with a small
demo surface plus a **voice transcription / conversational** loop (epic
[#6](https://github.com/BlockedPath/pi-live/issues/6), slices
[#12](https://github.com/BlockedPath/pi-live/issues/12) /
[#13](https://github.com/BlockedPath/pi-live/issues/13) /
[#14](https://github.com/BlockedPath/pi-live/issues/14) /
[#15](https://github.com/BlockedPath/pi-live/issues/15) /
[#16](https://github.com/BlockedPath/pi-live/issues/16)).

- custom tool: `hello`
- `session_start` hook with a UI notification
- `/hello` slash command
- `/voice start|stop|status|mode` — transcription (default) or conversational
- **`ctrl+shift+v`** toggle shortcut (same as bare `/voice`)
- partial/final transcript widget above the editor
- optional TTS speak-back on `agent_settled` (macOS `say` or OpenAI TTS) in transcription mode
- conversational mode: Realtime audio out + narrow `pi_turn` tool (coding stays in pi)
- prefs persistence via `appendEntry("voice-state")` (mode/tts/voice/device)
- auto-reconnect on WS drop + proactive refresh before the ~60-minute session limit

Full plan: [`docs/voice-realtime-plan.md`](../../docs/voice-realtime-plan.md).

## Install

Pick one:

### As a pi package

From this directory:

```bash
pi install .
# or project-local settings:
pi install . -l
```

From the repo root:

```bash
pi install ./extensions/pi-live
```

This uses the `pi.extensions` entry declared in [`package.json`](package.json).

### Project-local (auto-discovered)

Copy or symlink this directory into the project's extension directory:

```bash
ln -s "$(pwd)/extensions/pi-live" .pi/extensions/pi-live
# then in pi: /reload
```

### Quick test (no install)

```bash
cd extensions/pi-live
npm install
pi -e ./src/index.ts
```

## Develop

```bash
cd extensions/pi-live
npm install        # first time only
npm run typecheck  # tsc --noEmit
npm test           # unit tests (no network / no mic)
```

Pi loads the extension via [jiti](https://github.com/unjs/jiti), so TypeScript
runs without a build step. Edit sources and use `/reload` (for auto-discovered
installs) to pick up changes.

## Try it

Once loaded:

- Ask the agent: *"Use the hello tool to greet Sam."*
- Or type the command: `/hello Sam`
- Voice: `/voice status`, then `/voice start` (see setup below)

---

## Voice

Two modes (default **transcription**):

| Mode | What happens | Cost profile |
| --- | --- | --- |
| **transcription** (default) | Mic → Realtime STT only (`output_modalities: ["text"]`) → final transcript bridges into pi → optional local/OpenAI TTS speak-back | Lower — mostly input transcription + optional short TTS |
| **conversational** | Mic ↔ Realtime full-duplex audio; model may call **`pi_turn({ message })` only**; pi runs the coding turn; tool result returns as `function_call_output`; Realtime speaks a brief status | Higher — continuous realtime audio in/out + tool rounds |

On the default OpenAI backend, **the Realtime model never edits files or runs shell** — coding always goes through pi (`sendUserMessage` / `pi_turn` → agent loop).

### Realtime backends

| Backend | Enable | Transport | Behavior |
| --- | --- | --- | --- |
| **OpenAI** (default) | Leave `PI_VOICE_BACKEND` unset or set it to `openai` | Pi connects directly to the OpenAI Realtime WebSocket | Existing transcription and conversational `pi_turn` path; unchanged |
| **Codex app-server realtime** (experimental) | `PI_VOICE_BACKEND=codex` | Pi spawns local `codex app-server --stdio` and adapts `thread/realtime/*` JSON-RPC events | V2 text for transcription; V3 audio for conversational; reuses the existing session UX |

The Codex backend is strictly opt-in. Missing or invalid values fall back to `openai`. It requires Codex CLI 0.145+. Codex app-server V3 bidirectional realtime works with ChatGPT/Codex OAuth (`~/.codex/auth.json`) — no API key is required for the audio/conversational path. (V2 text/transcription may still need an API key on some accounts; set `OPENAI_API_KEY` or `PI_VOICE_API_KEY` if a `requires API key auth` error appears.) The extension negotiates `experimentalApi`, forwards resolved credentials only to the child environment, checks `codex --version`, uses V2 for text/transcription, and uses V3 for audio/conversational.

Codex realtime limitations:

- **Transcription mode is recommended for coding:** final user transcripts still bridge to pi normally.
- In conversational mode, Codex's own handoff mechanism is not mapped to pi's `pi_turn`; handoff items are ignored by this adapter.
- Codex exposes no documented server-VAD markers or output-audio completion event, so the adapter synthesizes speech markers from transcript events and finishes audio on the assistant transcript final.
- The exact `thread/realtime/transcript/done` wire name is inferred from the protocol type and remains an experimental compatibility assumption.
- Live `updateSession` and OpenAI-style function-call/cancel/truncate methods are unavailable; stop and restart voice after changing modes.

These differences are confined to the thin `RealtimeClientLike` adapter; the default OpenAI client and pi-native session path are not rewritten.

### Prerequisites

1. **Auth**
   - **Default OpenAI backend:** Codex / ChatGPT OAuth (`~/.codex/auth.json`) or an API key.
   - **Codex app-server backend:** ChatGPT/Codex OAuth is sufficient for V3 bidi realtime (`auto`). Optionally set `OPENAI_API_KEY` or `PI_VOICE_API_KEY` if a `requires API key auth` error appears for V2 text mode; the session follows `PI_VOICE_AUTH` and does NOT force a key.

2. **Microphone capture (SoX)**  
   PCM16 mono @ 24 kHz via CLI `rec` / `sox` (no native Node addons):

   ```bash
   # macOS
   brew install sox
   ```

   Confirm: `which rec || which sox`.

3. **Network** to the selected provider. The default OpenAI backend connects directly to `wss://api.openai.com/v1/realtime`; the Codex backend delegates the provider connection to the local `codex app-server` child.

### Commands

```
/voice                 # toggle start/stop
/voice start [mode]    # connect + capture + stream (optional mode)
/voice stop            # close WS + stop mic + stop TTS / realtime audio
/voice status          # mode, state, auth preference/mode (no secrets)
/voice toggle          # same as bare /voice
/voice mode transcription|conversational
```

Keyboard shortcut (TUI):
- **`ctrl+shift+v`** — toggle voice (start when idle, stop when live)

Footer status (when UI is available) updates live:
- `voice: ● listening · waiting for mic…` — capture not producing chunks yet
- `voice: ● listening · mic silent? (lvl 0%)` — chunks arrive but look like silence (wrong input device / muted)
- `voice: ● listening · lvl 42%` — mic energy detected
- `voice: hearing…` / `voice: hearing: <partial>` — server VAD + partial transcript
- `voice: pi working…` — capture gated while the agent runs
- `voice: speaking…` — TTS speak-back in progress (mic paused to reduce echo)
- `voice: echo guard…` — brief post-TTS hold-off so speaker tail is not transcribed
- `voice: reconnecting (n/3)…` — WS dropped; soft reconnect in progress

Transcript widget (above the editor, when `setWidget` is available):
- `voice ↻ connecting…` / `voice ↻ reconnecting (n/3)…`
- `voice ▸ <partial transcript>` while you speak
- `voice ✓ <final transcript>` briefly after each utterance

`/voice status` also prints `micChunks`, `lvl`, `tts=…`, `speaking=yes`, and any `partial`.

### Privacy

**Microphone audio leaves your machine for provider-side Realtime processing.** The default backend streams directly to OpenAI; the Codex backend passes PCM to the local Codex app-server, which sends it to its configured provider. Neither mode is offline. Do not use `/voice start` on sensitive audio. Tokens from `~/.codex/auth.json` or API keys are never written into pi session transcripts or status lines.

### Config (`PI_VOICE_*`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_VOICE_BACKEND` | `openai` | `openai` (pi-native direct WebSocket) or `codex` (experimental app-server realtime: V2 text / V3 audio) |
| `PI_VOICE_MODE` | `transcription` | `transcription` (default) or `conversational` (Realtime audio + `pi_turn` on the OpenAI backend) |
| `PI_VOICE_MODEL` | `gpt-realtime-2.1` | Realtime model id |
| `PI_VOICE_VOICE` | `marin` | TTS voice (OpenAI names for `openai`; macOS voice name for `say`, e.g. `Samantha`) |
| `PI_VOICE_TTS` | `say` on macOS, else `off` | Speak-back backend: `say` \| `openai` \| `off` |
| `PI_VOICE_AUTH` | `auto` | `auto` \| `codex` \| `api-key` |
| `PI_VOICE_CODEX_HOME` | `~/.codex` | Where to read `auth.json` |
| `PI_VOICE_SAMPLE_RATE` | `24000` | PCM rate |
| `PI_VOICE_API_KEY` | *(unset)* | Explicit API key override (else `OPENAI_API_KEY`); needed for `PI_VOICE_TTS=openai` and as a fallback if V2 text realtime reports `requires API key auth` |
| `PI_VOICE_INPUT_DEVICE` | *(system default)* | CoreAudio device name, e.g. `iPhone Microphone` or `MacBook Air Microphone` |
| `PI_VOICE_RELAY_TARGET` | *(unset)* | Herdr agent name or pane id — finals go via `herdr agent prompt <target> …` |
| `PI_VOICE_RELAY_MODE` | `local` (or `relay` if target set) | `local` \| `relay` \| `both` |

### Prefs persistence

On `/voice start|stop|toggle` (and `ctrl+shift+v`), the extension writes a
session custom entry:

```ts
pi.appendEntry("voice-state", { v: 1, mode, tts, voice, inputDevice })
```

On `session_start` / resume / `/reload`, the latest `voice-state` entry is
restored into the live session **unless** the matching `PI_VOICE_*` env var is
set (env always wins). Tokens and API keys are never stored.

### Manual test — transcription (default)

```bash
# --- Local Ghostty pane (mic works; satellite voice) ---
cd extensions/pi-live && npm install
export PI_VOICE_RELAY_TARGET=vs5-session   # main coding agent name or pane id
# export PI_VOICE_RELAY_MODE=relay          # default when target is set
# export PI_VOICE_INPUT_DEVICE='MacBook Air Microphone'
# Speak-back (macOS default is say; disable with off):
# export PI_VOICE_TTS=say
# export PI_VOICE_TTS=openai   # needs OPENAI_API_KEY / PI_VOICE_API_KEY
# export PI_VOICE_TTS=off
pi -e ./src/index.ts
# /voice start  → speak a task → pi works → hears a short spoken summary
```

### Manual test — Codex app-server realtime (experimental)

```bash
cd extensions/pi-live && npm install
codex --version
# ChatGPT/Codex OAuth (codex login) is enough for V3 audio. V2 text (transcription)
# may need a key on some accounts — uncomment if you hit `requires API key auth`:
# export PI_VOICE_API_KEY='sk-...'   # or export OPENAI_API_KEY='sk-...'
export PI_VOICE_BACKEND=codex
export PI_VOICE_MODE=transcription # uses realtime V2 text; coding stays in pi
export PI_VOICE_TTS=off
pi -e ./src/index.ts
# /voice status  → includes backend=codex (authMode follows PI_VOICE_AUTH; auto → chatgpt)
# /voice start   → speak a task → final transcript bridges into pi
# /voice stop
```

Unset `PI_VOICE_BACKEND` (or set it to `openai`) to return to the default direct WebSocket backend. Backend selection is environment-only and is not persisted in `voice-state`.

### Manual test — conversational (`pi_turn`)

```bash
cd extensions/pi-live && npm install
# Optional: PI_VOICE_MODE=conversational
pi -e ./src/index.ts
# /voice mode conversational
# /voice start
# Speak naturally, e.g. "list the TypeScript files in this repo"
# Expect: Realtime may reply briefly, then call pi_turn → pi runs tools →
#         function_call_output → Realtime speaks a short status.
# Barge-in: talk over the assistant — playback stops / response truncates.
# /voice mode transcription   # back to cheaper STT-only default
# /voice stop
```

Requires sox `play` on PATH for Realtime PCM playback (`brew install sox`).
Without `play`, barge-in truncate timing still works; you just won't hear audio out.

### Talk-back (TTS) manual check

1. On macOS leave `PI_VOICE_TTS` unset (defaults to `say`), or set it explicitly.
2. `pi -e ./src/index.ts` then `/voice start`.
3. Speak a short coding ask (or type a user message while voice is live).
4. When the agent settles, footer should show `voice: speaking…` briefly and
   macOS `say` (or OpenAI TTS + `afplay`) should read a short summary of the
   last assistant text (truncated; not a full monologue).
5. `/voice stop` must cut off any in-flight speech.
6. `PI_VOICE_TTS=off` disables speak-back entirely.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| `No voice auth available` / `missing_auth` | Set `OPENAI_API_KEY` or `PI_VOICE_API_KEY`. For the Codex backend, ChatGPT/Codex OAuth is enough for V3 realtime; a key is only needed if V2 text mode reports `requires API key auth`. |
| `codex backend requires the Codex CLI` | Install/update Codex, ensure `codex` is on the pi process `PATH`, and run `codex --version`. Or unset `PI_VOICE_BACKEND` to use the default OpenAI backend. |
| `experimentalApi capability` | Update to the latest branch/PR version; the adapter must send `capabilities.experimentalApi=true` during initialize. |
| `text realtime output modality requires realtime v2` | Update to the latest branch/PR version; transcription now selects V2 text automatically while conversational mode uses V3 audio. |
| `realtime voice \`<name>\` is not supported for v3` | Codex V3 audio only accepts: juniper, maple, spruce, ember, vale, breeze, arbor, sol, cove. The adapter drops an unsupported `PI_VOICE_VOICE` (e.g. the default `marin`) and lets Codex pick its own; set `PI_VOICE_VOICE=juniper` to choose one. |
| `codex realtime rejected start` | Check the full reported message, Codex version, and model/account entitlement. Use `PI_VOICE_BACKEND=openai` to return to the default backend. |
| `sox/rec not found on PATH` | `brew install sox`; ensure Homebrew’s bin is on `PATH` inside the pi process. |
| WS 401 / 403 | OAuth expired — re-login via Codex; or switch to a valid API key. |
| WS closes immediately | Model id / account entitlements; try `PI_VOICE_MODEL=gpt-realtime-mini` if available on your account. |
| `connection closed` / reconnecting | Transient network or the ~60-minute Realtime limit. Voice auto-retries 3× and refreshes proactively near 55 minutes. If it stops, `/voice start` again. |
| No transcript / silence | OS mic permission for the terminal app; correct default input device; watch `/voice status` stays `listening`. |
| `micChunks` rising but `lvl=0%` / `mic silent` | **Capture works; the device is silent.** On macOS: System Settings → Privacy & Security → **Microphone** → enable **Ghostty** (or whatever hosts the shell). Confirm default input is the real mic. Or force a device: `PI_VOICE_INPUT_DEVICE='iPhone Microphone'` (restart pi). CLI check while speaking: `sox -t coreaudio "iPhone Microphone" -n stat trim 0 1` — `Maximum amplitude` should be ≫ 0. |
| Transcript but pi does nothing | Bridge needs the extension’s `sendUserMessage`; ensure you started voice from inside pi (not a bare unit test). |
| Capture never resumes | Agent should fire `agent_settled`; `/voice stop` then `/voice start` recovers. |
| No speak-back | Check `PI_VOICE_TTS` (not `off`), voice session is live (`/voice start`), and on OpenAI path you have an API key. macOS: `which say`. |
| Echo / TTS heard as input | Capture pauses during speak-back plus a short echo-guard hold-off; if residual, set `PI_VOICE_TTS=off` or lower speaker volume. |
| Prefs not restored after reload | Confirm you started/stopped voice at least once (writes `voice-state`). Explicit `PI_VOICE_*` env overrides saved prefs. |

### Module layout (`src/voice/`)

| File | Role |
| --- | --- |
| `types.ts` | Shared contracts (auth, session, transcripts, bridge) |
| `config.ts` | `PI_VOICE_*` env → typed config |
| `auth.ts` | Codex OAuth load/refresh + API key fallback |
| `realtime-client.ts` | Default GA Realtime WebSocket client (+ `pi_turn` session / tool events) |
| `backends/index.ts` | Environment-selected `RealtimeClientLike` factory |
| `backends/codex-app-server.ts` | Experimental Codex app-server realtime adapter (V2 text / V3 audio) |
| `capture.ts` | mic → PCM16 mono via sox/rec |
| `bridge.ts` | final text → `pi.sendUserMessage` (idle / steer) |
| `playback.ts` | TTS speak-back (`say` / OpenAI / off) |
| `prefs.ts` | `voice-state` parse/restore helpers |
| `session.ts` | start/stop/status + reconnect + widget + speakBack + conversational pi_turn |
| `index.ts` | Public barrel |

Session hooks: `setCapturePaused`, `speakBack`, `setMode`, `notifyAgentSettled`,
`onStateChange`, `applyPrefs` / `getPrefs`.

## Layout

```
extensions/pi-live/
├── package.json   # pi extension entrypoint + deps
├── tsconfig.json
└── src/
    ├── index.ts   # extension entry (hello + /voice)
    └── voice/     # auth, realtime, capture, bridge, session
```
