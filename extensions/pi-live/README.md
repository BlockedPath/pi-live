# pi-live extension

A small [pi](https://github.com/earendil-works/pi-coding-agent) extension
skeleton demonstrating the common patterns:

- a custom tool registered with `pi.registerTool()` (the `hello` tool)
- a `session_start` hook with a UI notification
- a custom `/hello` slash command
- a `/voice` status stub (voice foundation — issue [#7](https://github.com/BlockedPath/pi-live/issues/7))

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
```

Pi loads the extension via [jiti](https://github.com/unjs/jiti), so TypeScript
runs without a build step. Edit `src/index.ts` and use `/reload` (for
auto-discovered installs) to pick up changes.

## Try it

Once loaded:

- Ask the agent: *"Use the hello tool to greet Sam."*
- Or type the command: `/hello Sam`
- Voice status stub: `/voice` or `/voice status` (reports `idle`; no mic/network yet)

## Voice (foundation)

VS0 skeleton for hands-free voice control (epic
[#6](https://github.com/BlockedPath/pi-live/issues/6), slice
[#7](https://github.com/BlockedPath/pi-live/issues/7)). Full plan:
[`docs/voice-realtime-plan.md`](../../docs/voice-realtime-plan.md).

Module layout under `src/voice/`

| File | Role |
| --- | --- |
| `types.ts` | Shared contracts (auth, session, transcripts, bridge) |
| `config.ts` | `PI_VOICE_*` env → typed config |
| `session.ts` | Idle stub (`getStatus` / `getState`) |
| `index.ts` | Public barrel |

Config defaults (override via env):

| Variable | Default |
| --- | --- |
| `PI_VOICE_MODE` | `transcription` |
| `PI_VOICE_MODEL` | `gpt-realtime-2.1` |
| `PI_VOICE_VOICE` | `marin` |
| `PI_VOICE_AUTH` | `auto` |
| `PI_VOICE_CODEX_HOME` | `~/.codex` |
| `PI_VOICE_SAMPLE_RATE` | `24000` |

Later slices (do not implement here): auth (#8), realtime client (#9), mic
capture (#10), pi bridge (#11), session MVP (#12).

Dependency `ws` is declared now so Wave 1 realtime work does not thrash
`package.json`.

## Layout

```
extensions/pi-live/
├── package.json   # declares the pi extension entrypoint + deps
├── tsconfig.json   # strict TS config for typechecking
└── src/
    ├── index.ts    # extension entry (hello + /voice status)
    └── voice/      # voice foundation (types, config, idle session stub)
```

## Active plan: realtime voice

The next major feature is hands-free voice control. Full plan:

[docs/voice-realtime-plan.md](../../docs/voice-realtime-plan.md)

Summary:

1. **Phase 0** — ChatGPT OAuth (`~/.codex/auth.json`) + Realtime `session.created` spike
2. **Phase 1** — Transcription MVP: mic → transcript → `pi.sendUserMessage`
3. **Phase 2** — Playback / polish
4. **Phase 3** — Conversational mode with `pi_turn` tool
5. **Phase 4** — Optional Codex app-server V3 bridge

## Next steps (general)

Good things to add next:

- realtime voice (see plan above)
- more tools (see `pi.registerTool` + `defineTool`)
- a `tool_call` gate that blocks dangerous commands
- a custom command (`pi.registerCommand`)
- persisted state via `pi.appendEntry`
- voice MVP slices #8–#12 (auth, realtime, capture, bridge, session)

See the upstream
[extension docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md)
and [examples](https://github.com/earendil-works/pi-coding-agent/tree/main/examples/extensions).
