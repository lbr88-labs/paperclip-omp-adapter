import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendWithCap } from "@paperclipai/adapter-utils/server-utils";

export type SteeringInput = {
  runId: string;
  message: string;
  correlationId: string;
  onAcknowledged?: () => Promise<void>;
};

export type SteeringState = "available" | "temporarily_unavailable";

type RpcFrame = Record<string, unknown>;
type SteerRecord = {
  message: string;
  turnId: string;
  accepted: Promise<void>;
  acceptedByOmp: boolean;
};
type LiveRun = {
  child: ChildProcessWithoutNullStreams;
  available: boolean;
  records: Map<string, SteerRecord>;
  pending: Map<string, { resolve: (frame: RpcFrame) => void; reject: (error: Error) => void }>;
};

const activeRuns = new Map<string, LiveRun>();
const completedSteers = new Map<string, Map<string, SteerRecord>>();

function steeringError(code: "steering_temporarily_unavailable" | "steering_rejected" | "steering_timeout", message: string): Error {
  return Object.assign(new Error(message), { code });
}

function send(run: LiveRun, command: RpcFrame): void {
  if (run.child.stdin.destroyed || !run.child.stdin.writable) {
    throw steeringError("steering_temporarily_unavailable", "OMP RPC input is closed.");
  }
  run.child.stdin.write(`${JSON.stringify(command)}\n`);
}

function request(run: LiveRun, id: string, command: RpcFrame): Promise<RpcFrame> {
  const reply = new Promise<RpcFrame>((resolve, reject) => run.pending.set(id, { resolve, reject }));
  try {
    send(run, { id, ...command });
  } catch (error) {
    run.pending.delete(id);
    return Promise.reject(error);
  }
  return reply;
}

async function acknowledge(record: SteerRecord, onAcknowledged?: () => Promise<void>): Promise<{ turnId: string }> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      record.accepted,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(steeringError("steering_timeout", "OMP did not acknowledge the steering command within 10 seconds.")), 10_000);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  // The host may commit its acknowledgement after this callback returns. Invoke it
  // again on a duplicate even if an earlier callback succeeded but that commit failed.
  await onAcknowledged?.();
  return { turnId: record.turnId };
}

export function getSteeringState(runId: string): SteeringState {
  return activeRuns.get(runId)?.available ? "available" : "temporarily_unavailable";
}

export async function steer(input: SteeringInput): Promise<{ turnId: string }> {
  const previous = activeRuns.get(input.runId)?.records.get(input.correlationId)
    ?? completedSteers.get(input.runId)?.get(input.correlationId);
  if (previous) {
    if (previous.message !== input.message) {
      throw steeringError("steering_rejected", "The steering correlation ID was already used for a different message.");
    }
    return acknowledge(previous, input.onAcknowledged);
  }
  const run = activeRuns.get(input.runId);
  if (!run?.available) {
    throw steeringError("steering_temporarily_unavailable", "There is no active local OMP RPC turn to steer.");
  }
  const turnId = `steer:${input.correlationId}`;
  const record: SteerRecord = { message: input.message, turnId, accepted: Promise.resolve(), acceptedByOmp: false };
  record.accepted = request(run, turnId, { type: "steer", message: input.message }).then((frame) => {
    if (frame.success !== true || frame.command !== "steer") {
      throw steeringError("steering_rejected", typeof frame.error === "string" ? frame.error : "OMP rejected the steering message.");
    }
    record.acceptedByOmp = true;
  });
  run.records.set(input.correlationId, record);
  try {
    return await acknowledge(record, input.onAcknowledged);
  } catch (error) {
    // Only an explicit rejection is safe to resend. A deadline leaves acceptance
    // ambiguous, so retain its correlation record and continue listening for a reply.
    if (!record.acceptedByOmp && (error as { code?: string }).code === "steering_rejected"
        && run.records.get(input.correlationId) === record) {
      run.records.delete(input.correlationId);
    }
    throw error;
  }
}

export type RpcProcessResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export async function runLocalRpc(input: {
  runId: string;
  command: string;
  args: string[];
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  signal?: AbortSignal;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  onCancellationReady?: () => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSession: (sessionId: string) => Promise<void>;
}): Promise<RpcProcessResult> {
  if (activeRuns.has(input.runId)) throw new Error(`OMP run ${input.runId} is already active.`);
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const run: LiveRun = { child, available: false, records: new Map(), pending: new Map() };
  activeRuns.set(input.runId, run);
  child.stdin.on("error", () => {}); // Exits may race writes; pending requests fail on close.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let timedOut = false;
  let settled = false;
  let promptAccepted = false;
  let promptCompleted = false;
  let logChain = Promise.resolve();
  let promptResultError: string | null = null;
  const queueLog = (stream: "stdout" | "stderr", chunk: string) => {
    logChain = logChain.then(() => input.onLog(stream, chunk)).catch(() => {});
  };
  const closeInput = () => {
    if (!settled) {
      settled = true;
      run.available = false;
      child.stdin.end();
    }
  };
  const stop = (signal: NodeJS.Signals) => {
    run.available = false;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* already exited */ }
  };
  const abort = () => stop("SIGINT");
  const timeout = input.timeoutSec > 0 ? setTimeout(() => {
    timedOut = true;
    for (const pending of run.pending.values()) {
      pending.reject(steeringError("steering_timeout", "OMP did not acknowledge the steering command before the run timed out."));
    }
    run.pending.clear();
    stop("SIGTERM");
    killTimer = setTimeout(() => stop("SIGKILL"), Math.max(1, input.graceSec) * 1000);
    killTimer.unref();
  }, input.timeoutSec * 1000) : undefined;
  timeout?.unref();
  let killTimer: NodeJS.Timeout | undefined;
  const promptId = `prompt:${input.runId}`;
  const stateId = `state:${input.runId}`;
  const emitEvent = (frame: RpcFrame) => {
    const line = `${JSON.stringify(frame)}\n`;
    stdout = appendWithCap(stdout, line);
    queueLog("stdout", line);
  };
  const startPrompt = () => {
    void request(run, promptId, { type: "prompt", message: input.prompt }).then((frame) => {
      if (frame.command !== "prompt" || frame.success !== true) {
        promptResultError = typeof frame.error === "string" ? frame.error : "OMP rejected the prompt.";
        emitEvent({ type: "error", message: promptResultError });
        closeInput();
      } else if ((frame.data as RpcFrame | undefined)?.agentInvoked === false) {
        promptCompleted = true;
        closeInput();
      } else {
        promptAccepted = true;
        run.available = !settled;
      }
    }).catch(() => {}); // Process exit is reported by the execution result.
  };
  const handleFrame = (line: string) => {
    let frame: RpcFrame;
    try {
      const decoded: unknown = JSON.parse(line);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid RPC frame");
      frame = decoded as RpcFrame;
    } catch {
      stdout = appendWithCap(stdout, `${line}\n`);
      queueLog("stdout", `${line}\n`);
      return;
    }
    if (frame.type === "ready") {
      void request(run, stateId, { type: "get_state" }).then((state) => {
        if (state.success !== true || state.command !== "get_state") {
          emitEvent({ type: "error", message: typeof state.error === "string" ? state.error : "OMP RPC state request failed." });
          closeInput();
          return;
        }
        const data = state.data as RpcFrame | undefined;
        if (typeof data?.sessionId === "string" && data.sessionId) {
          void input.onSession(data.sessionId).catch((error: unknown) => {
            emitEvent({ type: "error", message: error instanceof Error ? error.message : String(error) });
            closeInput();
          });
        }
        startPrompt();
      }).catch(() => {});
      return;
    }
    if (frame.type === "response") {
      const id = frame.id;
      if (typeof id === "string") {
        const pending = run.pending.get(id);
        if (pending) {
          run.pending.delete(id);
          pending.resolve(frame);
        }
      }
      // Late asynchronous prompt scheduling errors use the original prompt ID.
      if (id === promptId && promptAccepted && frame.success === false) {
        promptResultError = typeof frame.error === "string" ? frame.error : "OMP failed to start the prompt.";
        emitEvent({ type: "error", message: promptResultError });
      }
      return;
    }
    if (frame.type === "prompt_result") {
      if (frame.id === promptId && (frame.status === "error" || frame.status === "aborted")) {
        const error = frame.error as RpcFrame | undefined;
        promptResultError = typeof error?.message === "string" ? error.message : `OMP prompt ${frame.status}.`;
        emitEvent({ type: "error", message: promptResultError });
      }
      if (frame.id === promptId) promptCompleted = true;
      if (frame.sessionSettled === true) closeInput();
      return;
    }
    if (frame.type === "session_settled") {
      closeInput();
      return;
    }
    if (frame.type === "available_commands_update" || frame.type === "rpc_chunk" ||
        frame.type === "extension_ui_request" || frame.type === "host_tool_call" ||
        frame.type === "host_tool_cancel" || frame.type === "host_uri_request" || frame.type === "host_uri_cancel") return;
    emitEvent(frame);
  };
  child.stdout.on("data", (chunk: string) => {
    child.stdout.pause();
    buffer += chunk;
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      handleFrame(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
    }
    void logChain.finally(() => child.stdout.resume());
  });
  child.stderr.on("data", (chunk: string) => {
    child.stderr.pause();
    stderr = appendWithCap(stderr, chunk);
    queueLog("stderr", chunk);
    void logChain.finally(() => child.stderr.resume());
  });
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const startedAt = new Date().toISOString();
  const outcomePromise = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  void outcomePromise.catch(() => {});
  try {
    if (child.pid && input.onSpawn) {
      await input.onSpawn({
        pid: child.pid,
        processGroupId: process.platform === "win32" ? null : child.pid,
        startedAt,
      });
    }
    await input.onCancellationReady?.();
    const outcome = await outcomePromise;
    if (buffer.trim()) handleFrame(buffer);
    if (!promptCompleted && !promptResultError && !timedOut && !input.signal?.aborted) {
      emitEvent({ type: "error", message: "OMP RPC process exited before the prompt completed." });
    }
    await logChain;
    return { ...outcome, timedOut, stdout, stderr };
  } finally {
    run.available = false;
    activeRuns.delete(input.runId);
    if (run.records.size > 0) {
      const accepted = new Map([...run.records].filter(([, record]) => record.acceptedByOmp));
      if (accepted.size > 0) {
        completedSteers.set(input.runId, accepted);
        // Keep accepted responses for a late host retry, without retaining runs forever.
        const expiry = setTimeout(() => completedSteers.delete(input.runId), 60 * 60 * 1000);
        expiry.unref();
      }
    }
    for (const pending of run.pending.values()) {
      pending.reject(steeringError("steering_temporarily_unavailable", "The OMP RPC process exited before replying."));
    }
    run.pending.clear();
    clearTimeout(timeout);
    clearTimeout(killTimer);
    input.signal?.removeEventListener("abort", abort);
    if (!child.killed && child.exitCode === null && child.signalCode === null) stop("SIGTERM");
  }
}
