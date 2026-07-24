# pi-live extension

A [pi](https://github.com/earendil-works/pi-coding-agent) extension with a small
demo surface plus a **voice transcription MVP** (epic
[#6](https://github.com/BlockedPath/pi-live/issues/6), slice
[#12](https://github.com/BlockedPath/pi-live/issues/12)).

- custom tool: `hello`
- `session_start` hook with a UI notification
- `/hello` slash command
- `/voice start|stop|status` transcription loop (mic → OpenAI Realtime → pi)

Full plan: [`docs/voice-realtime-plan.md`](../../docs/voice-realtime-plan.md).

## Install

Pick one:

### As a pi package

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
/voice stop            # close WS + stop mic
/voice status          # mode, state, auth preference/mode (no secrets)
/voice toggle          # same as bare /voice
```

Footer status (when UI is available): `voice: ● listening`,
`voice: pi working…` (capture gated while the agent runs), etc.

### Privacy

**Microphone audio is streamed to OpenAI’s Realtime API** for transcription.
Do not use `/voice start` on sensitive audio. Tokens from `~/.codex/auth.json`
or API keys are never written into pi session transcripts or status lines.

### Config (`PI_VOICE_*`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_VOICE_MODE` | `transcription` | `transcription` (MVP). `conversational` comes later (#14). |
| `PI_VOICE_MODEL` | `gpt-realtime-2.1` | Realtime model id |
| `PI_VOICE_VOICE` | `marin` | TTS voice (unused in transcription MVP) |
| `PI_VOICE_AUTH` | `auto` | `auto` \| `codex` \| `api-key` |
| `PI_VOICE_CODEX_HOME` | `~/.codex` | Where to read `auth.json` |
| `PI_VOICE_SAMPLE_RATE` | `24000` | PCM rate |
| `PI_VOICE_API_KEY` | *(unset)* | Explicit API key override (else `OPENAI_API_KEY`) |

### Manual test

```bash
cd extensions/pi-live && npm install
pi -e ./src/index.ts
# in pi:
/voice status
/voice start
# speak: "list files in this repo"
# expect a user turn + agent work; footer shows listening / pi working…
/voice stop
```

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| `No voice auth available` / `missing_auth` | `ls ~/.codex/auth.json` or set `OPENAI_API_KEY` / `PI_VOICE_API_KEY`. Prefer `PI_VOICE_AUTH=codex` or `api-key` to force one path. |
| `sox/rec not found on PATH` | `brew install sox`; ensure Homebrew’s bin is on `PATH` inside the pi process. |
| WS 401 / 403 | OAuth expired — re-login via Codex; or switch to a valid API key. |
| WS closes immediately | Model id / account entitlements; try `PI_VOICE_MODEL=gpt-realtime-mini` if available on your account. |
| No transcript / silence | OS mic permission for the terminal app; correct default input device; watch `/voice status` stays `listening`. |
| Transcript but pi does nothing | Bridge needs the extension’s `sendUserMessage`; ensure you started voice from inside pi (not a bare unit test). |
| Capture never resumes | Agent should fire `agent_settled`; `/voice stop` then `/voice start` recovers. |

### Module layout (`src/voice/`)

| File | Role |
| --- | --- |
| `types.ts` | Shared contracts (auth, session, transcripts, bridge) |
| `config.ts` | `PI_VOICE_*` env → typed config |
| `auth.ts` | Codex OAuth load/refresh + API key fallback |
| `realtime-client.ts` | GA Realtime WebSocket client |
| `capture.ts` | mic → PCM16 mono via sox/rec |
| `bridge.ts` | final text → `pi.sendUserMessage` (idle / steer) |
| `session.ts` | start/stop/status state machine |
| `index.ts` | Public barrel |

### Later slices (not in this MVP)

- #13 playback / speak-back  
- #14 conversational mode + `pi_turn` tool  
- #15 polish (partials widget, reconnect, PTT)  
- #16 optional Codex app-server backend  

Session hooks already reserved for those: `onTranscript`, `onStateChange`,
`setCapturePaused`.

## Layout

```
extensions/pi-live/
├── package.json   # pi extension entrypoint + deps
├── tsconfig.json
└── src/
    ├── index.ts   # extension entry (hello + /voice)
    └── voice/     # auth, realtime, capture, bridge, session
```
