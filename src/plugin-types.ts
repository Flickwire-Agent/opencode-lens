export type PluginContext = {
  client: {
    app: {
      log(input: {
        body: {
          service: string;
          level: "debug" | "info" | "warn" | "error";
          message: string;
        };
      }): Promise<void>;
    };
  };
};

export type PluginEvent = {
  event: {
    type: string;
  };
};

export type PluginHooks = {
  event?: (input: PluginEvent) => Promise<void> | void;
};

export type Plugin = (context: PluginContext) => Promise<PluginHooks> | PluginHooks;
