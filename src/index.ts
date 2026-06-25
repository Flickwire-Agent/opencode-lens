import type { Plugin } from "./plugin-types.js";

const plugin = (async ({ client }) => {
  await client.app.log({
    body: {
      service: "opencode-web-voice-input",
      level: "info",
      message:
        "Loaded. Install the browser userscript or bookmarklet to add the mic button to OpenCode Web.",
    },
  });

  return {
    event: async ({ event }) => {
      if (event.type !== "server.connected") return;

      await client.app.log({
        body: {
          service: "opencode-web-voice-input",
          level: "info",
          message:
            "OpenCode Web connected. Browser-side voice input is provided by dist/opencode-web-voice-input.user.js or dist/bookmarklet.txt.",
        },
      });
    },
  };
}) satisfies Plugin;

export default plugin;
