import { Plugin } from "@opencode-ai/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "opencode-codex-usage",
  tui: true,
  effect: () => Effect.void,
})
