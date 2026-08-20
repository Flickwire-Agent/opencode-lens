import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const proxyPath = resolve("scripts/lens-proxy.mjs");

test("rewritten HTML does not retain chunked transfer encoding", async (t) => {
  const upstream = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.write("<html><head>");
    response.end("</head><body>ok</body></html>");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());

  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const lensPort = await unusedPort();
  const lens = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      LENS_CONFIG: "missing-lens-config.json",
      OPENCODE_TARGET: `http://127.0.0.1:${upstreamAddress.port}`,
      PORT: String(lensPort),
    },
  });
  t.after(() => lens.kill());
  await waitForOutput(lens, "Lens ready:");

  const response = await request(lensPort);
  assert.equal(response.headers["transfer-encoding"], undefined);
  assert.equal(
    response.headers["content-length"],
    String(Buffer.byteLength(response.body, "utf8")),
  );
  assert.match(response.body, /data-lens-settings/);
});

test("rewritten HTML preserves UTF-8 characters split across upstream chunks", async (t) => {
  const body = Buffer.from("<html><head></head><body>snowman: \u2603</body></html>", "utf8");
  const splitAt = Buffer.from("<html><head></head><body>snowman: ", "utf8").length + 1;
  const upstream = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.write(body.subarray(0, splitAt));
    response.end(body.subarray(splitAt));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());

  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const lensPort = await unusedPort();
  const lens = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      LENS_CONFIG: "missing-lens-config.json",
      OPENCODE_TARGET: `http://127.0.0.1:${upstreamAddress.port}`,
      PORT: String(lensPort),
    },
  });
  t.after(() => lens.kill());
  await waitForOutput(lens, "Lens ready:");

  const response = await request(lensPort);
  assert.match(response.body, /snowman: \u2603/);
});

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const { port } = address;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function waitForOutput(child, expected) {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Lens did not start: ${output}`)), 5_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Lens exited before starting (${code}): ${output}`));
    });
  });
}

function request(port) {
  return new Promise((resolveResponse, reject) => {
    get(`http://127.0.0.1:${port}/`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolveResponse({ headers: response.headers, body }));
    }).on("error", reject);
  });
}
