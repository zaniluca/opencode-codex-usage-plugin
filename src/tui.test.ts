import { describe, expect, it } from "@effect/vitest"
import { isOpenAISession } from "./tui.js"

describe("isOpenAISession", () => {
  it("uses the selected model before an assistant response exists", () => {
    expect(isOpenAISession(context([], "openai"), "session-1")).toBe(true)
  })

  it("uses the latest assistant provider", () => {
    const messages = [
      { type: "assistant", model: { providerID: "openai" } },
      { type: "assistant", model: { providerID: "anthropic" } },
    ]

    expect(isOpenAISession(context(messages, "openai"), "session-1")).toBe(false)
  })

  it("ignores sessions without an OpenAI model", () => {
    expect(isOpenAISession(context([], "anthropic"), "session-1")).toBe(false)
  })
})

function context(messages: ReadonlyArray<unknown>, providerID: string) {
  return {
    data: {
      session: {
        message: {
          list: () => [...messages],
        },
        get: () => ({ model: { providerID } }),
      },
    },
  }
}
