import type { Plugin } from "./plugin-types.js";

const plugin = (async ({ client, serverUrl }) => {
  await client.app.log({
    body: {
      service: "opencode-web-voice-input",
      level: "info",
      message:
        "Loaded. Run `pnpm proxy` to auto-inject voice input, or install the userscript/bookmarklet manually.",
    },
  });

  return {
    event: async ({ event }) => {
      if (event.type !== "server.connected") return;

      await client.app.log({
        body: {
          service: "opencode-web-voice-input",
          level: "info",
          message: `OpenCode Web connected at ${serverUrl.href}. Run 'pnpm proxy' (set OPENCODE_TARGET env) to auto-inject voice input, or use the userscript/bookmarklet.`,
        },
      });
    },
  };
}) satisfies Plugin;

export default plugin;
