import { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  setProp,
  useTerminalDimensions,
} from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { Effect, ManagedRuntime, Option, Predicate, Schema } from "effect"
import { CodexService } from "./codex.ts"
import { Usage } from "./usage.js"

type UsageState =
  | { status: "loading"; usage: null; message: string }
  | { status: "ready"; usage: Usage.CodexUsage; message: string }
  | { status: "error"; usage: null; message: string }

type TuiTheme = Plugin.Context["theme"]
type TuiColor = TuiTheme["text"]["base"]
type Runtime = ReturnType<typeof createRuntime>

interface SessionDataContext {
  readonly data: {
    readonly session: {
      readonly message: {
        readonly list: (sessionID: string) => ReadonlyArray<unknown>
      }
      readonly get: (sessionID: string) => { readonly model?: { readonly providerID: string } } | undefined
    }
  }
}

class AssistantProviderMessage extends Schema.Class<AssistantProviderMessage>("Tui.AssistantProviderMessage")({
  type: Schema.Literal("assistant"),
  model: Schema.Struct({ providerID: Schema.String }),
}) {}

const decodeAssistantProviderMessage = Schema.decodeUnknownOption(AssistantProviderMessage)

const POLL_MS = 60_000
const UI_TIMEOUT_MS = 15_000

type ViewProps = {
  api: Plugin.Context
  sessionID: string | undefined
  runtime: Runtime
  onMissingCodex: () => void
}

function View(props: ViewProps) {
  const theme = () => props.api.theme
  const { state, isOpenAI } = createUsagePolling(props)

  const root = createElement("box")

  insert(root, () => (isOpenAI() ? UsageBlock({ state, theme }) : null), null)

  return root
}

function CompactView(props: ViewProps) {
  const dimensions = useTerminalDimensions()
  const theme = () => props.api.theme
  const sidebarHidden = createMemo(() => !isSidebarVisible(props.api, props.sessionID, dimensions().width))
  const { state, isOpenAI } = createUsagePolling({
    api: props.api,
    get sessionID() {
      return props.sessionID
    },
    runtime: props.runtime,
    onMissingCodex: props.onMissingCodex,
    enabled: sidebarHidden,
  })
  const root = createElement("box")

  insert(root, () => (isOpenAI() && sidebarHidden() ? CompactUsageLine({ state, theme }) : null), null)

  return root
}

function createUsagePolling(props: {
  api: Plugin.Context
  sessionID: string | undefined
  runtime: Runtime
  onMissingCodex: () => void
  enabled?: () => boolean
}) {
  const [state, setState] = createSignal<UsageState>({
    status: "loading",
    usage: null,
    message: "Loading usage...",
  })

  const isOpenAI = createMemo(() => isOpenAISession(props.api, props.sessionID))
  const enabled = props.enabled ?? (() => true)

  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let refreshAgain = false

  const refresh = () => {
    if (inFlight) {
      refreshAgain = true
      return inFlight
    }

    inFlight = runRefresh().finally(() => {
      inFlight = undefined
      if (refreshAgain && !disposed) {
        refreshAgain = false
        void refresh()
      }
    })

    return inFlight
  }

  const runRefresh = async () => {
    if (!enabled()) return

    if (!isOpenAI()) return

    const startedAt = Date.now()
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      if (disposed || state().status !== "loading") return
      warn(props.runtime, "tui.refresh.ui_timeout", { sessionID: props.sessionID, timeoutMs: UI_TIMEOUT_MS })
      setState({
        status: "error",
        usage: null,
        message: "Codex usage refresh timed out.",
      })
      props.api.renderer.requestRender()
    }, UI_TIMEOUT_MS)

    try {
      const usage = await props.runtime.runPromise(
        Effect.gen(function* () {
          const codex = yield* CodexService.Service
          return yield* codex.readUsage()
        }),
      )
      if (disposed) return
      if (timeout) clearTimeout(timeout)
      setState({ status: "ready", usage, message: "Usage loaded" })
      props.api.renderer.requestRender()
    } catch (error) {
      if (disposed) return
      if (timeout) clearTimeout(timeout)
      if (Predicate.isTagged(error, "CodexService.CommandMissingError")) props.onMissingCodex()
      warn(props.runtime, "tui.refresh.error", {
        sessionID: props.sessionID,
        ms: Date.now() - startedAt,
        error: errorMessage(error),
      })
      setState({
        status: "error",
        usage: null,
        message: errorMessage(error),
      })
      props.api.renderer.requestRender()
    }
  }

  createEffect(() => {
    if (enabled()) untrack(() => void refresh())
  })
  timer = setInterval(() => void refresh(), POLL_MS)
  const unsubscribeMessage = props.api.data.on("session.execution.succeeded", () => void refresh())
  const unsubscribeSession = props.api.data.on("session.model.selected", () => void refresh())

  onCleanup(() => {
    disposed = true
    unsubscribeMessage()
    unsubscribeSession()
    if (timer) clearInterval(timer)
    if (timeout) clearTimeout(timeout)
  })

  return { state, isOpenAI }
}

function UsageBlock(props: { state: () => UsageState; theme: () => TuiTheme }) {
  const root = createElement("box")
  const title = createElement("text")
  const bold = createElement("b")

  insertNode(root, title)
  insertNode(title, bold)
  insertNode(bold, createTextNode("Codex Usage"))
  effect(() => setProp(title, "fg", props.theme().text.base))

  insert(
    root,
    () => {
      const state = props.state()

      switch (state.status) {
        case "ready":
          return UsageLines(
            state.usage,
            () => props.theme().text.muted,
            () => props.theme().text.feedback.warning.base,
          )
        case "error":
          return textLine(
            () => props.state().message,
            () => props.theme().text.feedback.warning.base,
          )
        case "loading":
          return textLine(
            () => "Loading...",
            () => props.theme().text.muted,
          )
      }
    },
    null,
  )

  return root
}

function textLine(text: () => string, color: () => TuiColor) {
  const line = createElement("text")

  insert(line, text)
  effect(() => setProp(line, "fg", color()))

  return line
}

function UsageLines(usage: Usage.CodexUsage, color: () => TuiColor, warningColor: () => TuiColor) {
  const lines = Usage.formatUsageLines(usage)
  if (lines.length === 0) return textLine(() => "Usage unavailable", warningColor)

  return lines.map((line) => textLine(() => line, color))
}

function CompactUsageLine(props: { state: () => UsageState; theme: () => TuiTheme }) {
  return textLine(
    () => compactUsageText(props.state()),
    () => props.theme().text.muted,
  )
}

function compactUsageText(state: UsageState) {
  switch (state.status) {
    case "ready":
      return Usage.formatCompactUsage(state.usage) ?? ""
    case "error":
      return ""
    case "loading":
      return "5h ..."
  }
}

export function isOpenAISession(api: SessionDataContext, sessionID?: string): boolean {
  if (!sessionID) return false
  const messages = api.data.session.message.list(sessionID)
  const lastProviderID = [...messages].reverse().map(readAssistantProviderID).find(Boolean)

  if (lastProviderID) return lastProviderID === "openai"

  return api.data.session.get(sessionID)?.model?.providerID === "openai"
}

function readAssistantProviderID(message: unknown): string | undefined {
  return Option.getOrUndefined(decodeAssistantProviderMessage(message))?.model.providerID
}

function isSidebarVisible(api: Plugin.Context, sessionID: string | undefined, width: number): boolean {
  if (!sessionID || api.data.session.get(sessionID)?.parentID) return false
  return width > 120
}

function createRuntime() {
  return ManagedRuntime.make(CodexService.layer())
}

function warn(runtime: Runtime, message: string, extra: Record<string, unknown> = {}) {
  void runtime.runPromise(Effect.logWarning(message, extra)).catch(() => undefined)
}

function errorMessage(error: unknown): string {
  if (Predicate.isError(error)) return error.message
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) {
    return error.message
  }
  return "Usage unavailable"
}

const plugin = Plugin.define({
  id: "opencode-codex-usage",
  setup: (api) => {
    const runtime = createRuntime()
    let warnedMissingCodex = false

    const warnMissingCodex = () => {
      if (warnedMissingCodex) return
      warnedMissingCodex = true
      api.ui.toast.show({
        variant: "warning",
        title: "Codex required",
        message: "Install the ChatGPT app or the Codex CLI to see usage stats.",
      })
    }

    // OpenTUI's runtime primitives return renderables, while the slot API is typed through Solid's JSX facade.
    const mount = (component: (props: ViewProps) => unknown) => (props: { readonly sessionID?: string }) =>
      createComponent(component, {
        api,
        get sessionID() {
          return props.sessionID
        },
        runtime,
        onMissingCodex: warnMissingCodex,
      }) as unknown as JSX.Element

    const disposeSidebar = api.ui.slot({ append: "sidebar.content", render: mount(View) })
    const disposeStatus = api.ui.slot({ append: "prompt.footer.status", render: mount(CompactView) })

    return async () => {
      disposeStatus()
      disposeSidebar()
      await runtime.dispose()
    }
  },
})

export default plugin
