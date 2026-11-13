import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { usageHostContract } from "./lib/host-contract";
import { runShellCommand } from "./lib/host-shell";

export default experimental_defineHostEntry({
  contract: usageHostContract,
  handlers: {
    run: (input, context) => runShellCommand(input.command, {
      tempDir: context.experimental_paths.tempDir,
      signal: context.signal,
    }),
  },
});
