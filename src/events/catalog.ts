import { Priority } from "../queue/types.js"

export type EventMode = "template" | "narrate" | "verbatim"
export type EventPriorityName = "urgent" | "normal" | "chatty"
export type Verbosity = "minimal" | "normal" | "verbose"

export interface EventSpec {
  mode: EventMode
  priority?: EventPriorityName
  queuePriority: Priority
  defaultEnabled: Record<Verbosity, boolean>
  synthetic?: true
  narrationOccasion?: string
}

const enabled = (normal: boolean, minimal = normal): Record<Verbosity, boolean> => ({
  minimal,
  normal,
  verbose: normal,
})

export const EVENT_SPECS = {
  "session.idle": { mode: "narrate", queuePriority: Priority.NORMAL, defaultEnabled: enabled(true, true) },
  "session.error": { mode: "template", priority: "urgent", queuePriority: Priority.URGENT, defaultEnabled: enabled(true, true) },
  "session.compacted": { mode: "template", queuePriority: Priority.NORMAL, defaultEnabled: enabled(true, false) },
  "session.created": { mode: "template", queuePriority: Priority.NORMAL, defaultEnabled: enabled(true, false) },
  "permission.asked": { mode: "template", priority: "urgent", queuePriority: Priority.URGENT, defaultEnabled: enabled(true, true) },
  "permission.replied": { mode: "template", queuePriority: Priority.NORMAL, defaultEnabled: enabled(true, false) },
  "tool.execute.before": { mode: "template", priority: "chatty", queuePriority: Priority.CHATTY, defaultEnabled: enabled(true, false) },
  "tool.execute.after": { mode: "template", priority: "chatty", queuePriority: Priority.CHATTY, defaultEnabled: enabled(true, false) },
  "file.edited": { mode: "template", priority: "chatty", queuePriority: Priority.CHATTY, defaultEnabled: enabled(true, false) },
  "command.executed": { mode: "template", queuePriority: Priority.NORMAL, defaultEnabled: enabled(true, false) },
  "message.updated": { mode: "verbatim", priority: "chatty", queuePriority: Priority.CHATTY, defaultEnabled: enabled(false, false) },
  "message.reasoning.delta": { mode: "verbatim", priority: "chatty", queuePriority: Priority.CHATTY, defaultEnabled: enabled(true, false), synthetic: true },
  "message.text.delta": { mode: "verbatim", priority: "chatty", queuePriority: Priority.CHATTY, defaultEnabled: enabled(false, false), synthetic: true },
  "todo.completed.item": { mode: "template", priority: "chatty", queuePriority: Priority.CHATTY, defaultEnabled: enabled(true, false), synthetic: true },
  "todo.completed.all": { mode: "narrate", queuePriority: Priority.NORMAL, defaultEnabled: enabled(true, true), synthetic: true, narrationOccasion: "The user has finished all todos." },
} as const satisfies Record<string, EventSpec>

export type EventType = keyof typeof EVENT_SPECS

export function defaultEventsForVerbosity(verbosity: Verbosity) {
  return Object.fromEntries(
    (Object.entries(EVENT_SPECS) as Array<[string, EventSpec]>).map(([type, spec]) => [
      type,
      {
        enabled: spec.defaultEnabled[verbosity],
        mode: spec.mode,
        ...(spec.priority ? { priority: spec.priority } : {}),
      },
    ]),
  )
}

export function queuePriorityForEvent(type: string): Priority {
  return EVENT_SPECS[type as EventType]?.queuePriority ?? Priority.NORMAL
}
