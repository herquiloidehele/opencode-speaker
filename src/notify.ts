import type { Logger } from "./log.js"

const TOAST_MAX_LEN = 200
const TOAST_PREFIX = "opencode-speaker: "
const TOAST_DEFER_MS = 2500
const TOAST_DURATION_MS = 10000

export type ToastVariant = "error" | "warning" | "info" | "success"

export interface NotifierClient {
  tui?: {
    showToast?: (req: {
      body: {
        message: string
        variant: ToastVariant
        duration?: number
      }
    }) => Promise<unknown>
  }
}

export interface Notifier {
  fatal(summary: string, detail?: unknown): void
  warn(summary: string, detail?: unknown): void
}

type NotifyLogger = Pick<Logger, "error" | "warn" | "info" | "debug">

function buildMessage(summary: string): string {
  const raw = TOAST_PREFIX + summary
  if (raw.length <= TOAST_MAX_LEN) return raw
  return raw.slice(0, TOAST_MAX_LEN - 1) + "…"
}

function publishToast(
  client: NotifierClient | undefined,
  message: string,
  variant: ToastVariant,
  logger: NotifyLogger,
): void {
  void logger.info("[diag] publishToast fired", { message, variant })
  // The SDK's showToast uses `this._client` internally. Calling it as a
  // detached function loses `this` and throws TypeError. We call it as a
  // method on `tui` to preserve the binding.
  const tui = client?.tui
  if (!tui || typeof tui.showToast !== "function") {
    void logger.info("[diag] toast surface unavailable", {
      message,
      clientShape: client ? Object.keys(client) : null,
      tuiShape: tui ? Object.keys(tui as object) : null,
    })
    return
  }
  try {
    const result = tui.showToast({
      body: { message, variant, duration: TOAST_DURATION_MS },
    })
    if (result && typeof (result as Promise<unknown>).then === "function") {
      ;(result as Promise<unknown>).then(
        (ok) => {
          void logger.info("[diag] toast surface result", { ok, message })
        },
        (error) => {
          void logger.info("[diag] toast surface failed", { error, message })
        },
      )
    } else {
      void logger.info("[diag] toast surface returned non-promise", {
        result: String(result),
      })
    }
  } catch (error) {
    void logger.info("[diag] toast surface threw", { error, message })
  }
}

function tryShowToast(
  client: NotifierClient | undefined,
  message: string,
  variant: ToastVariant,
  logger: NotifyLogger,
): void {
  // Defer to let the TUI subscribe to the event stream first. The plugin's
  // function may have already returned by the time this fires — that is fine,
  // since the host keeps the plugin's JS runtime alive for the session.
  setTimeout(() => publishToast(client, message, variant, logger), TOAST_DEFER_MS)
}

export function createNotifier(
  client: NotifierClient | undefined,
  logger: NotifyLogger,
): Notifier {
  return {
    fatal(summary, detail) {
      void logger.error(summary, detail)
      tryShowToast(client, buildMessage(summary), "error", logger)
    },
    warn(summary, detail) {
      void logger.warn(summary, detail)
      tryShowToast(client, buildMessage(summary), "warning", logger)
    },
  }
}
