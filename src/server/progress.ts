import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { parseOmpJsonLine } from "./parse.js";

type ProgressSink = NonNullable<AdapterExecutionContext["onRuntimeProgress"]>;
type EventSink = NonNullable<AdapterExecutionContext["onEvent"]>;

const PROGRESS_MIN_INTERVAL_MS = 1000;
const SNIPPET_CHARS = 200;
const HINT_CHARS = 120;
const THINKING_CHARS = 500;
const THINKING_BUFFER_CHARS = 4000;
const SNIPPET_BUFFER_CHARS = 1000;
const MAX_TOOL_EVENTS = 200;
const MAX_THINKING_EVENTS = 40;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function snippetOf(value: string): string {
  const normalized = collapse(value);
  return normalized.length > SNIPPET_CHARS ? normalized.slice(-SNIPPET_CHARS) : normalized;
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    const block = record(item);
    if (block?.type === "text") out += text(block.text);
  }
  return out;
}

function argumentHint(args: unknown, intent: unknown): string {
  const values = record(args) ?? {};
  const display = record(values.display);
  const hint = collapse(text(display?.name))
    || collapse(text(values.i))
    || collapse(text(intent))
    || collapse(text(values.cmd))
    || collapse(text(values.command))
    || collapse(text(values.path))
    || collapse(text(values.file_path))
    || collapse(text(values.pattern))
    || collapse(text(values.query));
  return hint.length > HINT_CHARS ? `${hint.slice(0, HINT_CHARS)}…` : hint;
}

function seconds(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

export interface OmpStreamReporter {
  ingest(line: string, parsedEvent?: Record<string, unknown> | null): Promise<void>;
  /** Publish the thinking segment left buffered when the stream ends without a closing event. */
  flush(): Promise<void>;
  /** Tool calls that started and never reported an end. */
  pendingToolCount(): number;
  /** True once OMP emitted assistant output or a tool call. */
  sawProviderWork(): boolean;
}

/** Feed OMP stdout lines to Paperclip's live status, durable run events, and recovery evidence. */
export function createOmpProgressReporter(
  sink: ProgressSink | undefined,
  events: EventSink | undefined,
): OmpStreamReporter {

  let lastEmitMs = 0;
  let currentToolName: string | null = null;
  let snippetKind: "none" | "text" | "thinking" | "final" = "none";
  let finalSnippet: string | null = null;
  let streamedText = "";
  let streamedThinking = "";
  let thinkingSegment = "";
  let thinkingDropped = false;
  let toolEventCount = 0;
  let thinkingEventCount = 0;
  let eventsBroken = false;
  let providerWorkSeen = false;
  const pendingTools = new Map<string, { toolName: string; hint: string; startedMs: number }>();

  const snippetValue = (): string | null => {
    if (snippetKind === "text") return snippetOf(streamedText) || null;
    if (snippetKind === "thinking") return `Thinking: ${snippetOf(streamedThinking)}`;
    return finalSnippet;
  };

  const emit = async (message: string, force: boolean): Promise<void> => {
    if (!sink) return;
    const now = Date.now();
    if (!force && now - lastEmitMs < PROGRESS_MIN_INTERVAL_MS) return;
    lastEmitMs = now;
    try {
      await sink({
        phase: "adapter_startup",
        message,
        currentToolName,
        lastAssistantSnippet: snippetValue(),
        lastEventAt: new Date(now),
      });
    } catch {
      lastEmitMs = now;
    }
  };

  const publish = async (eventType: string, message: string, failed: boolean): Promise<void> => {
    if (!events || eventsBroken) return;
    try {
      await events({ eventType, stream: "system", level: failed ? "error" : "info", message });
    } catch {
      eventsBroken = true;
    }
  };

  const publishTool = async (message: string, failed: boolean): Promise<void> => {
    if (toolEventCount > MAX_TOOL_EVENTS) return;
    toolEventCount += 1;
    if (toolEventCount > MAX_TOOL_EVENTS) {
      await publish("omp.tool", `Tool event limit reached after ${MAX_TOOL_EVENTS} calls; later calls stay in the run log.`, false);
      return;
    }
    await publish("omp.tool", message, failed);
  };

  const flushThinking = async (): Promise<void> => {
    const body = collapse(thinkingSegment);
    const dropped = thinkingDropped;
    thinkingSegment = "";
    thinkingDropped = false;
    if (!body) return;
    if (thinkingEventCount > MAX_THINKING_EVENTS) return;
    thinkingEventCount += 1;
    if (thinkingEventCount > MAX_THINKING_EVENTS) {
      await publish("omp.thinking", `Thinking event limit reached after ${MAX_THINKING_EVENTS} segments; later reasoning stays in the run log.`, false);
      return;
    }
    const cut = dropped || body.length > THINKING_CHARS;
    await publish("omp.thinking", cut ? `${body.slice(0, THINKING_CHARS)}…` : body, false);
  };

  const ingest = async (line: string, parsedEvent?: Record<string, unknown> | null): Promise<void> => {
    const event = parsedEvent === undefined ? parseOmpJsonLine(line.trim()) : parsedEvent;
    if (!event) return;

    switch (text(event.type)) {
      case "tool_execution_start": {
        const toolName = text(event.toolName).trim();
        if (!toolName) return;
        const toolCallId = text(event.toolCallId).trim();
        const hint = argumentHint(event.args, event.intent);
        if (toolCallId) pendingTools.set(toolCallId, { toolName, hint, startedMs: Date.now() });
        currentToolName = toolName;
        providerWorkSeen = true;
        if (snippetKind === "text") {
          finalSnippet = snippetOf(streamedText) || finalSnippet;
          snippetKind = "final";
        }
        streamedText = "";
        await flushThinking();
        await emit(`Running ${toolName}`, true);
        return;
      }
      case "tool_execution_end": {
        const toolCallId = text(event.toolCallId).trim();
        const started = toolCallId ? pendingTools.get(toolCallId) : undefined;
        if (toolCallId) pendingTools.delete(toolCallId);
        const toolName = text(event.toolName).trim() || started?.toolName || currentToolName || "tool";
        const failed = event.isError === true;
        const hint = started?.hint ?? argumentHint(event.args, event.intent);
        const duration = started ? ` in ${seconds(Date.now() - started.startedMs)}` : "";
        currentToolName = null;
        await emit(`Finished ${toolName}`, true);
        await publishTool(
          `${toolName} ${failed ? "failed" : "ok"}${duration}${hint ? ` — ${hint}` : ""}`,
          failed,
        );
        return;
      }
      case "message_update": {
        const update = record(event.assistantMessageEvent);
        if (!update) return;
        const delta = text(update.delta);
        if (!delta) return;
        providerWorkSeen = true;
        if (text(update.type) === "text_delta") {
          await flushThinking();
          streamedText = (streamedText + delta).slice(-SNIPPET_BUFFER_CHARS);
          snippetKind = "text";
          await emit("Writing response", false);
          return;
        }
        if (text(update.type) === "thinking_delta") {
          const merged = thinkingSegment + delta;
          thinkingSegment = merged.slice(0, THINKING_BUFFER_CHARS);
          if (merged.length > THINKING_BUFFER_CHARS) thinkingDropped = true;
          streamedThinking = (streamedThinking + delta).slice(-SNIPPET_BUFFER_CHARS);
          snippetKind = "thinking";
          await emit("Thinking", false);
        }
        return;
      }
      case "message_end":
      case "turn_end": {
        await flushThinking();
        const message = record(event.message);
        if (!message || message.role !== "assistant") return;
        const body = assistantText(message.content);
        const snippet = snippetOf(body);
        if (!snippet) return;
        streamedText = body.slice(-SNIPPET_BUFFER_CHARS);
        streamedThinking = "";
        finalSnippet = snippet;
        snippetKind = "final";
        await emit("Writing response", true);
        return;
      }
      default:
        return;
    }
  };

  return {
    ingest,
    flush: flushThinking,
    pendingToolCount: () => pendingTools.size,
    sawProviderWork: () => providerWorkSeen,
  };
}
