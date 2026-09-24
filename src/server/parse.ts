import { repairRedactedJsonLine } from "./redaction-repair.js";

export interface ParsedOmpToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown | null;
  isError: boolean;
}

export interface ParsedOmpOutput {
  sessionId: string | null;
  messages: string[];
  finalMessage: string | null;
  errors: string[];
  provider: string | null;
  model: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  costUsd: number;
  toolCalls: ParsedOmpToolCall[];
  /** Truncated sample of malformed lines and event types this adapter does not interpret. */
  unknownLines: string[];
}

const UNKNOWN_LINE_LIMIT = 50;
const UNKNOWN_LINE_CHARS = 200;

type JsonObject = Record<string, unknown>;
type UsageTotals = ParsedOmpOutput["usage"] & { costUsd: number };

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content) {
    const block = object(item);
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

function usageFromMessage(message: JsonObject): UsageTotals | null {
  const usage = object(message.usage);
  if (!usage) return null;
  const cost = object(usage.cost);
  return {
    inputTokens: number(usage.inputTokens ?? usage.input),
    outputTokens: number(usage.outputTokens ?? usage.output),
    cachedInputTokens: number(usage.cachedInputTokens ?? usage.cacheRead),
    costUsd: number(usage.costUsd ?? cost?.total),
  };
}

function addUsage(target: UsageTotals, value: UsageTotals): void {
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.costUsd += value.costUsd;
}

function messageKey(message: JsonObject): string {
  const timestamp = message.timestamp;
  if (typeof timestamp === "number" || typeof timestamp === "string") {
    return `${message.role ?? ""}:${timestamp}`;
  }
  return JSON.stringify([
    message.role,
    message.provider,
    message.model,
    message.stopReason,
    message.usage,
    message.content,
  ]);
}

function resultValue(value: unknown): unknown | null {
  return value === undefined ? null : value;
}

function parseJsonObject(line: string): JsonObject | null {
  try {
    return object(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

export function parseOmpJsonLine(line: string): JsonObject | null {
  const direct = parseJsonObject(line);
  if (direct) return direct;
  const repaired = repairRedactedJsonLine(line);
  return repaired === null ? null : parseJsonObject(repaired);
}

export interface OmpOutputAccumulator {
  push(rawLine: string, event?: JsonObject | null): void;
  result(): ParsedOmpOutput;
}

export function createOmpOutputAccumulator(): OmpOutputAccumulator {
  const toolCalls = new Map<string, ParsedOmpToolCall>();
  const toolCallList: ParsedOmpToolCall[] = [];
  const messageTexts = new Map<string, string>();
  const messageUsage = new Map<string, UsageTotals>();
  const turnUsageKeys = new Set<string>();
  const explicitUsage: UsageTotals[] = [];
  const unknownKept: string[] = [];
  let unknownDropped = 0;
  let unknownDroppedBytes = 0;
  let terminalError: string | null = null;
  let sessionId: string | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  let finalMessage: string | null = null;

  const recordUnknown = (line: string): void => {
    if (unknownKept.length < UNKNOWN_LINE_LIMIT) {
      unknownKept.push(
        line.length > UNKNOWN_LINE_CHARS
          ? `${line.slice(0, UNKNOWN_LINE_CHARS)}… (${line.length} bytes)`
          : line,
      );
      return;
    }
    unknownDropped += 1;
    unknownDroppedBytes += line.length;
  };

  const readAssistant = (value: unknown, collectMessage: boolean): JsonObject | null => {
    const message = object(value);
    if (!message || message.role !== "assistant") return null;
    const messageProvider = string(message.provider).trim();
    const messageModel = string(message.model).trim();
    if (messageProvider) provider = messageProvider;
    if (messageModel) model = messageModel;

    const text = textContent(message.content);
    if (text) {
      finalMessage = text;
      if (collectMessage) messageTexts.set(messageKey(message), text);
    }

    const stopReason = string(message.stopReason).trim();
    if (stopReason === "error" || stopReason === "aborted") {
      terminalError = string(message.errorMessage).trim() || `OMP request ${stopReason}.`;
    } else if (stopReason && stopReason !== "unknown") {
      terminalError = null;
    }
    return message;
  };

  const push = (rawLine: string, parsedEvent?: JsonObject | null): void => {
    const line = rawLine.trim();
    if (!line) return;
    const event = parsedEvent === undefined ? parseOmpJsonLine(line) : parsedEvent;
    if (!event) {
      recordUnknown(rawLine);
      return;
    }

    const type = string(event.type);
    let handled = true;
    switch (type) {
      case "session": {
        const id = string(event.id ?? event.sessionId ?? event.session_id).trim();
        if (id) sessionId = id;
        break;
      }
      case "session_start": {
        const id = string(event.sessionId ?? event.session_id ?? event.id).trim();
        if (id) sessionId = id;
        break;
      }
      case "message_start":
        readAssistant(event.message, false);
        break;
      case "message_end": {
        const message = readAssistant(event.message, true);
        if (message) {
          const usage = usageFromMessage(message);
          if (usage) messageUsage.set(messageKey(message), usage);
        }
        break;
      }
      case "turn_end": {
        const message = readAssistant(event.message, true);
        if (message) {
          const key = messageKey(message);
          const usage = usageFromMessage(message);
          if (usage) messageUsage.set(key, usage);
          turnUsageKeys.add(key);
        }
        const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
        for (const value of toolResults) {
          const toolResult = object(value);
          if (!toolResult) continue;
          const id = string(toolResult.toolCallId).trim();
          if (!id) continue;
          const existing = toolCalls.get(id);
          if (existing) {
            existing.result = resultValue(toolResult.content ?? toolResult.result);
            existing.isError = toolResult.isError === true;
          }
        }
        break;
      }
      case "agent_end": {
        if (Array.isArray(event.messages)) {
          for (let index = event.messages.length - 1; index >= 0; index -= 1) {
            if (readAssistant(event.messages[index], false)) break;
          }
        }
        break;
      }
      case "message_update":
      case "agent_start":
      case "turn_start":
      case "tool_execution_update":
      case "auto_retry_start":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "retry_fallback_applied":
      case "retry_fallback_succeeded":
      case "thinking_level_changed":
      case "ttsr_triggered":
      case "todo_reminder":
      case "todo_auto_clear":
      case "irc_message":
      case "goal_updated":
      case "notice":
        break;
      case "auto_retry_end":
        if (event.success === false) {
          terminalError = string(event.finalError).trim() || "OMP exhausted automatic retries without producing a response.";
        } else if (event.success === true) {
          terminalError = null;
        }
        break;
      case "tool_execution_start": {
        const id = string(event.toolCallId).trim();
        const name = string(event.toolName).trim();
        if (!id && !name) break;
        const key = id || `anonymous-${toolCallList.length + 1}`;
        const call: ParsedOmpToolCall = {
          toolCallId: id,
          toolName: name,
          args: event.args,
          result: null,
          isError: false,
        };
        toolCalls.set(key, call);
        toolCallList.push(call);
        break;
      }
      case "tool_execution_end": {
        const id = string(event.toolCallId).trim();
        const existing = toolCalls.get(id);
        if (existing) {
          existing.result = resultValue(event.result);
          existing.isError = event.isError === true;
        } else {
          const call: ParsedOmpToolCall = {
            toolCallId: id,
            toolName: string(event.toolName).trim(),
            args: null,
            result: resultValue(event.result),
            isError: event.isError === true,
          };
          toolCalls.set(id || `anonymous-end-${toolCallList.length + 1}`, call);
          toolCallList.push(call);
        }
        break;
      }
      case "usage": {
        const usage = object(event.usage) ?? event;
        const cost = object(usage.cost);
        explicitUsage.push({
          inputTokens: number(usage.inputTokens ?? usage.input),
          outputTokens: number(usage.outputTokens ?? usage.output),
          cachedInputTokens: number(usage.cachedInputTokens ?? usage.cacheRead),
          costUsd: number(usage.costUsd ?? cost?.total),
        });
        break;
      }
      case "error": {
        const message = string(event.message ?? event.error).trim();
        if (message) terminalError = message;
        break;
      }
      default:
        handled = false;
    }
    if (!handled) recordUnknown(rawLine);
  };

  const result = (): ParsedOmpOutput => {
    const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
    const selectedUsageKeys = turnUsageKeys.size > 0 ? turnUsageKeys : new Set(messageUsage.keys());
    for (const key of selectedUsageKeys) {
      const usage = messageUsage.get(key);
      if (usage) addUsage(totals, usage);
    }
    if (selectedUsageKeys.size === 0) {
      for (const usage of explicitUsage) addUsage(totals, usage);
    }
    return {
      sessionId,
      messages: [...messageTexts.values()],
      finalMessage,
      errors: terminalError ? [terminalError] : [],
      provider,
      model,
      usage: {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cachedInputTokens: totals.cachedInputTokens,
      },
      costUsd: totals.costUsd,
      toolCalls: toolCallList,
      unknownLines: unknownDropped > 0
        ? [...unknownKept, `… ${unknownDropped} more unparsed lines (${unknownDroppedBytes} bytes)`]
        : unknownKept,
    };
  };

  return { push, result };
}

export function parseOmpJsonl(stdout: string): ParsedOmpOutput {
  const accumulator = createOmpOutputAccumulator();
  for (const rawLine of stdout.split(/\r?\n/)) accumulator.push(rawLine);
  return accumulator.result();
}

export function isOmpUnknownSessionError(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`;
  return (
    /Session\s+["'][^"'\r\n]+["']\s+not found\.?/i.test(text) ||
    /unknown\s+(?:OMP\s+)?session\b/i.test(text) ||
    /could not (?:find|resolve)\s+(?:the\s+)?session\b/i.test(text)
  );
}
