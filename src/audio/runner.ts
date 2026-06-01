/**
 * Shared `Runner` abstraction used by the audio player. A Runner knows how to:
 *   - probe the PATH for an executable
 *   - spawn a process with abort support
 *
 * The audio player uses this to invoke `afplay` / `paplay` / `aplay` /
 * `ffplay` / PowerShell to play the audio bytes returned by the TTS
 * provider. `src/index.ts` constructs one via `defaultRunner()` and hands
 * it to `createPlayer()`.
 */

export interface Runner {
  has(binary: string): Promise<boolean>
  run(cmd: string[], signal: AbortSignal): Promise<{ exitCode: number }>
}

/** Default runner: uses Node's child_process and PATH-based binary lookup. */
export async function defaultRunner(): Promise<Runner> {
  const { spawn } = await import("node:child_process")
  const { access, constants } = await import("node:fs/promises")
  const { delimiter, sep } = await import("node:path")

  async function has(binary: string): Promise<boolean> {
    const PATH = process.env.PATH ?? ""
    const exts =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
        : [""]
    for (const dir of PATH.split(delimiter)) {
      for (const ext of exts) {
        try {
          await access(`${dir}${sep}${binary}${ext}`, constants.X_OK)
          return true
        } catch {
          /* keep searching */
        }
      }
    }
    return false
  }

  const ABORT_KILL_MS = 1000

  async function run(cmd: string[], signal: AbortSignal): Promise<{ exitCode: number }> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError")
    return await new Promise((resolve, reject) => {
      const child = spawn(cmd[0], cmd.slice(1), { stdio: "ignore" })
      let killTimer: NodeJS.Timeout | undefined
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort)
        if (killTimer) clearTimeout(killTimer)
      }
      const onAbort = () => {
        child.kill("SIGTERM")
        killTimer = setTimeout(() => child.kill("SIGKILL"), ABORT_KILL_MS)
      }
      signal.addEventListener("abort", onAbort)
      child.on("error", (e) => {
        cleanup()
        reject(e)
      })
      child.on("exit", (code) => {
        cleanup()
        if (signal.aborted) reject(new DOMException("aborted", "AbortError"))
        else if ((code ?? 0) !== 0) reject(new Error(`process exited with code ${code ?? 0}`))
        else resolve({ exitCode: 0 })
      })
    })
  }

  return { has, run }
}
