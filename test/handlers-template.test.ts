import { describe, it, expect } from "vitest"
import { renderTemplate, stripMarkdown, truncate } from "../src/handlers/template.js"

describe("renderTemplate", () => {
  it("formats session.error", () => {
    expect(renderTemplate({ type: "session.error", message: "Model overloaded" })).toBe(
      "I hit a session error: Model overloaded. Check the log for details.",
    )
  })

  it("truncates long error messages", () => {
    const longMsg = "x".repeat(500)
    const out = renderTemplate({ type: "session.error", message: longMsg })
    // 200 char cap on message + fixed prefix/suffix (~50 chars).
    expect(out!.length).toBeLessThanOrEqual(260)
    expect(out).toMatch(/^I hit a session error: x+…\. Check the log for details\.$/)
  })

  it("formats permission.asked", () => {
    expect(renderTemplate({ type: "permission.asked", tool: "write" })).toBe(
      "I need your approval before I use write.",
    )
  })

  it("formats permission.replied with normalized decisions", () => {
    expect(
      renderTemplate({ type: "permission.replied", tool: "write", decision: "allow" }),
    ).toBe("I got approval to use write.")
    expect(
      renderTemplate({ type: "permission.replied", tool: "bash", decision: "deny" }),
    ).toBe("I was denied permission to use bash.")
    expect(renderTemplate({ type: "permission.replied" })).toBe(
      "I got a response for the operation.",
    )
  })

  it("formats session.compacted", () => {
    expect(renderTemplate({ type: "session.compacted" })).toBe(
      "I compacted the session, so older context is summarized and I have more room to continue.",
    )
  })

  it("formats session.created", () => {
    expect(renderTemplate({ type: "session.created" })).toBe(
      "I'm starting a new session and getting ready to work.",
    )
    expect(renderTemplate({ type: "session.created", title: "Refactor auth" })).toBe(
      "I'm starting a new session and getting ready to work.",
    )
  })

  it("formats tool.execute.before / .after", () => {
    expect(renderTemplate({ type: "tool.execute.before", tool: "bash" })).toBe("I'm running bash now.")
    expect(renderTemplate({ type: "tool.execute.after", tool: "bash" })).toBe("I finished running bash.")
  })

  it("formats file.edited using just the basename", () => {
    expect(
      renderTemplate({ type: "file.edited", file: "/repo/src/index.ts" }),
    ).toBe("I edited index.ts.")
    expect(renderTemplate({ type: "file.edited", file: "/tmp/example.ts" })).toBe(
      "I edited example.ts.",
    )
    expect(renderTemplate({ type: "file.edited" })).toBe("I edited a file.")
  })

  it("formats command.executed", () => {
    expect(renderTemplate({ type: "command.executed", command: "/init" })).toBe(
      "I ran /init.",
    )
    expect(renderTemplate({ type: "command.executed" })).toBe("I ran a command.")
  })

  it("formats todo.completed.item with content", () => {
    expect(
      renderTemplate({ type: "todo.completed.item", content: "Add login route" }),
    ).toBe("I finished this task: Add login route.")
  })

  it("formats todo.completed.all with optional count", () => {
    expect(renderTemplate({ type: "todo.completed.all" })).toBe(
      "I've completed all todos. Nice work.",
    )
    expect(renderTemplate({ type: "todo.completed.all", count: 3 })).toBe(
      "I've completed all 3 todos. Nice work.",
    )
  })

  it("returns null for unknown event types", () => {
    expect(renderTemplate({ type: "unknown.event" })).toBeNull()
  })

  it("formats message.updated with stripped markdown", () => {
    expect(
      renderTemplate({ type: "message.updated", text: "**Bold** and `code` text" }),
    ).toBe("Bold and code text")
  })

  it("has no template for the raw message.part.updated event", () => {
    expect(renderTemplate({ type: "message.part.updated" })).toBeNull()
  })

  it("formats session.idle with a chatty fallback line", () => {
    expect(renderTemplate({ type: "session.idle" })).toBe(
      "I'm idle now and waiting for your next instruction.",
    )
  })

  it("renders synthesized streaming deltas verbatim (after markdown strip)", () => {
    expect(
      renderTemplate({
        type: "message.reasoning.delta",
        text: "Let me **think** about this.",
      }),
    ).toBe("Let me think about this.")
    expect(
      renderTemplate({
        type: "message.text.delta",
        text: "Here is the *answer*",
      }),
    ).toBe("Here is the answer")
  })
})

describe("stripMarkdown", () => {
  it("removes bold, italic, code, links", () => {
    expect(stripMarkdown("**hi**")).toBe("hi")
    expect(stripMarkdown("_x_")).toBe("x")
    expect(stripMarkdown("`code`")).toBe("code")
    expect(stripMarkdown("[label](http://x)")).toBe("label")
    expect(stripMarkdown("# Heading")).toBe("Heading")
  })
})

describe("truncate", () => {
  it("returns the string when shorter than limit", () => {
    expect(truncate("short", 10)).toBe("short")
  })
  it("truncates and appends ellipsis", () => {
    expect(truncate("a".repeat(20), 10)).toBe("aaaaaaaaaa…")
  })
})
