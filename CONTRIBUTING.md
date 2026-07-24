# Contributing to pi-live

Thanks for your interest in contributing! This is a live playground for
[pi](https://github.com/earendil-works/pi-coding-agent), so contributions of all
sizes are welcome — bug reports, ideas, extension examples, and improvements to
the docs and CI.

## Getting started

```bash
git clone https://github.com/BlockedPath/pi-live.git
cd pi-live
```

The repo's extension skeleton lives under [`extensions/pi-live/`](extensions/pi-live).
To develop against it locally:

```bash
cd extensions/pi-live
npm install
npm run typecheck
```

## Ways to contribute

- **Report a bug** — open an issue using the *Bug report* template.
- **Suggest a feature** — open an issue using the *Feature request* template.
- **Improve an extension** — submit a pull request. See the extension's
  [`README.md`](extensions/pi-live/README.md) for the local development loop.
- **Docs / CI** — small fixes to `README.md`, `CONTRIBUTING.md`, or the GitHub
  Actions workflow are always appreciated.

## Development workflow

1. Fork the repo and create a branch off `main`:

   ```bash
   git switch -c my-change
   ```

2. Make your changes. Keep commits focused.
3. Make sure checks pass locally:

   ```bash
   cd extensions/pi-live && npm run typecheck
   ```

4. Commit using a clear message, e.g.:

   ```
   Add greeting tool to pi-live extension
   ```

5. Push and open a pull request against `main`. Fill in the PR template.

## Pull request expectations

- One logical change per PR.
- Include a short description of *what* changed and *why*.
- New tools/events should include a short usage note in the extension README.
- Don't commit generated files (`node_modules/`, `dist/`). They're gitignored.

## Code style

The extension is TypeScript, loaded by pi via [jiti](https://github.com/unjs/jiti)
so no compilation is needed at runtime. Follow the existing style in
[`src/index.ts`](extensions/pi-live/src/index.ts):

- Use `defineTool` and `ExtensionAPI` from `@earendil-works/pi-coding-agent`.
- Use `Type` from `@earendil-works/pi-ai` (or `typebox`) for tool parameter schemas.
- Tabs for indentation in the extension source (matches the pi examples).

## Issues

Search existing issues before opening a new one. Add as much context as the
issue template asks for — reproduction steps and expected/actual behavior help a
lot.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
