import { existsSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

const cwd = process.cwd();
const target = process.env.OPENCODE_TARGET || "http://127.0.0.1:5050";
const port = parseInt(process.env.PORT || "3000", 10);
const configPath = process.env.LENS_CONFIG || "lens.config.json";
const pluginSpecs = readPluginSpecs();
const injections = await Promise.all(pluginSpecs.map(loadPlugin));

if (injections.length === 0) {
  console.warn(
    "Lens started with no plugins. Set OPENCODE_WEB_PLUGINS or create lens.config.json.",
  );
}

const targetUrl = new URL(target);
const targetHost = targetUrl.hostname;
const targetPort = parseInt(targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80"), 10);
const INJECT_HEAD = "</head>";
const INJECT_BODY = "</body>";

const server = createServer((clientReq, clientRes) => {
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
        body = inject(body, injections.join("\n"));

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
  console.log(`Loaded ${injections.length} plugin${injections.length === 1 ? "" : "s"}.`);
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

async function loadPlugin(spec) {
  if (typeof spec === "string") {
    return spec.startsWith("http://") || spec.startsWith("https://")
      ? `<script type="module" src="${escapeAttribute(spec)}"></script>`
      : loadLocalPlugin(spec, cwd);
  }

  if (!spec || typeof spec !== "object") {
    throw new Error("Plugin entries must be strings or objects.");
  }

  if (spec.path) return loadLocalPlugin(spec.path, cwd);
  if (spec.url) return `<script type="module" src="${escapeAttribute(spec.url)}"></script>`;
  return pluginManifestToHtml(spec, cwd);
}

function loadLocalPlugin(path, baseDir) {
  const resolved = resolvePath(path, baseDir);
  const contents = readFileSync(resolved, "utf8");

  if (resolved.endsWith(".json")) {
    return pluginManifestToHtml(JSON.parse(contents), dirname(resolved));
  }

  return `<script type="module">\n${contents}\n</script>`;
}

function pluginManifestToHtml(plugin, baseDir) {
  const name = plugin.name || "unnamed plugin";
  const html = typeof plugin.html === "string" ? plugin.html : "";
  const script = plugin.script ? readFileSync(resolvePath(plugin.script, baseDir), "utf8") : "";

  return `<!-- Lens plugin: ${escapeComment(name)} -->\n${html}\n${script ? `<script type="module">\n${script}\n</script>` : ""}`;
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

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function escapeComment(value) {
  return String(value).replaceAll("--", "-");
}
