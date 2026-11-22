import { execFile, spawn, type SpawnOptions } from "node:child_process"
import { once } from "node:events"
import { createRequire } from "node:module"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { Clock, Context, Effect, Layer, Predicate, Schema, Semaphore } from "effect"
import WebSocket from "ws"
import { Usage } from "./usage.ts"

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string }

export type RequestId = typeof RequestId.Type
export const RequestId = Schema.Union([Schema.String, Schema.Number])

export class CommandMissingError extends Schema.TaggedError<CommandMissingError>()("CodexService.CommandMissingError", {
  message: Schema.String,
}) {}

export class ServerStartError extends Schema.TaggedError<ServerStartError>()("CodexService.ServerStartError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class TransportError extends Schema.TaggedError<TransportError>()("CodexService.TransportError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class RequestTimeoutError extends Schema.TaggedError<RequestTimeoutError>()("CodexService.RequestTimeoutError", {
  id: RequestId,
  method: Schema.String,
  timeoutMs: Schema.Number,
  message: Schema.String,
}) {}

export class ProtocolParseError extends Schema.TaggedError<ProtocolParseError>()("CodexService.ProtocolParseError", {
  message: Schema.String,
  line: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class ProtocolError extends Schema.TaggedError<ProtocolError>()("CodexService.ProtocolError", {
  message: Schema.String,
}) {}

export class InvalidPayloadError extends Schema.TaggedError<InvalidPayloadError>()("CodexService.InvalidPayloadError", {
  message: Schema.String,
}) {}

export type Error =
  | CommandMissingError
  | ServerStartError
  | TransportError
  | RequestTimeoutError
  | ProtocolParseError
  | ProtocolError
  | InvalidPayloadError

export interface Interface {
  readonly readUsage: () => Effect.Effect<Usage.CodexUsage, Error>
  readonly dispose: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("CodexService") {}

type CommandExists = (command: string) => boolean

interface CodexProcess {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly kill: () => unknown
  readonly once: {
    (event: "error", listener: (error: globalThis.Error) => void): unknown
    (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  }
}

type TransportProcess = CodexProcess & {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
}

type SpawnCodex = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => CodexProcess

export interface Options {
  readonly command?: string
  readonly commandExists?: CommandExists
  /** Resolves the shared Codex app-server daemon socket. Defaults to `codex app-server daemon start`. */
  readonly daemonSocket?: Effect.Effect<string, ServerStartError>
  readonly env?: Partial<NodeJS.ProcessEnv>
  readonly spawn?: SpawnCodex
  readonly timeoutMs?: number
}

interface PendingRequest {
  readonly method: string
  readonly resume: (effect: Effect.Effect<unknown, Error>) => void
  readonly timer: NodeJS.Timeout
}

interface Connection {
  readonly send: (text: string) => void
  readonly close: () => void
}

interface ConnectionEvents {
  readonly message: (text: string) => void
  readonly closed: (error: TransportError) => void
}

class ProtocolMessage extends Schema.Class<ProtocolMessage>("CodexService.ProtocolMessage")({
  id: Schema.optionalKey(RequestId),
  method: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  params: Schema.optionalKey(Schema.Unknown),
}) {}

const decodeProtocolMessage = Schema.decodeUnknownEffect(ProtocolMessage)
const decodeDaemonStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ socketPath: Schema.String })),
)

const MISSING_CODEX_MESSAGE =
  "Codex is not installed. Install the ChatGPT app or the Codex CLI, or set OPENCODE_CODEX_USAGE_COMMAND."
const DEFAULT_TIMEOUT_MS = 10_000
// The first `daemon start` copies the whole Codex package (~450 MB); killing it midway leaves a broken install.
const DAEMON_START_TIMEOUT_MS = 120_000
const CODEX_COMMAND_CANDIDATES = [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
]

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const command = options.command ?? resolveCodexCommand(options.commandExists, options.env)
      const spawnProcess = options.spawn ?? spawn
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const pending = new Map<RequestId, PendingRequest>()

      let transport: Connection | undefined
      let nextId = 1
      let initialized = false

      const context = yield* Effect.context()
      // Node callbacks below run outside Effect, so they need a runtime entrypoint that preserves this layer context.
      const runCallbackEffect = Effect.runForkWith(context)

      // Only one read should initialize or reconnect the Codex transport at a time.
      const mutex = yield* Semaphore.make(1)

      const rejectAll = (error: Error) =>
        Effect.sync(() => {
          for (const request of pending.values()) {
            clearTimeout(request.timer)
            request.resume(Effect.fail(error))
          }
          pending.clear()
        })

      const cleanupTransport = (expected?: Connection) =>
        Effect.sync(() => {
          const current = transport
          if (!current || (expected && current !== expected)) return
          // Detach first so close events from the old connection are ignored.
          transport = undefined
          initialized = false
          current.close()
        })

      const failTransport = (target: Connection, error: TransportError) =>
        Effect.gen(function* () {
          if (transport !== target) return
          yield* Effect.logWarning("server.closed", { error: error.message })
          yield* rejectAll(error)
          yield* cleanupTransport(target)
        })

      const writeProtocol = Effect.fn("CodexService.writeProtocol")(function* (target: Connection, payload: unknown) {
        if (transport !== target) return yield* new TransportError({ message: "Codex app-server transport is stale." })

        yield* Effect.try({
          try: () => target.send(JSON.stringify(payload)),
          catch: (cause) => new TransportError({ message: "Failed to write to Codex app-server.", cause }),
        })
      })

      const dispose = Effect.fn("CodexService.dispose")(function* () {
        yield* Effect.logDebug("client.dispose", { pending: pending.size, running: transport !== undefined })
        yield* rejectAll(new TransportError({ message: "Codex app-server stopped before pending requests completed." }))
        yield* cleanupTransport()
      })

      yield* Effect.logDebug("client.created", { command, timeoutMs })
      yield* Effect.addFinalizer(() => dispose())

      const connectStdio = Effect.fn("CodexService.connectStdio")(function* (
        command: string,
        events: ConnectionEvents,
      ) {
        const child = yield* Effect.try({
          try: () => spawnProcess(command, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] }),
          catch: (cause) => new ServerStartError({ message: "Failed to start Codex app-server.", cause }),
        })
        if (!isTransportProcess(child)) {
          child.kill()
          return yield* new TransportError({ message: "Codex app-server did not expose stdio." })
        }

        const lines = createInterface({ input: child.stdout })
        lines.on("line", events.message)
        child.once("error", (cause) =>
          events.closed(new TransportError({ message: "Codex app-server transport failed.", cause })),
        )
        child.stdin.on("error", (cause) =>
          events.closed(new TransportError({ message: "Codex app-server stdin failed.", cause })),
        )
        child.once("exit", (code, signal) =>
          events.closed(
            new TransportError({ message: `Codex app-server exited with ${signal ?? code ?? "unknown status"}.` }),
          ),
        )
        child.stderr.on("data", (chunk: Buffer | string) => {
          const message = chunk.toString().trim()
          if (message) runCallbackEffect(Effect.logWarning("server.stderr", { message: message.slice(0, 500) }))
        })

        return {
          send: (text: string) => child.stdin.write(`${text}\n`),
          close: () => {
            lines.close()
            child.kill()
          },
        }
      })

      const connectDaemon = Effect.fn("CodexService.connectDaemon")(function* (
        socketPath: string,
        events: ConnectionEvents,
      ) {
        // The daemon's control socket speaks JSON-RPC over WebSocket, one message per frame.
        const socket = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: timeoutMs })
        // Register before connecting: some runtimes emit `error` more than once, and an unhandled one throws.
        socket.on("message", (data) => events.message(data.toString()))
        socket.on("error", (cause) =>
          events.closed(new TransportError({ message: "Codex app-server daemon connection failed.", cause })),
        )
        socket.on("close", () =>
          events.closed(new TransportError({ message: "Codex app-server daemon closed the connection." })),
        )

        yield* Effect.tryPromise({
          try: () => once(socket, "open"),
          catch: (cause) => new TransportError({ message: "Failed to connect to the Codex app-server daemon.", cause }),
        }).pipe(Effect.onError(() => Effect.sync(() => socket.terminate())))

        return {
          send: (text: string) => socket.send(text),
          close: () => socket.close(),
        }
      })

      const connect = Effect.fn("CodexService.connect")(function* <E>(
        open: (events: ConnectionEvents) => Effect.Effect<Connection, E>,
      ) {
        let connection: Connection | undefined
        connection = yield* open({
          message: (text) => {
            const current = connection
            if (current && transport === current) runCallbackEffect(handleLine(current, text))
          },
          closed: (error) => {
            const current = connection
            if (current && transport === current) runCallbackEffect(failTransport(current, error))
          },
        })
        transport = connection
      })

      const send = Effect.fn("CodexService.send")(function* (method: string, params: unknown) {
        const current = transport
        if (!current) return yield* new TransportError({ message: "Codex app-server is not running." })

        const id = `opencode-codex-usage-plugin-${nextId++}`
        const payload = { id, method, params }
        yield* Effect.logDebug("protocol.send", { id, method })

        return yield* Effect.callback<unknown, Error>((resume) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            resume(
              Effect.logWarning("protocol.timeout", { id, method, timeoutMs }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new RequestTimeoutError({
                      id,
                      method,
                      timeoutMs,
                      message: `Timed out waiting for ${method}.`,
                    }),
                  ),
                ),
              ),
            )
          }, timeoutMs)

          pending.set(id, { method, resume, timer })
          runCallbackEffect(
            writeProtocol(current, payload).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  clearTimeout(timer)
                  pending.delete(id)
                  yield* failTransport(current, error)
                  resume(Effect.fail(error))
                }),
              ),
            ),
          )

          return Effect.sync(() => {
            clearTimeout(timer)
            pending.delete(id)
          })
        })
      })

      const start = Effect.fn("CodexService.start")(function* () {
        if (!command) {
          yield* Effect.logWarning("server.command.missing")
          return yield* new CommandMissingError({ message: MISSING_CODEX_MESSAGE })
        }

        // Prefer the shared daemon so every OpenCode window reuses one app-server; spawn a private one otherwise.
        yield* (options.daemonSocket ?? startDaemon(command)).pipe(
          Effect.flatMap((socketPath) => connect((events) => connectDaemon(socketPath, events))),
          Effect.catch((error) =>
            Effect.logWarning("server.daemon.unavailable", { error: error.message }).pipe(
              Effect.andThen(connect((events) => connectStdio(command, events))),
            ),
          ),
        )

        yield* send("initialize", {
          clientInfo: {
            name: "opencode-codex-usage-plugin",
            title: "OpenCode Codex Usage Plugin",
            version: packageJson.version,
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        })
        initialized = true
      })

      const readUsage = Effect.fn("CodexService.readUsage")(function* () {
        yield* Effect.logDebug("usage.read.start")
        yield* mutex.withPermit(
          Effect.gen(function* () {
            if (initialized && transport) return
            yield* start().pipe(Effect.onError(() => cleanupTransport()))
          }),
        )
        const response = yield* send("account/rateLimits/read", undefined).pipe(
          Effect.flatMap(Usage.decodeRateLimitsResponse),
          Effect.catchTag(
            "SchemaError",
            (error) => new InvalidPayloadError({ message: `Invalid Codex rate-limit payload: ${error.message}` }),
          ),
        )
        const usage = Usage.mapRateLimitsToUsage(response)
        yield* Effect.logDebug("usage.read.success", {
          fiveHour: usage.fiveHour?.usedPercent ?? null,
          weekly: usage.weekly?.usedPercent ?? null,
        })
        return usage
      })

      const handleLine = Effect.fn("CodexService.handleLine")(function* (source: Connection, line: string) {
        const trimmed = line.trim()
        if (!trimmed) return

        const message = yield* parseProtocolMessage(trimmed).pipe(
          Effect.catchTag("CodexService.ProtocolParseError", (error) =>
            Effect.logWarning("protocol.parse_error", { line: error.line, error: error.message }).pipe(Effect.asVoid),
          ),
        )
        if (!message) return
        if (transport !== source) return

        if (message.id === undefined) {
          yield* Effect.logDebug("protocol.notification", { method: message.method })
          return
        }

        if (message.method !== undefined && !Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) {
          yield* Effect.logDebug("protocol.server_request", { id: message.id, method: message.method })
          if (message.method === "currentTime/read") {
            const unixTimestampMs = yield* Clock.currentTimeMillis
            yield* Effect.logDebug("protocol.server_response", {
              id: message.id,
              method: message.method,
              action: "current_time",
            })
            yield* writeProtocol(source, { id: message.id, result: { unixTimestampMs } }).pipe(
              Effect.catch((error) => failTransport(source, error)),
            )
            return
          }

          yield* Effect.logWarning("protocol.server_response", {
            id: message.id,
            method: message.method,
            action: "unsupported",
          })
          yield* writeProtocol(source, {
            id: message.id,
            error: {
              message: `opencode-codex-usage-plugin does not support Codex app-server request ${message.method}.`,
            },
          }).pipe(Effect.catch((error) => failTransport(source, error)))
          return
        }

        const request = pending.get(message.id)
        if (!request) {
          yield* Effect.logWarning("protocol.unmatched_response", {
            id: message.id,
            hasError: Object.hasOwn(message, "error"),
          })
          return
        }

        pending.delete(message.id)
        clearTimeout(request.timer)
        yield* Effect.logDebug("protocol.response", { id: message.id, hasError: Object.hasOwn(message, "error") })

        if (Object.hasOwn(message, "error")) {
          request.resume(Effect.fail(new ProtocolError({ message: formatProtocolError(message.error) })))
          return
        }

        request.resume(Effect.succeed(Object.hasOwn(message, "result") ? message.result : message))
      })

      return Service.of({
        readUsage,
        dispose,
      })
    }),
  )

export function resolveCodexCommand(
  commandExists: CommandExists = commandAvailable,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): string | null {
  const configured = env.OPENCODE_CODEX_USAGE_COMMAND
  if (configured) return configured

  return CODEX_COMMAND_CANDIDATES.find(commandExists) ?? (commandExists("codex") ? "codex" : null)
}

function startDaemon(command: string): Effect.Effect<string, ServerStartError> {
  return Effect.callback<string, ServerStartError>((resume) => {
    execFile(command, ["app-server", "daemon", "start"], { timeout: DAEMON_START_TIMEOUT_MS }, (cause, stdout) => {
      resume(
        cause
          ? Effect.fail(new ServerStartError({ message: "Failed to start the Codex app-server daemon.", cause }))
          : decodeDaemonStatus(stdout).pipe(
              Effect.map((status) => status.socketPath),
              Effect.mapError(
                (cause) => new ServerStartError({ message: "Unexpected Codex app-server daemon status.", cause }),
              ),
            ),
      )
    })
  })
}

const parseProtocolMessage = Effect.fn("CodexService.parseProtocolMessage")(function* (line: string) {
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(line),
    catch: (cause) =>
      new ProtocolParseError({ message: "Invalid Codex protocol JSON.", line: line.slice(0, 200), cause }),
  })
  return yield* decodeProtocolMessage(parsed).pipe(
    Effect.catchTag(
      "SchemaError",
      (cause) => new ProtocolParseError({ message: cause.message, line: line.slice(0, 200), cause }),
    ),
  )
})

function isTransportProcess(process: CodexProcess): process is TransportProcess {
  return process.stdin !== null && process.stdout !== null && process.stderr !== null
}

function commandAvailable(command: string): boolean {
  if (command.includes("/")) return isExecutable(command)

  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => isExecutable(join(directory, command)))
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function formatProtocolError(error: unknown): string {
  if (typeof error === "string") return error
  if (Predicate.hasProperty(error, "message") && typeof error.message === "string") {
    return error.message
  }
  return "Codex app-server request failed."
}

export * as CodexService from "./codex.ts"
