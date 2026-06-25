#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const cwd = process.cwd();
const target = process.env.OPENCODE_TARGET || "http://127.0.0.1:5050";
const port = parseInt(process.env.PORT || "3000", 10);
const configPath = process.env.LENS_CONFIG || "lens.config.json";
const statePath = process.env.LENS_STATE || ".lens-state.json";
const pluginSpecs = readPluginSpecs();
const plugins = pluginSpecs.map(normalizePluginSpec).map(loadPlugin);
const state = readState();

if (plugins.length === 0) {
  console.warn(
    "Lens started with no plugins. Set OPENCODE_WEB_PLUGINS or create lens.config.json.",
  );
}

const targetUrl = new URL(target);
const targetHost = targetUrl.hostname;
const targetPort = parseInt(targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80"), 10);
const INJECT_HEAD = "</head>";
const INJECT_BODY = "</body>";

const server = createServer(async (clientReq, clientRes) => {
  if (clientReq.url?.startsWith("/__lens/")) {
    await handleLensRequest(clientReq, clientRes);
    return;
  }

  const headers = { ...clientReq.headers };
  delete headers["accept-encoding"];
  delete headers.host;

  const proxyReq = request(
    {
      hostname: targetHost,
      port: targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers,
    },
    (proxyRes) => {
      const contentType = proxyRes.headers["content-type"] || "";
      const isHtml = String(contentType).includes("text/html");

      if (!isHtml || proxyRes.statusCode !== 200) {
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
        return;
      }

      let body = "";
      proxyRes.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      proxyRes.on("end", () => {
        body = inject(body, getEnabledInjections());

        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders["content-length"];
        delete responseHeaders["content-security-policy"];
        delete responseHeaders["content-security-policy-report-only"];
        responseHeaders["content-length"] = String(Buffer.byteLength(body, "utf8"));

        clientRes.writeHead(proxyRes.statusCode ?? 200, responseHeaders);
        clientRes.end(body);
      });
    },
  );

  proxyReq.on("error", () => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end("Lens proxy error");
    }
  });

  clientReq.pipe(proxyReq);
});

server.on("upgrade", (clientReq, clientSocket, clientHead) => {
  const proxySocket = connect(targetPort, targetHost, () => {
    const lines = [
      `${clientReq.method} ${clientReq.url} HTTP/${clientReq.httpVersion}`,
      ...Object.entries(clientReq.headers)
        .filter(([key]) => !["host", "connection"].includes(key.toLowerCase()))
        .map(([key, value]) => `${key}: ${value}`),
      "",
      "",
    ];

    proxySocket.write(lines.join("\r\n"));
    proxySocket.write(clientHead);

    clientSocket.pipe(proxySocket);
    proxySocket.pipe(clientSocket);
  });

  proxySocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => proxySocket.destroy());
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Lens ready: http://127.0.0.1:${port} -> ${target}`);
  console.log(`Registered ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}.`);
});

function readPluginSpecs() {
  const fromEnv = process.env.OPENCODE_WEB_PLUGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (fromEnv?.length) return fromEnv;

  const resolvedConfig = resolve(cwd, configPath);
  if (!existsSync(resolvedConfig)) return [];

  const config = JSON.parse(readFileSync(resolvedConfig, "utf8"));
  if (!Array.isArray(config.plugins)) {
    throw new Error(`${configPath} must contain a plugins array.`);
  }

  return config.plugins;
}

function normalizePluginSpec(spec) {
  if (typeof spec === "string") return { source: spec };

  if (!spec || typeof spec !== "object") {
    throw new Error("Plugin entries must be strings or objects.");
  }

  return { ...spec, source: spec.path || spec.url };
}

function loadPlugin(spec) {
  const loaded = spec.source
    ? spec.source.startsWith("http://") || spec.source.startsWith("https://")
      ? remotePlugin(spec)
      : loadLocalPlugin(spec.source, cwd)
    : manifestPlugin(spec, cwd);

  return {
    ...loaded,
    id: spec.id || loaded.id,
    name: spec.name || loaded.name,
    description: spec.description || loaded.description || "",
    enabledByDefault: spec.enabled !== false,
  };
}

function loadLocalPlugin(path, baseDir) {
  const resolved = resolvePath(path, baseDir);
  const contents = readFileSync(resolved, "utf8");

  if (resolved.endsWith(".json")) {
    return manifestPlugin(JSON.parse(contents), dirname(resolved), resolved);
  }

  return {
    id: slugify(path),
    name: readableName(path),
    description: "",
    source: path,
    html: `<script type="module">\n${contents}\n</script>`,
  };
}

function remotePlugin(plugin) {
  return {
    id: slugify(plugin.source),
    name: plugin.name || readableName(plugin.source),
    description: plugin.description || "",
    source: plugin.source,
    html: `<script type="module" src="${escapeAttribute(plugin.source)}"></script>`,
  };
}

function manifestPlugin(plugin, baseDir, source = "inline") {
  const name = plugin.name || readableName(source);
  const html = typeof plugin.html === "string" ? plugin.html : "";
  const script = plugin.script ? readFileSync(resolvePath(plugin.script, baseDir), "utf8") : "";

  return {
    id: plugin.id || slugify(name),
    name,
    description: plugin.description || "",
    source,
    html: `<!-- Lens plugin: ${escapeComment(name)} -->\n${html}\n${script ? `<script type="module">\n${script}\n</script>` : ""}`,
  };
}

function resolvePath(path, baseDir) {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function inject(body, injection) {
  if (!injection) return body;
  if (body.includes(INJECT_HEAD)) return body.replace(INJECT_HEAD, `${injection}${INJECT_HEAD}`);
  if (body.includes(INJECT_BODY)) return body.replace(INJECT_BODY, `${injection}${INJECT_BODY}`);
  return `${body}${injection}`;
}

function getEnabledInjections() {
  return [
    settingsPanelScript(),
    ...plugins.filter(isPluginEnabled).map((plugin) => plugin.html),
  ].join("\n");
}

function isPluginEnabled(plugin) {
  return state.plugins?.[plugin.id]?.enabled ?? plugin.enabledByDefault;
}

function readState() {
  const resolvedState = resolve(cwd, statePath);
  if (!existsSync(resolvedState)) return { plugins: {} };
  return JSON.parse(readFileSync(resolvedState, "utf8"));
}

function writeState() {
  writeFileSync(resolve(cwd, statePath), `${JSON.stringify(state, null, 2)}\n`);
}

async function handleLensRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (req.method === "GET" && url.pathname === "/__lens/plugins") {
    sendJson(res, {
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        source: plugin.source,
        enabled: isPluginEnabled(plugin),
      })),
    });
    return;
  }

  const toggleMatch = url.pathname.match(/^\/__lens\/plugins\/([^/]+)$/);
  if (req.method === "POST" && toggleMatch) {
    const body = await readRequestBody(req);
    const plugin = plugins.find((candidate) => candidate.id === decodeURIComponent(toggleMatch[1]));
    if (!plugin) {
      sendJson(res, { error: "Plugin not found" }, 404);
      return;
    }

    state.plugins ||= {};
    state.plugins[plugin.id] = { enabled: Boolean(JSON.parse(body || "{}").enabled) };
    writeState();
    sendJson(res, { ok: true });
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
}

function readRequestBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

function sendJson(res, body, status = 200) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(json, "utf8")),
  });
  res.end(json);
}

function settingsPanelScript() {
  return `<script type="module">\n${LENS_SETTINGS_CLIENT}\n</script>`;
}

function slugify(value) {
  return (
    String(value)
      .replace(/^https?:\/\//, "")
      .replace(/\.[cm]?js(on)?$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "plugin"
  );
}

function readableName(value) {
  const path = String(value);
  const file = basename(path).replace(/\.[cm]?js(on)?$/i, "");
  const parent = basename(dirname(path));
  const name = ["index", "plugin", "client"].includes(file)
    ? parent === "dist"
      ? basename(dirname(dirname(path)))
      : parent
    : file;
  return name || "Plugin";
}

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function escapeComment(value) {
  return String(value).replaceAll("--", "-");
}

const LENS_SETTINGS_CLIENT = `(${function lensSettingsClient() {
  const STATE_KEY = "__opencodeLensSettings";
  const lensWindow = window;

  lensWindow[STATE_KEY]?.cleanup?.();

  const observer = new MutationObserver(attachLensSettings);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  attachLensSettings();

  lensWindow[STATE_KEY] = {
    cleanup() {
      observer.disconnect();
      document.querySelectorAll("[data-lens-settings]").forEach((element) => element.remove());
    },
  };

  function attachLensSettings() {
    const modal = findSettingsModal();
    if (!modal) return;

    const sidebar = findSettingsSidebar(modal);
    const content = findSettingsContent(modal, sidebar);
    if (!sidebar || !content) return;

    if (!modal.querySelector('[data-lens-settings="category"]')) {
      insertLensCategory(sidebar, createLensCategory(sidebar, content));
    }

    if (content.querySelector('[data-lens-settings="panel"]')) return;

    const section = document.createElement("section");
    section.dataset.lensSettings = "panel";
    section.hidden = true;
    section.tabIndex = -1;
    section.innerHTML = `
    <style>
      [data-lens-settings="category"] {
        margin-top: 0;
      }
      [data-lens-settings="category-label"] {
        pointer-events: none;
      }
      [data-lens-settings="nav"] {
        cursor: pointer;
      }
      [data-lens-settings="panel"] {
        display: grid;
        gap: 14px;
      }
      [data-lens-settings="panel"][hidden] {
        display: none !important;
      }
      [data-lens-settings="header"] {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      [data-lens-settings="title"] {
        margin: 0;
        font: 600 18px/1.2 system-ui, sans-serif;
      }
      [data-lens-settings="hint"] {
        margin: 0;
        color: color-mix(in srgb, currentColor 68%, transparent);
        font: 12px/1.4 system-ui, sans-serif;
      }
      [data-lens-settings="list"] {
        display: grid;
        gap: 8px;
      }
      [data-lens-settings="plugin"] {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        border-radius: 10px;
        padding: 10px 12px;
      }
      [data-lens-settings="plugin-copy"] {
        display: grid;
        min-width: 0;
      }
      [data-lens-settings="plugin-name"] {
        font: 500 13px/1.3 system-ui, sans-serif;
      }
      [data-lens-settings="plugin-source"] {
        max-width: 42ch;
        overflow: hidden;
        color: color-mix(in srgb, currentColor 58%, transparent);
        font: 11px/1.3 ui-monospace, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [data-lens-settings="plugin-description"] {
        margin-top: 3px;
        color: color-mix(in srgb, currentColor 68%, transparent);
        font: 12px/1.35 system-ui, sans-serif;
      }
      [data-lens-settings="toggle"] {
        position: relative;
        display: inline-flex;
        width: 38px;
        height: 22px;
        flex: 0 0 auto;
        align-items: center;
      }
      [data-lens-settings="toggle"] input {
        position: absolute;
        inset: 0;
        margin: 0;
        opacity: 0;
        cursor: pointer;
      }
      [data-lens-settings="toggle-track"] {
        width: 100%;
        height: 100%;
        border-radius: 999px;
        background: color-mix(in srgb, currentColor 18%, transparent);
        transition: background 120ms ease;
      }
      [data-lens-settings="toggle-track"]::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 999px;
        background: canvas;
        box-shadow: 0 1px 3px rgb(0 0 0 / 25%);
        transition: transform 120ms ease;
      }
      [data-lens-settings="toggle"] input:checked + [data-lens-settings="toggle-track"] {
        background: #22c55e;
      }
      [data-lens-settings="toggle"] input:checked + [data-lens-settings="toggle-track"]::after {
        transform: translateX(16px);
      }
      [data-lens-settings="reload"] {
        border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
        border-radius: 999px;
        padding: 6px 10px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: 12px/1 system-ui, sans-serif;
      }
    </style>
    <div data-lens-settings="header">
      <h2 data-lens-settings="title">Plugins</h2>
      <button type="button" data-lens-settings="reload">Reload UI</button>
    </div>
    <p data-lens-settings="hint">Enable or disable plugins, then reload OpenCode Web to apply the current set.</p>
    <div data-lens-settings="list">Loading plugins...</div>
  `;

    content.appendChild(section);
    section
      .querySelector('[data-lens-settings="reload"]')
      ?.addEventListener("click", () => location.reload());

    sidebar.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof Element && event.target.closest('[data-lens-settings="nav"]')) {
          return;
        }

        restoreSettingsPanel(content);
        setLensSelected(sidebar, false);
      },
      true,
    );

    modal.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof Element && event.target.closest("[data-lens-settings]")) {
          return;
        }

        restoreSettingsPanel(content);
        setLensSelected(sidebar, false);
      },
      true,
    );

    renderPluginList(section);
  }

  function findSettingsModal() {
    const candidates = Array.from(
      document.querySelectorAll('dialog,[role="dialog"],[data-state="open"],.modal'),
    );
    return candidates.find((candidate) => {
      const text = candidate.textContent || "";
      return /General/i.test(text) && /Shortcuts/i.test(text) && /Providers/i.test(text);
    });
  }

  function findSettingsSidebar(modal) {
    const buttons = ["General", "Shortcuts", "Servers", "Providers", "Models"].map((label) =>
      findButtonByText(modal, label),
    );
    if (buttons.some((button) => !button)) return;

    let current = buttons[0].parentElement;
    while (current && current !== modal) {
      if (buttons.every((button) => current.contains(button))) {
        const rect = current.getBoundingClientRect();
        const modalRect = modal.getBoundingClientRect();
        if (rect.width < modalRect.width * 0.6) return current;
      }
      current = current.parentElement;
    }
  }

  function findSettingsContent(modal, sidebar) {
    if (!sidebar) return;

    const sidebarRect = sidebar?.getBoundingClientRect();
    const candidates = Array.from(modal.querySelectorAll("div,main,section")).filter(
      (candidate) => !sidebar.contains(candidate) && !candidate.contains(sidebar),
    );

    return candidates
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const text = candidate.textContent || "";
        return (
          rect.left >= sidebarRect.right - 2 &&
          rect.width > sidebarRect.width * 0.8 &&
          rect.height > sidebarRect.height * 0.45 &&
          !/Desktop\s+General\s+Shortcuts/i.test(text)
        );
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.left - bRect.left || bRect.width * bRect.height - aRect.width * aRect.height;
      })[0];
  }

  function createLensCategory(sidebar, content) {
    const category = cloneCategoryContainer(sidebar);
    category.dataset.lensSettings = "category";

    const label = cloneCategoryLabel(sidebar);
    label.dataset.lensSettings = "category-label";
    label.textContent = "Lens";

    const button = cloneNavButton(sidebar);
    button.type = "button";
    button.dataset.lensSettings = "nav";
    button.textContent = "Plugins";
    replaceButtonLabel(button, "Plugins");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentModal = findSettingsModal();
      const currentSidebar = currentModal ? findSettingsSidebar(currentModal) : sidebar;
      const currentContent = currentModal
        ? findSettingsContent(currentModal, currentSidebar)
        : content;
      if (!currentSidebar || !currentContent) return;

      ensureLensPanel(currentContent);
      showLensPanel(currentSidebar, currentContent, button);
    });

    category.append(label, button);
    return category;
  }

  function insertLensCategory(sidebar, category) {
    const footer = Array.from(sidebar.children).find((candidate) =>
      /OpenCode Desktop/i.test(candidate.textContent || ""),
    );

    sidebar.insertBefore(category, footer || null);
  }

  function cloneCategoryContainer(sidebar) {
    const serverLabel = Array.from(sidebar.querySelectorAll("div,span,p,h2,h3,h4")).find(
      (candidate) => /^(Server|Desktop)$/i.test((candidate.textContent || "").trim()),
    );
    const container = serverLabel?.parentElement?.cloneNode(false);
    return container instanceof HTMLElement ? container : document.createElement("div");
  }

  function cloneCategoryLabel(sidebar) {
    const match = Array.from(sidebar.querySelectorAll("div,span,p,h2,h3,h4")).find((candidate) =>
      /^(Server|Desktop)$/i.test((candidate.textContent || "").trim()),
    );
    return match ? match.cloneNode(false) : document.createElement("div");
  }

  function cloneNavButton(sidebar) {
    const buttons = Array.from(sidebar.querySelectorAll("button"));
    const match =
      buttons.find(
        (candidate) =>
          /General|Shortcuts|Servers|Providers|Models/i.test(candidate.textContent || "") &&
          !isSelectedButton(candidate),
      ) ||
      buttons.find((candidate) =>
        /General|Shortcuts|Servers|Providers|Models/i.test(candidate.textContent || ""),
      );
    const button = match ? match.cloneNode(true) : document.createElement("button");
    if (button instanceof HTMLElement) {
      button.dataset.lensInactiveClass = button.className;
    }
    return button;
  }

  function replaceButtonLabel(button, label) {
    const textNodes = [];
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const current = textNodes.reverse().find((node) => (node.textContent || "").trim().length > 0);
    if (current) {
      current.textContent = label;
      return;
    }

    button.textContent = label;
  }

  function showLensPanel(sidebar, content, button) {
    const panel = ensureLensPanel(content);
    if (!panel) return;

    syncNativeSelection(sidebar, button);

    Array.from(content.children).forEach((child) => {
      if (child === panel) return;
      if (child.dataset.lensPreviousDisplay === undefined) {
        child.dataset.lensPreviousDisplay = child.style.display;
      }
      child.style.display = "none";
    });

    panel.hidden = false;
    button.setAttribute("aria-current", "page");
    button.setAttribute("aria-selected", "true");
    panel.focus({ preventScroll: true });
  }

  function ensureLensPanel(content) {
    let panel = content.querySelector('[data-lens-settings="panel"]');
    if (panel) return panel;

    panel = document.querySelector('[data-lens-settings="panel"]');
    if (panel) {
      content.appendChild(panel);
      return panel;
    }

    return createLensPanel(content);
  }

  function createLensPanel(content) {
    const section = document.createElement("section");
    section.dataset.lensSettings = "panel";
    section.hidden = true;
    section.tabIndex = -1;
    section.innerHTML = `
    <style>
      [data-lens-settings="category"] {
        margin-top: 0;
      }
      [data-lens-settings="category-label"] {
        pointer-events: none;
      }
      [data-lens-settings="nav"] {
        cursor: pointer;
      }
      [data-lens-settings="panel"] {
        display: grid;
        gap: 14px;
      }
      [data-lens-settings="panel"][hidden] {
        display: none !important;
      }
      [data-lens-settings="header"] {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      [data-lens-settings="title"] {
        margin: 0;
        font: 600 18px/1.2 system-ui, sans-serif;
      }
      [data-lens-settings="hint"] {
        margin: 0;
        color: color-mix(in srgb, currentColor 68%, transparent);
        font: 12px/1.4 system-ui, sans-serif;
      }
      [data-lens-settings="list"] {
        display: grid;
        gap: 8px;
      }
      [data-lens-settings="plugin"] {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        border-radius: 10px;
        padding: 10px 12px;
      }
      [data-lens-settings="plugin-copy"] {
        display: grid;
        min-width: 0;
      }
      [data-lens-settings="plugin-name"] {
        font: 500 13px/1.3 system-ui, sans-serif;
      }
      [data-lens-settings="plugin-source"] {
        max-width: 42ch;
        overflow: hidden;
        color: color-mix(in srgb, currentColor 58%, transparent);
        font: 11px/1.3 ui-monospace, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [data-lens-settings="plugin-description"] {
        margin-top: 3px;
        color: color-mix(in srgb, currentColor 68%, transparent);
        font: 12px/1.35 system-ui, sans-serif;
      }
      [data-lens-settings="toggle"] {
        position: relative;
        display: inline-flex;
        width: 38px;
        height: 22px;
        flex: 0 0 auto;
        align-items: center;
      }
      [data-lens-settings="toggle"] input {
        position: absolute;
        inset: 0;
        margin: 0;
        opacity: 0;
        cursor: pointer;
      }
      [data-lens-settings="toggle-track"] {
        width: 100%;
        height: 100%;
        border-radius: 999px;
        background: color-mix(in srgb, currentColor 18%, transparent);
        transition: background 120ms ease;
      }
      [data-lens-settings="toggle-track"]::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 999px;
        background: canvas;
        box-shadow: 0 1px 3px rgb(0 0 0 / 25%);
        transition: transform 120ms ease;
      }
      [data-lens-settings="toggle"] input:checked + [data-lens-settings="toggle-track"] {
        background: #22c55e;
      }
      [data-lens-settings="toggle"] input:checked + [data-lens-settings="toggle-track"]::after {
        transform: translateX(16px);
      }
      [data-lens-settings="reload"] {
        border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
        border-radius: 999px;
        padding: 6px 10px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: 12px/1 system-ui, sans-serif;
      }
    </style>
    <div data-lens-settings="header">
      <h2 data-lens-settings="title">Plugins</h2>
      <button type="button" data-lens-settings="reload">Reload UI</button>
    </div>
    <p data-lens-settings="hint">Enable or disable plugins, then reload OpenCode Web to apply the current set.</p>
    <div data-lens-settings="list">Loading plugins...</div>
  `;

    content.appendChild(section);
    section
      .querySelector('[data-lens-settings="reload"]')
      ?.addEventListener("click", () => location.reload());
    renderPluginList(section);
    return section;
  }

  function restoreSettingsPanel(content) {
    const panel = content.querySelector('[data-lens-settings="panel"]');
    if (panel) panel.hidden = true;

    Array.from(content.children).forEach((child) => {
      if (child === panel) return;
      if (child.dataset.lensPreviousDisplay !== undefined) {
        child.style.display = child.dataset.lensPreviousDisplay;
        delete child.dataset.lensPreviousDisplay;
      }
    });
  }

  function syncNativeSelection(sidebar, lensButton) {
    const active = Array.from(sidebar.querySelectorAll("button")).find(
      (button) => button !== lensButton && isSelectedButton(button),
    );
    const inactive = Array.from(sidebar.querySelectorAll("button")).find(
      (button) => button !== lensButton && !isSelectedButton(button),
    );

    if (active instanceof HTMLElement) {
      lensButton.className = active.className;
      lensButton.dataset.lensActiveClass = active.className;
      active.removeAttribute("aria-current");
      active.setAttribute("aria-selected", "false");
    }

    if (inactive instanceof HTMLElement) {
      for (const button of sidebar.querySelectorAll("button")) {
        if (button !== lensButton && isSelectedButton(button)) {
          button.className = inactive.className;
        }
      }
    }
  }

  function setLensSelected(sidebar, selected) {
    const button = sidebar.querySelector('[data-lens-settings="nav"]');
    if (!(button instanceof HTMLElement)) return;

    if (selected) {
      button.setAttribute("aria-current", "page");
      button.setAttribute("aria-selected", "true");
      return;
    }

    button.removeAttribute("aria-current");
    button.setAttribute("aria-selected", "false");
    if (button.dataset.lensInactiveClass !== undefined) {
      button.className = button.dataset.lensInactiveClass;
    }
  }

  function isSelectedButton(button) {
    return (
      button.getAttribute("aria-current") === "page" ||
      button.getAttribute("aria-selected") === "true" ||
      button.matches('[data-selected="true"],[data-active="true"]') ||
      hasActiveVisual(button)
    );
  }

  function hasActiveVisual(button) {
    const background = getComputedStyle(button).backgroundColor;
    return Boolean(background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)");
  }

  function findButtonByText(root, text) {
    return Array.from(root.querySelectorAll("button")).find(
      (button) => (button.textContent || "").trim() === text,
    );
  }

  async function renderPluginList(section) {
    const list = section.querySelector('[data-lens-settings="list"]');
    if (!list) return;

    try {
      const response = await fetch("/__lens/plugins");
      const data = await response.json();
      list.textContent = "";

      if (!data.plugins?.length) {
        list.textContent = "No plugins are registered with Lens.";
        return;
      }

      for (const plugin of data.plugins) {
        const row = document.createElement("label");
        row.dataset.lensSettings = "plugin";
        row.innerHTML = `
        <span data-lens-settings="plugin-copy">
          <span data-lens-settings="plugin-name"></span>
          <span data-lens-settings="plugin-description"></span>
          <span data-lens-settings="plugin-source"></span>
        </span>
        <span data-lens-settings="toggle">
          <input type="checkbox" role="switch" />
          <span data-lens-settings="toggle-track"></span>
        </span>
      `;
        row.querySelector('[data-lens-settings="plugin-name"]').textContent = plugin.name;
        row.querySelector('[data-lens-settings="plugin-description"]').textContent =
          plugin.description || "No description provided.";
        row.querySelector('[data-lens-settings="plugin-source"]').textContent =
          plugin.source || plugin.id;

        const checkbox = row.querySelector("input");
        checkbox.checked = plugin.enabled;
        checkbox.addEventListener("change", async () => {
          checkbox.disabled = true;
          await fetch("/__lens/plugins/" + encodeURIComponent(plugin.id), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: checkbox.checked }),
          });
          location.reload();
        });

        list.appendChild(row);
      }
    } catch (error) {
      list.textContent = "Lens settings failed to load.";
      console.error(error);
    }
  }
}.toString()})();`;
