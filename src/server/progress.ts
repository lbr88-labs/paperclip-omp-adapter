import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { parseOmpJsonLine } from "./parse.js";

type ProgressSink = NonNullable<AdapterExecutionContext["onRuntimeProgress"]>;
type EventSink = NonNullable<AdapterExecutionContext["onEvent"]>;

const PROGRESS_MIN_INTERVAL_MS = 1000;
const SNIPPET_CHARS = 200;
const HINT_CHARS = 120;
const MAX_TOOL_EVENTS = 200;

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
  ingest(line: string): Promise<void>;
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
  let lastAssistantSnippet: string | null = null;
  let streamedText = "";
  let streamedThinking = "";
  let toolEventCount = 0;
  let providerWorkSeen = false;
  const pendingTools = new Map<string, { toolName: string; hint: string; startedMs: number }>();

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
        lastAssistantSnippet,
        lastEventAt: new Date(now),
      });
    } catch {
      lastEmitMs = now;
    }
  };

  const publish = async (eventType: string, message: string, failed: boolean): Promise<void> => {
    if (!events) return;
    try {
      await events({ eventType, stream: "system", level: failed ? "error" : "info", message });
    } catch {
      toolEventCount = MAX_TOOL_EVENTS + 1;
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

  const ingest = async (line: string): Promise<void> => {
    const event = parseOmpJsonLine(line.trim());
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
        streamedText = "";
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
          streamedText = snippetOf(streamedText + delta);
          lastAssistantSnippet = streamedText;
          await emit("Writing response", false);
          return;
        }
        if (text(update.type) === "thinking_delta") {
          streamedThinking = snippetOf(streamedThinking + delta);
          lastAssistantSnippet = `Thinking: ${streamedThinking}`;
          await emit("Thinking", false);
        }
        return;
      }
      case "message_end":
      case "turn_end": {
        const message = record(event.message);
        if (!message || message.role !== "assistant") return;
        const body = snippetOf(assistantText(message.content));
        if (!body) return;
        streamedText = body;
        streamedThinking = "";
        lastAssistantSnippet = body;
        await emit("Writing response", true);
        return;
      }
      default:
        return;
    }
  };

  return {
    ingest,
    pendingToolCount: () => pendingTools.size,
    sawProviderWork: () => providerWorkSeen,
  };
}
