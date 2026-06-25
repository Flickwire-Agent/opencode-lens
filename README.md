# Lens

Tiny plugin lens for OpenCode Web.

Lens is a local reverse proxy that sits in front of `opencode web`, loads small web plugins, and injects them into the OpenCode Web HTML response. It exists because OpenCode's plugin API does not currently expose supported hooks for changing the bundled web UI.

## Install

```bash
git clone git@github.com:Flickwire-Agent/opencode-lens.git
cd opencode-lens
pnpm install
```

Start OpenCode Web in one terminal:

```bash
opencode web
```

Start Lens in another terminal:

```bash
OPENCODE_TARGET="http://127.0.0.1:5050" pnpm proxy
```

Open `http://127.0.0.1:3000` instead of the direct OpenCode Web URL.

## Load Plugins

Use `OPENCODE_WEB_PLUGINS` for quick local installs:

```bash
OPENCODE_WEB_PLUGINS="../opencode-web-voice-plugin/dist/plugin.js" pnpm proxy
```

Or create `lens.config.json`:

```json
{
  "plugins": ["../opencode-web-voice-plugin/dist/plugin.js"]
}
```

Plugin entries can be local JavaScript files, remote JavaScript URLs, local JSON manifests, or inline manifest objects.

## Plugin Format

The minimal plugin is just browser JavaScript. Lens injects it as a module script.

```js
const badge = document.createElement("div");
badge.textContent = "Lens plugin loaded";
badge.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647";
document.body.appendChild(badge);
```

Save that as `plugin.js`, then run:

```bash
OPENCODE_WEB_PLUGINS="./plugin.js" pnpm proxy
```

For HTML injection with optional JavaScript, use a JSON manifest:

```json
{
  "name": "hello-html",
  "html": "<div id=\"hello-lens\">Hello from Lens</div>",
  "script": "./hello.js"
}
```

The `html` string is inserted before `</head>` when possible. The optional `script` path is resolved relative to the manifest file and injected as a module script.

## Environment

- `OPENCODE_TARGET` - direct OpenCode Web URL, defaults to `http://127.0.0.1:5050`.
- `PORT` - Lens proxy port, defaults to `3000`.
- `OPENCODE_WEB_PLUGINS` - comma-separated plugin paths or URLs.
- `LENS_CONFIG` - config file path, defaults to `lens.config.json`.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```
