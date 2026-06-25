import { mkdir, readFile, writeFile } from "node:fs/promises";

const client = await readFile(new URL("../dist/client.js", import.meta.url), "utf8");
const dist = new URL("../dist/", import.meta.url);

await mkdir(dist, { recursive: true });

await writeFile(
  new URL("opencode-web-voice-input.user.js", dist),
  `// ==UserScript==
// @name         OpenCode Web Voice Input
// @namespace    https://github.com/Flickwire-Agent/opencode-web-voice-input
// @version      0.1.0
// @description  Adds a Web Speech API microphone button to the OpenCode web prompt composer.
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @match        http://*.local:*/*
// @match        https://app.opencode.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

${client}
`,
);

await writeFile(new URL("bookmarklet.txt", dist), `javascript:${encodeURIComponent(client)}`);
