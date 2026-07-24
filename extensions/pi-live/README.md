# pi-live extension

A [pi](https://github.com/earendil-works/pi-coding-agent) extension with a small
demo surface plus a **voice transcription + optional speak-back** loop (epic
[#6](https://github.com/BlockedPath/pi-live/issues/6), slices
[#12](https://github.com/BlockedPath/pi-live/issues/12) /
[#13](https://github.com/BlockedPath/pi-live/issues/13)).

- custom tool: `hello`
- `session_start` hook with a UI notification
- `/hello` slash command
- `/voice start|stop|status` transcription loop (mic → OpenAI Realtime → pi)
- optional TTS speak-back on `agent_settled` (macOS `say` or OpenAI TTS)

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

## Voice transcription MVP

Hands-free dictate → final transcript → `pi.sendUserMessage` → coding turn.

### Prerequisites

1. **Auth (pick one)**
   - **Codex / ChatGPT OAuth (preferred):** be logged in so
     `~/.codex/auth.json` exists with `auth_mode: "chatgpt"`.  
     Typical path: install and run [Codex CLI](https://github.com/openai/codex)
     once (`codex login`) or use the ChatGPT desktop app’s Codex integration.
   - **API key fallback:** set `OPENAI_API_KEY` or `PI_VOICE_API_KEY`.

2. **Microphone capture (SoX)**  
   PCM16 mono @ 24 kHz via CLI `rec` / `sox` (no native Node addons):

   ```bash
   # macOS
   brew install sox
   ```

   Confirm: `which rec || which sox`.

3. **Network** to `wss://api.openai.com/v1/realtime`.

### Commands

```
/voice                 # toggle start/stop
/voice start           # connect + capture + stream
/voice stop            # close WS + stop mic + stop TTS
/voice status          # mode, state, auth preference/mode (no secrets)
/voice toggle          # same as bare /voice
```

Footer status (when UI is available) updates live:
- `voice: ● listening · waiting for mic…` — capture not producing chunks yet
- `voice: ● listening · mic silent? (lvl 0%)` — chunks arrive but look like silence (wrong input device / muted)
- `voice: ● listening · lvl 42%` — mic energy detected
- `voice: hearing…` / `voice: hearing: <partial>` — server VAD + partial transcript
- `voice: pi working…` — capture gated while the agent runs
- `voice: speaking…` — TTS speak-back in progress (mic paused to reduce echo)

`/voice status` also prints `micChunks`, `lvl`, `tts=…`, `speaking=yes`, and any `partial`.

### Privacy

**Microphone audio is streamed to OpenAI’s Realtime API** for transcription.
Do not use `/voice start` on sensitive audio. Tokens from `~/.codex/auth.json`
or API keys are never written into pi session transcripts or status lines.

### Config (`PI_VOICE_*`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_VOICE_MODE` | `transcription` | `transcription` (MVP). `conversational` comes later (#14). |
| `PI_VOICE_MODEL` | `gpt-realtime-2.1` | Realtime model id |
| `PI_VOICE_VOICE` | `marin` | TTS voice (OpenAI names for `openai`; macOS voice name for `say`, e.g. `Samantha`) |
| `PI_VOICE_TTS` | `say` on macOS, else `off` | Speak-back backend: `say` \| `openai` \| `off` |
| `PI_VOICE_AUTH` | `auto` | `auto` \| `codex` \| `api-key` |
| `PI_VOICE_CODEX_HOME` | `~/.codex` | Where to read `auth.json` |
| `PI_VOICE_SAMPLE_RATE` | `24000` | PCM rate |
| `PI_VOICE_API_KEY` | *(unset)* | Explicit API key override (else `OPENAI_API_KEY`); required for `PI_VOICE_TTS=openai` |
| `PI_VOICE_INPUT_DEVICE` | *(system default)* | CoreAudio device name, e.g. `iPhone Microphone` or `MacBook Air Microphone` |
| `PI_VOICE_RELAY_TARGET` | *(unset)* | Herdr agent name or pane id — finals go via `herdr agent prompt <target> …` |
| `PI_VOICE_RELAY_MODE` | `local` (or `relay` if target set) | `local` \| `relay` \| `both` |

### Manual test

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
| `No voice auth available` / `missing_auth` | `ls ~/.codex/auth.json` or set `OPENAI_API_KEY` / `PI_VOICE_API_KEY`. Prefer `PI_VOICE_AUTH=codex` or `api-key` to force one path. |
| `sox/rec not found on PATH` | `brew install sox`; ensure Homebrew’s bin is on `PATH` inside the pi process. |
| WS 401 / 403 | OAuth expired — re-login via Codex; or switch to a valid API key. |
| WS closes immediately | Model id / account entitlements; try `PI_VOICE_MODEL=gpt-realtime-mini` if available on your account. |
| No transcript / silence | OS mic permission for the terminal app; correct default input device; watch `/voice status` stays `listening`. |
| `micChunks` rising but `lvl=0%` / `mic silent` | **Capture works; the device is silent.** On macOS: System Settings → Privacy & Security → **Microphone** → enable **Ghostty** (or whatever hosts the shell). Confirm default input is the real mic. Or force a device: `PI_VOICE_INPUT_DEVICE='iPhone Microphone'` (restart pi). CLI check while speaking: `sox -t coreaudio "iPhone Microphone" -n stat trim 0 1` — `Maximum amplitude` should be ≫ 0. |
| Transcript but pi does nothing | Bridge needs the extension’s `sendUserMessage`; ensure you started voice from inside pi (not a bare unit test). |
| Capture never resumes | Agent should fire `agent_settled`; `/voice stop` then `/voice start` recovers. |
| No speak-back | Check `PI_VOICE_TTS` (not `off`), voice session is live (`/voice start`), and on OpenAI path you have an API key. macOS: `which say`. |
| Echo / TTS heard as input | Capture pauses during speak-back; if residual, set `PI_VOICE_TTS=off` or lower speaker volume. |

### Module layout (`src/voice/`)

| File | Role |
| --- | --- |
| `types.ts` | Shared contracts (auth, session, transcripts, bridge) |
| `config.ts` | `PI_VOICE_*` env → typed config |
| `auth.ts` | Codex OAuth load/refresh + API key fallback |
| `realtime-client.ts` | GA Realtime WebSocket client |
| `capture.ts` | mic → PCM16 mono via sox/rec |
| `bridge.ts` | final text → `pi.sendUserMessage` (idle / steer) |
| `playback.ts` | TTS speak-back (`say` / OpenAI / off) |
| `session.ts` | start/stop/status state machine + speakBack |
| `index.ts` | Public barrel |

### Later slices (not in this MVP)

- #14 conversational mode + `pi_turn` tool  
- #15 polish (partials widget, reconnect, PTT)  
- #16 optional Codex app-server backend  

Session hooks used by speak-back: `setCapturePaused`, `speakBack`, `onStateChange`.

## Layout

```
extensions/pi-live/
├── package.json   # pi extension entrypoint + deps
├── tsconfig.json
└── src/
    ├── index.ts   # extension entry (hello + /voice)
    └── voice/     # auth, realtime, capture, bridge, session
```
