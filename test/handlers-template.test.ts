import { describe, it, expect } from "vitest"
import { renderTemplate, stripMarkdown, truncate } from "../src/handlers/template.js"
import { normalizeEvent } from "../src/events/normalize.js"

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

  it("formats permission.asked from a real OpenCode v2 payload", () => {
    const raw = {
      type: "permission.asked",
      properties: {
        id: "p1",
        sessionID: "s1",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
        tool: { messageID: "m1", callID: "c1" },
      },
    }
    expect(renderTemplate(normalizeEvent(raw))).toBe(
      "I need your approval before I use bash.",
    )
  })

  it("falls back when tool is a non-string object and no friendly name is available", () => {
    expect(
      renderTemplate({ type: "permission.asked", tool: { messageID: "m", callID: "c" } }),
    ).toBe("I need your approval before I use an operation.")
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

  it("treats v2 permission.replied replies (`once` / `always` / `reject`) correctly", () => {
    // v2 SDK uses reply: "once" | "always" | "reject"; normalize maps that
    // into `decision`. "once" and "always" are forms of approval.
    expect(
      renderTemplate(
        normalizeEvent({
          type: "permission.replied",
          properties: { sessionID: "s", requestID: "r", reply: "once" },
        }),
      ),
    ).toBe("I got approval to use the operation.")
    expect(
      renderTemplate(
        normalizeEvent({
          type: "permission.replied",
          properties: { sessionID: "s", requestID: "r", reply: "always" },
        }),
      ),
    ).toBe("I got approval to use the operation.")
    expect(
      renderTemplate(
        normalizeEvent({
          type: "permission.replied",
          properties: { sessionID: "s", requestID: "r", reply: "reject" },
        }),
      ),
    ).toBe("I was denied permission to use the operation.")
  })

  it("aliases v1 permission.updated to permission.asked and pulls the tool name", () => {
    // v1 SDK: EventPermissionUpdated.properties is a Permission whose own
    // `type` field carries the action (e.g. "bash"). normalize lifts that
    // out before the spread would clobber it.
    expect(
      renderTemplate(
        normalizeEvent({
          type: "permission.updated",
          properties: {
            id: "p",
            type: "bash",
            sessionID: "s",
            messageID: "m",
            title: "Run a shell command",
            metadata: {},
            time: { created: 0 },
          },
        }),
      ),
    ).toBe("I need your approval before I use bash.")
  })

  it("aliases v2 session.next.tool.called to tool.execute.before", () => {
    expect(
      renderTemplate(
        normalizeEvent({
          type: "session.next.tool.called",
          properties: {
            timestamp: 0,
            sessionID: "s",
            callID: "c",
            tool: "bash",
            input: {},
            provider: { executed: true },
          },
        }),
      ),
    ).toBe("I'm running bash now.")
  })

  it("aliases v2 session.next.tool.success / failed to tool.execute.after", () => {
    // success/failed don't carry a tool name themselves; the dispatcher
    // resolves it from the callID it saw in the matching `.called`. Without
    // that bridge the template falls back to the generic line, which is the
    // safe behavior under direct renderTemplate calls.
    expect(
      renderTemplate(
        normalizeEvent({
          type: "session.next.tool.success",
          properties: {
            timestamp: 0,
            sessionID: "s",
            callID: "c",
            structured: {},
            content: [],
            provider: { executed: true },
          },
        }),
      ),
    ).toBe("I finished running tool.")
  })

  it("extracts session.error message from nested error.data.message", () => {
    // Real shape: properties.error.data.message — NOT properties.message.
    expect(
      renderTemplate(
        normalizeEvent({
          type: "session.error",
          properties: {
            sessionID: "s",
            error: { name: "UnknownError", data: { message: "Model overloaded" } },
          },
        }),
      ),
    ).toBe("I hit a session error: Model overloaded. Check the log for details.")
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

  it("has no template for message.updated (live text uses synthesized deltas)", () => {
    // message.updated's real payload is { sessionID, info: Message } with the
    // text living in info.parts — not at the top level. Streaming text is
    // surfaced via message.text.delta instead, so this event renders null.
    expect(
      renderTemplate({ type: "message.updated", text: "**Bold** and `code` text" }),
    ).toBeNull()
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
