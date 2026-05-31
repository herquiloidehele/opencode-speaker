import type { Runner } from "./runner.js"
import { PLUGIN_NAME } from "../config.js"
import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface PlayerOptions {
  platform?: NodeJS.Platform
  runner: Runner
}

export interface Player {
  init(): Promise<void>
  play(
    audio: Buffer | ReadableStream<Uint8Array>,
    contentType: string,
    signal: AbortSignal,
  ): Promise<void>
}

const LINUX_PLAYERS = ["paplay", "aplay", "ffplay"] as const

export function createPlayer(opts: PlayerOptions): Player {
  const platform = opts.platform ?? process.platform
  let binary: string | null = null

  async function buffer(stream: Buffer | ReadableStream<Uint8Array>): Promise<Buffer> {
    if (Buffer.isBuffer(stream)) return stream
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)))
  }

  async function writeTemp(buf: Buffer, contentType: string): Promise<{ dir: string; path: string }> {
    const ext = contentType.includes("mpeg")
      ? "mp3"
      : contentType.includes("wav")
        ? "wav"
        : "bin"
    const dir = await mkdtemp(join(tmpdir(), `${PLUGIN_NAME}-`))
    const path = join(dir, `audio.${ext}`)
    await writeFile(path, buf)
    return { dir, path }
  }

  function powershellEncodedCommand(path: string): string {
    const safePath = JSON.stringify(path.replace(/\\/g, "/"))
    const script = [
      "Add-Type -AssemblyName presentationCore",
      "$p = New-Object System.Windows.Media.MediaPlayer",
      `$p.Open([Uri]${safePath})`,
      "$p.Play()",
      "Start-Sleep -Seconds 30",
    ].join("; ")
    return Buffer.from(script, "utf16le").toString("base64")
  }

  return {
    async init() {
      if (platform === "darwin") {
        if (!(await opts.runner.has("afplay"))) {
          throw new Error("No audio player available (need `afplay`)")
        }
        binary = "afplay"
      } else if (platform === "linux") {
        for (const b of LINUX_PLAYERS) {
          if (await opts.runner.has(b)) {
            binary = b
            break
          }
        }
        if (!binary) {
          throw new Error(
            "No audio player available (need one of: paplay, aplay, ffplay)",
          )
        }
      } else if (platform === "win32") {
        if (!(await opts.runner.has("powershell"))) {
          throw new Error("No audio player available (need `powershell`)")
        }
        binary = "powershell"
      } else {
        throw new Error(`Unsupported platform for audio playback: ${platform}`)
      }
    },

    async play(audio, contentType, signal) {
      if (!binary) throw new Error("Audio player not initialized")
      if (signal.aborted) throw new DOMException("aborted", "AbortError")
      const buf = await buffer(audio)
      const tmp = await writeTemp(buf, contentType)
      let cmd: string[]
      if (binary === "powershell") {
        cmd = [
          "powershell",
          "-NoProfile",
          "-EncodedCommand",
          powershellEncodedCommand(tmp.path),
        ]
      } else if (binary === "ffplay") {
        cmd = ["ffplay", "-autoexit", "-nodisp", "-loglevel", "quiet", tmp.path]
      } else {
        cmd = [binary, tmp.path]
      }
      try {
        await opts.runner.run(cmd, signal)
      } finally {
        await rm(tmp.dir, { recursive: true, force: true })
      }
    },
  }
}
