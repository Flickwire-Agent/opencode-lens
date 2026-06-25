# OpenCode Web Voice Input

Voice input companion for the OpenCode web interface.

This repository contains two pieces:

- An OpenCode plugin package, `opencode-web-voice-input`, that can be loaded from `opencode.json`.
- A browser userscript/bookmarklet that adds a `Mic` button to the OpenCode Web prompt composer and inserts speech-to-text output into the prompt.

## Status

OpenCode's current plugin API does not expose a supported hook for injecting controls into the bundled web UI. This project addresses that with a reverse proxy that injects the voice button script directly into the OpenCode Web HTML — no userscript manager or bookmarklet needed. The plugin package remains useful as a normal OpenCode plugin dependency and gives this project a standard OpenCode installation shape.

Speech recognition uses the browser's Web Speech API. It works best in Chrome or Edge on `localhost` or HTTPS. Firefox does not currently support this API by default.

## Install The OpenCode Plugin

Clone and build this repository:

```bash
git clone git@github.com:Flickwire-Agent/opencode-web-voice-input.git
cd opencode-web-voice-input
pnpm install
pnpm build
```

Add the built plugin entry to your OpenCode config. For a global install, edit `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-web-voice-input/dist/index.js"]
}
```

Use the real absolute path on your machine. Then restart OpenCode. Config and plugin files are loaded at startup.

For a project-local install, you can use a relative path from that project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["../opencode-web-voice-input/dist/index.js"]
}
```

## Install The Web Voice Button

Choose one browser-side install method. The **auto-inject proxy** is recommended for zero-interaction setup.

### Auto-Inject Proxy (Recommended)

The proxy intercepts OpenCode Web HTTP responses and injects the voice button script directly into the DOM. The Mic button appears automatically — no bookmarklet, no userscript manager, no per-page clicks.

```bash
# Set OPENCODE_TARGET to your OpenCode Web URL (default: http://127.0.0.1:5050)
OPENCODE_TARGET="http://127.0.0.1:5050" pnpm proxy
```

Then open **http://127.0.0.1:3000** (or your `PORT`) in the browser instead of the direct OpenCode Web URL. Authenticate with your OpenCode Web credentials as usual.

Change the proxy port with `PORT=8080 pnpm proxy`.

### Userscript

1. Install a userscript manager such as Tampermonkey or Violentmonkey.
2. Add the built userscript (`dist/opencode-web-voice-input.user.js`) to your userscript manager.
3. Open the OpenCode Web tab and click `Mic` in the prompt composer.

### Bookmarklet

1. Open `dist/bookmarklet.txt`.
2. Create a browser bookmark whose URL is the full `javascript:...` content.
3. Open the OpenCode Web tab and click the bookmark once per page load.
4. Click `Mic` in the prompt composer.

## Build Locally

Requirements:

- Node.js 22 or newer
- pnpm 11.7.0 or newer

Commands:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Build output:

- `dist/index.js` - OpenCode plugin entry.
- `dist/index.d.ts` - plugin types.
- `dist/client.js` - browser companion script.
- `dist/opencode-web-voice-input.user.js` - userscript manager install file.
- `dist/bookmarklet.txt` - bookmarklet URL.

## OpenCode Web Usage

1. Start OpenCode Web:

```bash
opencode web
```

2. Start the auto-inject proxy (in a separate terminal):

```bash
OPENCODE_TARGET="http://127.0.0.1:5050" pnpm proxy
```

3. Open **http://127.0.0.1:3000** in your browser (the proxy URL, not the direct OpenCode Web URL).
4. Authenticate with your OpenCode Web credentials.
5. The `Mic` button appears automatically in the prompt composer.
6. Click `Mic`, approve the browser microphone permission, and speak your prompt.
7. Click `Stop` to insert the final transcript into the prompt editor.
8. Review and send the prompt normally.

## Troubleshooting

- If no `Mic` button appears, refresh OpenCode Web and run the bookmarklet again, or verify the userscript is enabled for `localhost`.
- If the browser blocks the microphone, use `http://localhost`, `http://127.0.0.1`, or HTTPS. Browser speech recognition generally requires a secure context.
- If speech recognition is unavailable, use Chrome or Edge.
- If text is inserted in the wrong place after OpenCode UI updates, open an issue with your OpenCode version and browser.

## Automation

GitHub Actions runs on pull requests and every push to `main`:

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm build`

Successful `main` builds upload the `dist/` directory as a workflow artifact.
