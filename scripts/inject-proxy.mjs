import { createServer } from "node:http";
import { request } from "node:http";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const clientScript = readFileSync(resolve(__dirname, "../dist/client.js"), "utf8");
const injection = `<script type="module">${clientScript}</script>`;

const target = process.env.OPENCODE_TARGET || "http://127.0.0.1:5050";
const port = parseInt(process.env.PORT || "3000", 10);

const targetUrl = new URL(target);
const targetHost = targetUrl.hostname;
const targetPort = parseInt(targetUrl.port || "80", 10);

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
      const isHtml = contentType.includes("text/html");

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
        if (body.includes(INJECT_HEAD)) {
          body = body.replace(INJECT_HEAD, `${injection}${INJECT_HEAD}`);
        } else if (body.includes(INJECT_BODY)) {
          body = body.replace(INJECT_BODY, `${injection}${INJECT_BODY}`);
        } else {
          body += injection;
        }

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
      clientRes.end("Proxy error");
    }
  });

  clientReq.pipe(proxyReq);
});

server.on("upgrade", (clientReq, clientSocket, clientHead) => {
  const proxySocket = connect(targetPort, targetHost, () => {
    const lines = [
      `${clientReq.method} ${clientReq.url} HTTP/${clientReq.httpVersion}`,
      ...Object.entries(clientReq.headers)
        .filter(([k]) => !["host", "connection"].includes(k.toLowerCase()))
        .map(([k, v]) => `${k}: ${v}`),
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
  console.log(`Voice input proxy ready: http://127.0.0.1:${port} → ${target}`);
  console.log("Open this URL in your browser to use OpenCode Web with voice input.");
});
