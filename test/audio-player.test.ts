import { describe, it, expect } from "vitest"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createPlayer } from "../src/audio/player.js"

const fakeRunner = (hasBin: Record<string, boolean>, log: string[][], exitCode = 0) => ({
  has: async (b: string) => hasBin[b] ?? false,
  run: async (cmd: string[]) => {
    log.push(cmd)
    return { exitCode }
  },
})

describe("audio player", () => {
  it("uses afplay on macOS", async () => {
    const cmds: string[][] = []
    const p = createPlayer({ platform: "darwin", runner: fakeRunner({ afplay: true }, cmds) })
    await p.init()
    await p.play(Buffer.from("fake"), "audio/mpeg", new AbortController().signal)
    expect(cmds[0][0]).toBe("afplay")
  })

  it("prefers paplay over aplay over ffplay on linux", async () => {
    const cmds: string[][] = []
    const p = createPlayer({
      platform: "linux",
      runner: fakeRunner({ paplay: true, aplay: true, ffplay: true }, cmds),
    })
    await p.init()
    await p.play(Buffer.from("fake"), "audio/mpeg", new AbortController().signal)
    expect(cmds[0][0]).toBe("paplay")
  })

  it("falls through to ffplay when paplay/aplay missing", async () => {
    const cmds: string[][] = []
    const p = createPlayer({
      platform: "linux",
      runner: fakeRunner({ ffplay: true }, cmds),
    })
    await p.init()
    await p.play(Buffer.from("fake"), "audio/mpeg", new AbortController().signal)
    expect(cmds[0][0]).toBe("ffplay")
  })

  it("init throws when no player binary on the host", async () => {
    const p = createPlayer({ platform: "linux", runner: fakeRunner({}, []) })
    await expect(p.init()).rejects.toThrow(/no audio player/i)
  })

  it("uses powershell with encoded command on windows", async () => {
    const cmds: string[][] = []
    const p = createPlayer({
      platform: "win32",
      runner: fakeRunner({ powershell: true }, cmds),
    })
    await p.init()
    await p.play(Buffer.from("fake"), "audio/mpeg", new AbortController().signal)
    expect(cmds[0][0]).toBe("powershell")
    expect(cmds[0]).toContain("-EncodedCommand")
    expect(cmds[0].join(" ")).not.toContain("audio.mp3")
  })

  it("removes temporary audio directories after successful playback", async () => {
    const before = new Set(await readdir(tmpdir()))
    const cmds: string[][] = []
    const p = createPlayer({
      platform: "darwin",
      runner: fakeRunner({ afplay: true }, cmds),
    })

    await p.init()
    await p.play(Buffer.from("fake"), "audio/mpeg", new AbortController().signal)

    const after = await readdir(tmpdir())
    const leaked = after.filter(
      (name) => name.startsWith("opencode-speaker-") && !before.has(name),
    )
    expect(leaked).toEqual([])
  })

  it("removes temporary audio directories when playback fails", async () => {
    const before = new Set(await readdir(tmpdir()))
    const runner = {
      has: async (b: string) => b === "afplay",
      run: async () => {
        throw new Error("player failed")
      },
    }
    const p = createPlayer({ platform: "darwin", runner })

    await p.init()
    await expect(
      p.play(Buffer.from("fake"), "audio/mpeg", new AbortController().signal),
    ).rejects.toThrow("player failed")

    const after = await readdir(tmpdir())
    const leaked = after.filter(
      (name) => name.startsWith("opencode-speaker-") && !before.has(name),
    )
    expect(leaked).toEqual([])
  })

  it("aborts while buffering a stream", async () => {
    const cmds: string[][] = []
    const p = createPlayer({ platform: "darwin", runner: fakeRunner({ afplay: true }, cmds) })
    await p.init()
    const ac = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array([1, 2, 3]))
        ac.abort()
      },
    })

    await expect(p.play(stream, "audio/mpeg", ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(cmds).toEqual([])
  })

  it("rejects when the audio runner exits non-zero", async () => {
    const cmds: string[][] = []
    const p = createPlayer({
      platform: "darwin",
      runner: fakeRunner({ afplay: true }, cmds, 1),
    })
    await p.init()

    await expect(
      p.play(Buffer.from("fake"), "audio/mpeg", new AbortController().signal),
    ).rejects.toThrow("audio playback failed")
  })
})
