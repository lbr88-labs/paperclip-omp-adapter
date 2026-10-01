import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createServerAdapter } from "../dist/index.js";
import { prepareOmpRuntimeConfig } from "../dist/server/config.js";
import {
  applyPreparedOmpAgentEnvironment,
  applyRuntimeToolAccess,
  buildOmpArgs,
  rewriteRemoteConfigPaths,
} from "../dist/server/execute.js";
import { classifyOmpFailure } from "../dist/server/failure.js";
import { parseOmpJsonl } from "../dist/server/parse.js";
import { createOmpProgressReporter } from "../dist/server/progress.js";
import { getOmpQuotaWindows } from "../dist/server/quota.js";
import { resolveOmpProfile } from "../dist/server/profile.js";

const adapter = createServerAdapter();
assert.equal(adapter.type, "omp_local");
assert.equal(adapter.sessionManagement?.supportsSessionResume, true);
assert.equal(adapter.supportsInstructionsBundle, true);
assert(adapter.listModels && adapter.refreshModels && adapter.detectModel);
assert(adapter.listSkills && adapter.syncSkills && adapter.getConfigSchema);

const uiParserSource = await fs.readFile(new URL("../dist/ui-parser.js", import.meta.url), "utf8");
const uiParserExports = {};
const uiParserModule = { exports: uiParserExports };
new Function("exports", "module", "self", "globalThis", uiParserSource)(
  uiParserExports,
  uiParserModule,
  undefined,
  undefined,
);
const parseStdoutLine = uiParserModule.exports.parseStdoutLine;
const transcriptTs = "2026-07-20T23:52:22Z";
assert.deepEqual(
  parseStdoutLine(JSON.stringify({
    type: "thinking_level_changed",
    thinkingLevel: "high",
    configured: "auto",
    resolved: "high",
  }), transcriptTs),
  [{ kind: "system", ts: transcriptTs, text: "OMP thinking level: high" }],
);
for (const event of [
  { type: "turn_start" },
  {
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: " concise" },
  },
  {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "read",
    partialResult: { content: [] },
  },
]) {
  assert.deepEqual(parseStdoutLine(JSON.stringify(event), transcriptTs), []);
}
assert.deepEqual(
  parseStdoutLine(JSON.stringify({ type: "future_omp_event" }), transcriptTs),
  [{ kind: "stdout", ts: transcriptTs, text: '{"type":"future_omp_event"}' }],
);

const schema = await adapter.getConfigSchema();
const schemaKeys = new Set(schema.fields.map((field) => field.key));
for (const key of ["model", "profile", "agentDir", "modelsYaml", "tools", "extensions", "pluginDirs", "configFiles"]) {
  assert(schemaKeys.has(key), `missing config field: ${key}`);
}

assert.deepEqual(
  resolveOmpProfile({ env: { OMP_PROFILE: "", PI_PROFILE: "work" } }, {}),
  { profile: null, specified: true },
);
assert.deepEqual(resolveOmpProfile({ profile: "default" }, {}), { profile: null, specified: true });
assert.throws(() => resolveOmpProfile({ profile: "CON" }, {}), /Invalid OMP profile/);
assert.throws(() => resolveOmpProfile({ profile: "trailing." }, {}), /Invalid OMP profile/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-test-"));
const profileAgentDir = path.join(root, "profiles", "work", "agent");
await fs.mkdir(profileAgentDir, { recursive: true });
await fs.writeFile(
  path.join(profileAgentDir, "models.yml"),
  `providers:\n  safe-provider:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: SAFE_PROVIDER_KEY\n    models:\n      - id: safe-model\n        contextWindow: 4096\n        maxTokens: 1024\n`,
);
await fs.writeFile(
  path.join(profileAgentDir, "config.yml"),
  `extensions:\n  - ~/.omp/extensions/private.ts\ndisabledExtensions: []\n`,
);

const prepared = await prepareOmpRuntimeConfig(
  {
    env: {
      PI_CONFIG_DIR: root,
      OMP_PROFILE: "work",
      SAFE_PROVIDER_KEY: "must-not-be-serialized",
    },
  },
  { forceMaterialized: true },
);
try {
  assert.equal(prepared.profile, "work");
  assert.equal(prepared.materialized, true);
  assert(prepared.agentDir);
  const yaml = await fs.readFile(path.join(prepared.agentDir, "models.yml"), "utf8");
  assert.match(yaml, /safe-provider:/);
  assert.match(yaml, /apiKey: SAFE_PROVIDER_KEY/);
  assert.doesNotMatch(yaml, /must-not-be-serialized/);
  const configYaml = await fs.readFile(path.join(prepared.agentDir, "config.yml"), "utf8");
  assert.doesNotMatch(configYaml, /^extensions:/m);
  assert(prepared.notes.some((note) => note.includes("Skipped config extensions")));

  const remoteEnv = {
    PI_CODING_AGENT_DIR: "/local/agent",
    OMP_PROFILE: "work",
    PI_PROFILE: "work",
  };
  applyPreparedOmpAgentEnvironment(remoteEnv, prepared, "/remote/assets/agent");
  assert.equal(remoteEnv.PI_CODING_AGENT_DIR, "/remote/assets/agent");
  assert.equal(remoteEnv.OMP_PROFILE, "");
  assert.equal(remoteEnv.PI_PROFILE, "");
} finally {
  await prepared.cleanup();
}
const explicitDefault = await prepareOmpRuntimeConfig({ env: { OMP_PROFILE: "", PI_PROFILE: "work" } });
assert.equal(explicitDefault.profile, null);
assert.equal(explicitDefault.profileSpecified, true);

await assert.rejects(
  () => prepareOmpRuntimeConfig({
    modelsYaml: `providers:\n  unsafe:\n    api: openai-completions\n    apiKey: literal-secret\n    models:\n      - id: unsafe\n        contextWindow: 4096\n        maxTokens: 1024\n`,
  }),
  /credential-bearing fields/,
);
await assert.rejects(
  () => prepareOmpRuntimeConfig({
    modelsYaml: `providers: { unsafe: { api: openai-completions, apiKey: literal-secret, models: [{ id: unsafe, contextWindow: 4096, maxTokens: 1024 }] } }`,
  }),
  /credential-bearing fields/,
);

for (const baseUrl of [
  "https://api.example/v1?api_key=literal",
  "https://TOKEN@api.example/v1",
]) {
  await assert.rejects(
    () => prepareOmpRuntimeConfig({
      modelsYaml: `providers:\n  unsafe:\n    baseUrl: ${baseUrl}\n    api: openai-completions\n    models:\n      - id: unsafe\n        contextWindow: 4096\n        maxTokens: 1024\n`,
    }),
    /credential-bearing fields/,
  );
}

const fakeOmp = path.join(root, "fake-omp.mjs");
await fs.writeFile(fakeOmp, `#!/usr/bin/env node
import nodeFs from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_OMP_ARGV_LOG) {
  nodeFs.appendFileSync(process.env.FAKE_OMP_ARGV_LOG, args.join(" ") + "\\n");
}
if (args[0] === "models") {
  console.log(JSON.stringify({ models: [{ provider: "fake-provider", id: "fake-model", selector: "fake-provider/fake-model", name: "Fake model" }] }));
  process.exit(0);
}
if (args[0] === "usage") {
  console.log(JSON.stringify({ generatedAt: 1, reports: [{ provider: "fake-provider", fetchedAt: 1, limits: [{ id: "5h", label: "Five hour", scope: {}, window: { id: "5h", label: "5 Hour", resetsAt: 1789800000000 }, amount: { used: 25, limit: 100, unit: "percent" }, status: "ok", notes: ["sample"] }] }], accountsWithoutUsage: [], disabledCredentials: [] }));
  process.exit(0);
}
if (args.includes("rpc")) {
  const resumeAt = args.indexOf("--resume");
  const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : "fake-session-1";
  const readline = (await import("node:readline")).createInterface({ input: process.stdin });
  const emit = (event) => console.log(JSON.stringify(event));
  emit({ type: "ready", protocolVersion: 1 });
  emit({ type: "available_commands_update", commands: [] });
  let activePrompt = null;
  let steered = "";
  let steerCount = 0;
  const finish = (prompt) => {
    const text = prompt + (steered ? "|STEER=" + steered : "") +
      "|OMP_PROFILE=" + (process.env.OMP_PROFILE ?? "") +
      "|PI_PROFILE=" + (process.env.PI_PROFILE ?? "") +
      "|AGENT_DIR=" + (process.env.PI_CODING_AGENT_DIR ?? "") +
      "|PAPERCLIP_API_KEY=" + (process.env.PAPERCLIP_API_KEY ? "set" : "");
    if (prompt.includes("ABRUPT_THINKING")) {
      emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "last thought before the process stops" } });
      process.exit(0);
    }
    if (prompt.includes("HUGE_LOG")) {
      const early = { role: "assistant", provider: "fake-provider", model: "fake-model", content: [{ type: "text", text: "early" }], stopReason: "stop", usage: { input: 7, output: 3, cacheRead: 1, cost: { total: 0.002 } } };
      emit({ type: "turn_end", message: early });
      emit({ type: "tool_execution_start", toolCallId: "huge-call-1", toolName: "bash", args: { command: "true" } });
      emit({ type: "tool_execution_end", toolCallId: "huge-call-1", toolName: "bash", result: { content: [] }, isError: false });
      const filler = "f".repeat(4000);
      for (let index = 0; index < 1400; index += 1) emit({ type: "notice", text: filler + index });
      if (prompt.includes("HUGE_LOG_ABORT")) {
        emit({ type: "notice", text: "ABORT_MARKER" });
        return;
      }
      const late = { role: "assistant", provider: "fake-provider", model: "fake-model", content: [{ type: "text", text: "HUGE_LOG_DONE" }], stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } } };
      emit({ type: "message_end", message: late });
      emit({ type: "turn_end", message: late });
    } else {
      for (let thought = 0; thought < 12; thought += 1) emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "step " + thought + " weighing the adapter contract against the durable run events panel; " } });
      emit({ type: "tool_execution_start", toolCallId: "fake-call-1", toolName: "bash", args: { command: "true" } });
      emit({ type: "tool_execution_end", toolCallId: "fake-call-1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
      emit({ type: "tool_execution_start", toolCallId: "fake-call-2", toolName: "fabric_exec", args: { code: "return 1;" }, intent: "Inspecting adapter and Paperclip install" });
      emit({ type: "tool_execution_end", toolCallId: "fake-call-2", toolName: "fabric_exec", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
      const message = { role: "assistant", provider: "fake-provider", model: "fake-model", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } } };
      emit({ type: "message_end", message });
      emit({ type: "turn_end", message });
    }
    emit({ type: "prompt_result", id: activePrompt, agentInvoked: true, status: "completed", sessionSettled: true });
    emit({ type: "session_settled" });
  };
  for await (const line of readline) {
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      emit({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId, isSettled: true } });
    } else if (command.type === "prompt") {
      activePrompt = command.id;
      emit({ type: "response", id: command.id, command: "prompt", success: true, data: { agentInvoked: true } });
      if (command.message.includes("BOOTSTRAP_FAIL")) {
        process.stderr.write("omp: provider overloaded, please try again in 30 seconds\\n");
        process.exit(1);
      }
      if (!command.message.includes("STEER_HOLD")) setTimeout(() => finish(command.message), 0);
      else globalThis.heldPrompt = command.message;
    } else if (command.type === "steer") {
      if (command.message === "REJECT_ME") {
        emit({ type: "response", id: command.id, command: "steer", success: false, error: "Steering rejected by OMP" });
      } else {
        steerCount += 1;
        steered = command.message;
        emit({ type: "response", id: command.id, command: "steer", success: true });
        if (process.env.FAKE_STEER_LOG) nodeFs.appendFileSync(process.env.FAKE_STEER_LOG, process.pid + ":" + steerCount + ":" + steered + "\\n");
        if (globalThis.heldPrompt) setTimeout(() => finish(globalThis.heldPrompt), 30);
      }
    }
  }
  process.exit(0);
}
const resumeIndex = args.indexOf("--resume");
const noSession = args.includes("--no-session");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : "fake-session-1";
const prompt = args.at(-1) ?? "";
if (prompt.includes("BOOTSTRAP_FAIL")) {
  process.stderr.write("omp: provider overloaded, please try again in 30 seconds\\n");
  process.exit(1);
}
if (!noSession) console.log(JSON.stringify({ type: "session", id: sessionId }));
if (prompt.includes("ABRUPT_THINKING")) {
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "last thought before the process stops" } }));
  process.exit(0);
}
if (prompt.includes("HUGE_LOG")) {
  const earlyMessage = {
    id: "huge-early",
    role: "assistant",
    provider: "fake-provider",
    model: "fake-model",
    content: [{ type: "text", text: "early turn before the truncation window" }],
    stopReason: "stop",
    usage: { input: 7, output: 3, cacheRead: 1, cost: { total: 0.002 } },
  };
  console.log(JSON.stringify({ type: "turn_end", message: earlyMessage }));
  console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "huge-call-1", toolName: "bash", args: { command: "true" } }));
  console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "huge-call-1", toolName: "bash", result: { content: [] }, isError: false }));
  const filler = "f".repeat(4000);
  for (let index = 0; index < 1400; index += 1) {
    console.log(JSON.stringify({ type: "notice", text: filler + index }));
  }
  if (prompt.includes("HUGE_LOG_ABORT")) {
    console.log(JSON.stringify({ type: "notice", text: "ABORT_MARKER" }));
    setInterval(() => {}, 1000);
  } else {
    const lateMessage = {
      id: "huge-late",
      role: "assistant",
      provider: "fake-provider",
      model: "fake-model",
      content: [{ type: "text", text: "HUGE_LOG_DONE" }],
      stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } },
    };
    console.log(JSON.stringify({ type: "message_end", message: lateMessage }));
    console.log(JSON.stringify({ type: "turn_end", message: lateMessage }));
    await new Promise((resolve) => { process.stdout.write("", resolve); });
    process.exit(0);
  }
}
for (let thought = 0; thought < 12; thought += 1) {
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "step " + thought + " weighing the adapter contract against the durable run events panel; " } }));
}
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "fake-call-1", toolName: "bash", args: { command: "true" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "fake-call-1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "fake-call-2", toolName: "fabric_exec", args: { code: "return 1;" }, intent: "Inspecting adapter and Paperclip install" }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "fake-call-2", toolName: "fabric_exec", result: { content: [{ type: "text", text: "ok" }] }, isError: false }));
const message = {
  id: "fake-message-1",
  role: "assistant",
  provider: "fake-provider",
  model: "fake-model",
  content: [{
    type: "text",
    text: prompt +
      "|OMP_PROFILE=" + (process.env.OMP_PROFILE ?? "") +
      "|PI_PROFILE=" + (process.env.PI_PROFILE ?? "") +
      "|AGENT_DIR=" + (process.env.PI_CODING_AGENT_DIR ?? "") +
      "|PAPERCLIP_API_KEY=" + (process.env.PAPERCLIP_API_KEY ? "set" : ""),
  }],
  stopReason: "stop",
  usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } },
};
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "turn_end", message }));
`);
await fs.chmod(fakeOmp, 0o755);
const previousOmpCommand = process.env.PAPERCLIP_OMP_COMMAND;
process.env.PAPERCLIP_OMP_COMMAND = fakeOmp;
const advertisedAdapter = createServerAdapter();
assert.equal((await advertisedAdapter.listModels()).length, 1);
assert.equal(advertisedAdapter.models.length, 1, "dynamic model discovery must update the static model summary");
if (previousOmpCommand === undefined) delete process.env.PAPERCLIP_OMP_COMMAND;
else process.env.PAPERCLIP_OMP_COMMAND = previousOmpCommand;

const executionCwd = path.join(root, "workspace");
await fs.mkdir(executionCwd);
assert.equal(
  rewriteRemoteConfigPaths({ extensions: ["extensions/provider.ts"] }, executionCwd, "/remote/workspace").extensions[0],
  "/remote/workspace/extensions/provider.ts",
);
assert.throws(
  () => rewriteRemoteConfigPaths({ extensions: ["../outside.ts"] }, executionCwd, "/remote/workspace"),
  /must be inside the synchronized workspace/,
);
assert.throws(
  () => rewriteRemoteConfigPaths({ extensions: ["~/.omp/provider.ts"] }, executionCwd, "/remote/workspace"),
  /must be inside the synchronized workspace/,
);
const agent = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "00000000-0000-4000-8000-000000000002",
  name: "OMP adapter test",
  adapterType: "omp_local",
  adapterConfig: {},
};
const emptyRuntime = {
  sessionId: null,
  sessionParams: null,
  sessionDisplayId: null,
  taskKey: null,
};
const baseConfig = {
  command: fakeOmp,
  cwd: executionCwd,
  promptTemplate: "{{context.expected}}",
  timeoutSec: 10,
  graceSec: 1,
  noExtensions: true,
  noSkills: true,
  noRules: true,
  noLsp: true,
  noPty: true,
  noTitle: true,
  advisor: false,
  extraArgs: ["--no-tools"],
};
const metas = [];
const run = (runId, runtime, expected, config = baseConfig) => adapter.execute({
  runId,
  agent,
  runtime,
  config,
  context: { expected },
  onLog: async () => {},
  onMeta: async (meta) => metas.push(meta),
});

const fresh = await run("00000000-0000-4000-8000-000000000011", emptyRuntime, "FRESH_OK");
assert.equal(fresh.exitCode, 0, fresh.errorMessage ?? "fresh execution failed");
assert.equal(fresh.sessionId, "fake-session-1");
assert.match(fresh.summary ?? "", /FRESH_OK/);
assert.deepEqual(fresh.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 });
assert.equal(fresh.usageBasis, "per_run");
assert.deepEqual(metas.at(-1).commandArgs.slice(0, 3), ["--mode", "rpc", "--no-ui"]);
assert(!metas.at(-1).commandArgs.includes("-p"));
assert(!metas.at(-1).commandArgs.some((arg) => arg.includes("FRESH_OK")),
  "the initial prompt must be sent through RPC stdin, not command arguments");

const resumed = await run(
  "00000000-0000-4000-8000-000000000012",
  {
    sessionId: fresh.sessionId,
    sessionParams: fresh.sessionParams,
    sessionDisplayId: fresh.sessionDisplayId,
    taskKey: null,
  },
  "RESUME_OK",
);
assert.equal(resumed.exitCode, 0, resumed.errorMessage ?? "resumed execution failed");
assert.equal(resumed.sessionId, fresh.sessionId);
assert.match(resumed.summary ?? "", /RESUME_OK/);
assert.equal(resumed.usageBasis, "per_run");

const ephemeralRunId = "00000000-0000-4000-8000-000000000013";
const ephemeral = await run(ephemeralRunId, emptyRuntime, "EPHEMERAL_OK", {
  ...baseConfig,
  noSession: true,
  env: {
    OPENROUTER_API_KEY: "unused-openrouter-key",
    PAPERCLIP_API_KEY: "configured-paperclip-key",
    PAPERCLIP_AGENT_ID: "attacker",
    PAPERCLIP_RUN_ID: "attacker",
  },
});
assert.equal(ephemeral.exitCode, 0, ephemeral.errorMessage ?? "ephemeral execution failed");
assert.equal(ephemeral.sessionId, null);
assert.equal(ephemeral.sessionParams, null);
assert.match(ephemeral.summary ?? "", /EPHEMERAL_OK/);
assert.equal(ephemeral.usageBasis, "per_run");
assert.equal(ephemeral.biller, "fake-provider");
assert.match(ephemeral.summary ?? "", /PAPERCLIP_API_KEY=set/);
const ephemeralMeta = metas.at(-1);
assert.equal(ephemeralMeta?.env?.PAPERCLIP_AGENT_ID, agent.id);
assert.equal(ephemeralMeta?.env?.PAPERCLIP_RUN_ID, ephemeralRunId);

const savedOmpProfile = process.env.OMP_PROFILE;
const savedPiProfile = process.env.PI_PROFILE;
process.env.OMP_PROFILE = "host-profile";
process.env.PI_PROFILE = "legacy-host-profile";
try {
  const materialized = await run(
    "00000000-0000-4000-8000-000000000014",
    emptyRuntime,
    "MATERIALIZED_OK",
    {
      ...baseConfig,
      noSession: true,
      modelsYaml: `providers:\n  smoke:\n    api: openai-completions\n    auth: none\n    models:\n      - id: smoke\n        contextWindow: 4096\n        maxTokens: 1024\n`,
    },
  );
  assert.equal(materialized.exitCode, 0, materialized.errorMessage ?? "materialized execution failed");
  assert.match(materialized.summary ?? "", /MATERIALIZED_OK/);
  assert.match(materialized.summary ?? "", /OMP_PROFILE=\|PI_PROFILE=\|/);
  assert.match(materialized.summary ?? "", /AGENT_DIR=.*paperclip-omp-agent-/);
} finally {
  if (savedOmpProfile === undefined) delete process.env.OMP_PROFILE;
  else process.env.OMP_PROFILE = savedOmpProfile;
  if (savedPiProfile === undefined) delete process.env.PI_PROFILE;
  else process.env.PI_PROFILE = savedPiProfile;
}

// Regression test 1: modelProfiles removed in 2026.916.0
assert.equal("modelProfiles" in adapter, false, "modelProfiles must be removed from adapter definition");

// Regression test 2: UI parser handles tool_execution_update with progress
const progressLine = JSON.stringify({
  type: "tool_execution_update",
  timestamp: new Date().toISOString(),
  toolCallId: "call-123",
  toolName: "bash",
  partialResult: { details: { progress: "Building project..." } }
});
const progressEntries = parseStdoutLine(progressLine);
assert.equal(progressEntries.length, 1);
assert.equal(progressEntries[0].kind, "tool_result");
assert.equal(progressEntries[0].toolUseId, "call-123");
assert.equal(progressEntries[0].content, "Building project...");
assert.equal(progressEntries[0].delta, true);

// Regression test 3: UI parser drops empty tool_execution_update
const emptyToolUpdate = JSON.stringify({
  type: "tool_execution_update",
  timestamp: new Date().toISOString(),
  toolCallId: "call-123",
  toolName: "bash",
  partialResult: {}
});
assert.deepEqual(parseStdoutLine(emptyToolUpdate), []);

// Regression test 4: --add-dir and --print-thoughts argument generation
const addDirRunId = "00000000-0000-4000-8000-000000000015";
await run(
  addDirRunId,
  emptyRuntime,
  "ADD_DIR_OK",
  {
    ...baseConfig,
    noSession: true,
    printThoughts: true,
    addDirs: "/tmp/custom-workspace-2",
  },
  {
    paperclipWorkspaces: [
      { cwd: "/tmp/custom-workspace-1" },
    ],
  },
);
const addDirMeta = metas.at(-1);
assert.ok(addDirMeta?.commandArgs?.includes("--print-thoughts"), "commandArgs must include --print-thoughts");
assert.ok(addDirMeta?.commandArgs?.some(arg => arg.startsWith("--add-dir=")), "commandArgs must include --add-dir");

// Regression test 5: Paperclip log redaction corrupts JSONL; the parsers repair it
const redactedLines = (await fs.readFile(new URL("./fixtures/redacted-lines.txt", import.meta.url), "utf8"))
  .split("\n")
  .filter(Boolean);
assert.equal(redactedLines.length, 3);
for (const [index, redactedLine] of redactedLines.entries()) {
  assert.throws(() => JSON.parse(redactedLine), "fixture must stay corrupted");
  const entries = parseStdoutLine(redactedLine, transcriptTs);
  assert.equal(entries.length, 1, `fixture ${index} must produce one entry`);
  assert.equal(entries[0].kind, "tool_result", `fixture ${index} must be repaired`);
  assert.equal(entries[0].toolName, "bash");
  if (index < 2) assert.match(entries[0].content, /\*\*\*REDACTED\*\*\*/);
}

// Regression test 6: an unrepairable JSON line collapses into one short notice
const truncatedLine = '{"type":"tool_execution_end","toolCallId":"c3","result":{"content":"';
const truncatedEntries = parseStdoutLine(truncatedLine, transcriptTs);
assert.equal(truncatedEntries.length, 1);
assert.equal(truncatedEntries[0].kind, "system");
assert.ok(truncatedEntries[0].text.length < 200);
assert.match(truncatedEntries[0].text, /tool_execution_end/);

// Regression test 7: parseOmpJsonl repairs redacted lines and bounds unknownLines
const repairedStdout = Array.from(
  { length: 120 },
  (_value, index) => redactedLines[0].replace('"toolCallId":"c1"', `"toolCallId":"c1-${index}"`),
).join("\n");
const repairedParse = parseOmpJsonl(repairedStdout);
assert.equal(repairedParse.toolCalls.length, 120);
assert.equal(repairedParse.unknownLines.length, 0);

const unreadableParse = parseOmpJsonl(Array.from({ length: 120 }, () => truncatedLine).join("\n"));
assert.equal(unreadableParse.unknownLines.length, 51);
assert.match(unreadableParse.unknownLines.at(-1), /^… 70 more unparsed lines \(\d+ bytes\)$/);
for (const entry of unreadableParse.unknownLines.slice(0, -1)) {
  assert.ok(entry.length <= 240);
}

// Regression test 8: adapter defaults are applied when the config leaves fields empty
await run(
  "00000000-0000-4000-8000-000000000016",
  emptyRuntime,
  "DEFAULTS_OK",
  { command: fakeOmp, cwd: executionCwd, noSession: true },
);
const defaultsMeta = metas.at(-1);
const defaultArgs = defaultsMeta?.commandArgs ?? [];
assert.ok(defaultArgs.includes("--no-title"), "default commandArgs must include --no-title");
assert.ok(defaultArgs.includes("--print-thoughts"), "default commandArgs must include --print-thoughts");
assert.equal(defaultArgs[defaultArgs.indexOf("--approval-mode") + 1], "yolo");
assert.ok(!defaultArgs.includes("--auto-approve"), "--auto-approve must no longer be emitted");

// Regression test 9: OMP stream drives Paperclip's live run status
const progressEvents = [];
const runEvents = [];
const progressRunId = "00000000-0000-4000-8000-000000000017";
await adapter.execute({
  runId: progressRunId,
  agent,
  runtime: emptyRuntime,
  config: { command: fakeOmp, cwd: executionCwd, noSession: true, promptTemplate: "{{context.expected}}" },
  context: { expected: "PROGRESS_OK" },
  onLog: async () => {},
  onMeta: async () => {},
  onRuntimeProgress: async (update) => { progressEvents.push(update); },
  onEvent: async (event) => { runEvents.push(event); },
});
const toolProgress = progressEvents.find((update) => update.currentToolName === "bash");
assert.ok(toolProgress, "a tool_execution_start must report currentToolName");
assert.equal(toolProgress.message, "Running bash");
const snippetProgress = progressEvents.filter((update) => update.lastAssistantSnippet).at(-1);
assert.ok(snippetProgress, "assistant output must report a snippet");
assert.match(snippetProgress.lastAssistantSnippet, /PROGRESS_OK/);

// Regression test 10: completed tool calls become durable Paperclip run events
const toolEvent = runEvents.find((event) => event.eventType === "omp.tool");
assert.ok(toolEvent, "a finished tool call must publish an omp.tool run event");
assert.equal(toolEvent.stream, "system");
assert.equal(toolEvent.level, "info");
assert.match(toolEvent.message, /^bash ok in \d+\.\ds \u2014 true$/);
const intentEvent = runEvents.find((event) => event.eventType === "omp.tool" && event.message.startsWith("fabric_exec"));
assert.ok(intentEvent, "a fabric_exec tool call must publish an omp.tool run event");
assert.match(
  intentEvent.message,
  /^fabric_exec ok in \d+\.\ds \u2014 Inspecting adapter and Paperclip install$/,
);

const thinkingEvents = runEvents.filter((event) => event.eventType === "omp.thinking");
assert.equal(thinkingEvents.length, 1, "one finished thinking segment must publish exactly one omp.thinking event");
assert.equal(thinkingEvents[0].stream, "system");
assert.equal(thinkingEvents[0].level, "info");
assert.match(thinkingEvents[0].message, /^step 0 weighing the adapter contract/);
assert.equal(thinkingEvents[0].message.length, 501);
assert.ok(thinkingEvents[0].message.endsWith("\u2026"), "a long thinking segment must be cut with an ellipsis");
assert.ok(
  runEvents.indexOf(thinkingEvents[0]) < runEvents.findIndex((event) => event.eventType === "omp.tool"),
  "thinking must be published before the tool call that ended it",
);

// Regression test 10b: a stream that stops right after thinking still publishes the segment
const abruptEvents = [];
await adapter.execute({
  runId: "00000000-0000-4000-8000-000000000018",
  agent,
  runtime: emptyRuntime,
  config: { command: fakeOmp, cwd: executionCwd, noSession: true, promptTemplate: "{{context.expected}}" },
  context: { expected: "ABRUPT_THINKING" },
  onLog: async () => {},
  onMeta: async () => {},
  onEvent: async (event) => { abruptEvents.push(event); },
});
const abruptThinking = abruptEvents.filter((event) => event.eventType === "omp.thinking");
assert.equal(abruptThinking.length, 1, "a stream ending after thinking_delta must still publish its segment");
assert.equal(abruptThinking[0].message, "last thought before the process stops");

// Regression test 10c: one delta larger than the thinking buffer is cut at the buffer, not after it
const oversizedEvents = [];
const oversizedReporter = createOmpProgressReporter(undefined, async (event) => { oversizedEvents.push(event); });
await oversizedReporter.ingest(JSON.stringify({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(20) + " ".repeat(4000) + "y".repeat(100) },
}));
await oversizedReporter.flush();
assert.equal(oversizedEvents.length, 1, "an oversized delta must publish exactly one thinking event");
assert.equal(
  oversizedEvents[0].message,
  "x".repeat(20) + "\u2026",
  "content past THINKING_BUFFER_CHARS must never reach the published segment",
);

// Regression test 10d: live snippets keep the spaces that separate deltas
const snippetUpdates = [];
const snippetReporter = createOmpProgressReporter(async (update) => { snippetUpdates.push(update); }, undefined);
for (const delta of ["weighing ", "the ", "contract"]) {
  await snippetReporter.ingest(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta },
  }));
}
await snippetReporter.ingest(JSON.stringify({
  type: "tool_execution_start",
  toolCallId: "snippet-1",
  toolName: "bash",
  args: { command: "true" },
}));
assert.equal(snippetUpdates.at(-1).lastAssistantSnippet, "Thinking: weighing the contract");

const textUpdates = [];
const textReporter = createOmpProgressReporter(async (update) => { textUpdates.push(update); }, undefined);
for (const delta of ["weighing ", "the ", "contract"]) {
  await textReporter.ingest(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  }));
}
await textReporter.ingest(JSON.stringify({
  type: "tool_execution_start",
  toolCallId: "snippet-2",
  toolName: "bash",
  args: { command: "true" },
}));
assert.equal(textUpdates.at(-1).lastAssistantSnippet, "weighing the contract");

const cappedEvents = [];
const cappedReporter = createOmpProgressReporter(undefined, async (event) => { cappedEvents.push(event); });
for (let segment = 0; segment < 60; segment += 1) {
  await cappedReporter.ingest(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "reasoning segment " + segment + " " },
  }));
  await cappedReporter.ingest(JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "cap-" + segment,
    toolName: "bash",
    args: { command: "true" },
  }));
}
const cappedThinking = cappedEvents.filter((event) => event.eventType === "omp.thinking");
const capNotices = cappedThinking.filter((event) => event.message.startsWith("Thinking event limit reached"));
assert.equal(capNotices.length, 1, "the thinking cap notice must be published exactly once");
assert.equal(cappedThinking.length, 41, "40 thinking segments plus one cap notice");
assert.equal(cappedThinking.at(-1), capNotices[0]);
for (const event of cappedThinking) assert.ok(event.message.length <= 501, "thinking event content must stay capped");

let brokenSinkCalls = 0;
const brokenReporter = createOmpProgressReporter(undefined, async () => {
  brokenSinkCalls += 1;
  throw new Error("sink down");
});
await brokenReporter.ingest(JSON.stringify({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta: "unreported reasoning" },
}));
await brokenReporter.ingest(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
for (let i = 0; i < 5; i += 1) {
  await brokenReporter.ingest(JSON.stringify({ type: "tool_execution_end", toolCallId: "broken-" + i, toolName: "bash", isError: false }));
}
assert.equal(brokenSinkCalls, 1, "a failed sink must never be called again");
assert.equal(brokenReporter.sawProviderWork(), true);

// Regression test 11: OMP failures map onto Paperclip's retry vocabulary
const quotaFailure = classifyOmpFailure({
  parsedError: "429 rate limit reached; retry-after: 42",
  stderr: "",
  timedOut: false,
  exitCode: 1,
  signal: null,
});
assert.equal(quotaFailure.errorFamily, "provider_quota");
assert.equal(quotaFailure.errorCode, "omp_provider_quota");
assert.ok(Date.parse(quotaFailure.retryNotBefore) > Date.now());
assert.equal(
  classifyOmpFailure({ parsedError: "", stderr: "upstream service unavailable", timedOut: false, exitCode: 1, signal: null }).errorFamily,
  "transient_upstream",
);
assert.equal(
  classifyOmpFailure({ parsedError: "refresh token has expired", stderr: "", timedOut: false, exitCode: 1, signal: null }).errorFamily,
  "refresh_token_expired",
);
assert.deepEqual(
  classifyOmpFailure({ parsedError: "", stderr: "", timedOut: false, exitCode: 3, signal: null }),
  { errorCode: "omp_exit_3", errorFamily: null, retryNotBefore: null },
);

// Regression test 12: Paperclip runtime tools reach OMP through the process environment
const runtimeEnv = {};
const guidance = applyRuntimeToolAccess(
  runtimeEnv,
  {
    version: 1,
    guidance: "Use Paperclip connections before asking a human.",
    mcpEndpoint: "https://paperclip.test/mcp",
    rest: { connectionsSearch: "https://paperclip.test/search", connectionRequest: "https://paperclip.test/request" },
    bearerToken: "rt-token",
    expiresAt: "2026-09-19T12:00:00.000Z",
    tools: ["connections_search", "connection_request"],
  },
  { getServers: () => [{ name: "github", url: "https://paperclip.test/mcp/github", token: "mcp-token", connectionId: "conn-1" }] },
);
assert.equal(runtimeEnv.PAPERCLIP_RUNTIME_TOOLS_TOKEN, "rt-token");
assert.equal(runtimeEnv.PAPERCLIP_CONNECTIONS_SEARCH_URL, "https://paperclip.test/search");
assert.match(runtimeEnv.PAPERCLIP_RUNTIME_MCP_SERVERS, /github/);
assert.equal(JSON.parse(runtimeEnv.PAPERCLIP_RUNTIME_MCP_TOKENS).github, "mcp-token");
assert.match(guidance, /Use Paperclip connections before asking a human\./);
assert.match(guidance, /1 MCP server\(s\)/);
assert.equal(applyRuntimeToolAccess({}, undefined, undefined), "");

// Regression test 13: a run that never reached the provider reports bootstrap evidence
const bootstrap = await run(
  "00000000-0000-4000-8000-000000000018",
  emptyRuntime,
  "BOOTSTRAP_FAIL",
  { ...baseConfig, noSession: true, promptTemplate: "{{context.expected}}" },
);
assert.equal(bootstrap.exitCode, 1);
assert.deepEqual(bootstrap.executionRecovery, { kind: "bootstrap", providerWorkStarted: false });
assert.equal(bootstrap.errorFamily, "transient_upstream");
assert.ok(Date.parse(bootstrap.retryNotBefore) > Date.now());

// Regression test 14: provider-billed cost is reported as the cache-adjusted amount
assert.equal(fresh.cacheAdjustedCostUsd, fresh.costUsd);
assert.ok(fresh.costUsd > 0);

// Regression test 15: omp usage --json becomes a Paperclip provider quota result
const previousQuotaCommand = process.env.PAPERCLIP_OMP_COMMAND;
process.env.PAPERCLIP_OMP_COMMAND = fakeOmp;
try {
  const quota = await getOmpQuotaWindows();
  assert.equal(quota.ok, true, quota.error ?? "quota probe failed");
  assert.equal(quota.provider, "fake-provider");
  assert.equal(quota.source, "omp usage --json");
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0].label, "5 Hour");
  assert.equal(quota.windows[0].usedPercent, 25);
  assert.equal(quota.windows[0].resetsAt, new Date(1789800000000).toISOString());
  assert.equal(quota.windows[0].valueLabel, "25 / 100 percent");
  assert.match(quota.windows[0].detail, /ok/);
} finally {
  if (previousQuotaCommand === undefined) delete process.env.PAPERCLIP_OMP_COMMAND;
  else process.env.PAPERCLIP_OMP_COMMAND = previousQuotaCommand;
}

// Regression test 16: the quota probe never spawns a second OMP process
const argvLog = path.join(root, "fake-omp-argv.log");
const previousArgvLog = process.env.FAKE_OMP_ARGV_LOG;
process.env.FAKE_OMP_ARGV_LOG = argvLog;
const previousQuotaCommand2 = process.env.PAPERCLIP_OMP_COMMAND;
process.env.PAPERCLIP_OMP_COMMAND = fakeOmp;
try {
  const started = Date.now();
  const quota = await getOmpQuotaWindows();
  assert.equal(quota.ok, true, quota.error ?? "quota probe failed");
  assert.ok(Date.now() - started < 20000, "quota probe must settle inside Paperclip's 20s budget");
  const invocations = (await fs.readFile(argvLog, "utf8")).split("\n").filter(Boolean);
  assert.deepEqual(invocations, ["usage --json"], `quota probe spawned: ${invocations.join(" | ")}`);
} finally {
  if (previousQuotaCommand2 === undefined) delete process.env.PAPERCLIP_OMP_COMMAND;
  else process.env.PAPERCLIP_OMP_COMMAND = previousQuotaCommand2;
  if (previousArgvLog === undefined) delete process.env.FAKE_OMP_ARGV_LOG;
  else process.env.FAKE_OMP_ARGV_LOG = previousArgvLog;
}

// Regression test 17: a successful run never claims interruption evidence
assert.equal(fresh.executionRecovery, undefined);
assert.equal(fresh.resultJson.executionCancellation, undefined);

const hugeLogConfig = { ...baseConfig, timeoutSec: 120 };
const huge = await run("00000000-0000-4000-8000-000000000019", emptyRuntime, "HUGE_LOG", hugeLogConfig);
assert.ok(
  huge.resultJson.stdout.length <= 4 * 1024 * 1024,
  "the host caps captured stdout at 4 MiB, so this fixture must exceed the cap",
);
assert.ok(
  !huge.resultJson.stdout.includes("fake-session-1"),
  "the session header must fall outside the captured stdout window for this fixture",
);
assert.equal(huge.exitCode, 0, huge.errorMessage ?? "huge-log execution failed");
assert.equal(huge.sessionId, "fake-session-1", "sessionId must come from the stream, not truncated stdout");
assert.equal(huge.sessionParams?.sessionId, "fake-session-1", "sessionParams must survive a truncated stdout window");
assert.deepEqual(
  huge.usage,
  { inputTokens: 107, outputTokens: 23, cachedInputTokens: 6 },
  "usage must sum the turn before the truncation window and the turn after it",
);
assert.ok(Math.abs(huge.costUsd - 0.012) < 1e-9, "costUsd must include the turn dropped from captured stdout");
assert.equal(huge.resultJson.toolCalls.length, 1, "tool calls before the truncation window must survive");

const hugeAbortController = new AbortController();
const hugeAborted = await adapter.execute({
  runId: "00000000-0000-4000-8000-00000000001a",
  agent,
  runtime: emptyRuntime,
  config: hugeLogConfig,
  context: { expected: "HUGE_LOG_ABORT" },
  onLog: async (stream, chunk) => {
    if (stream === "stdout" && chunk.includes("ABORT_MARKER")) hugeAbortController.abort();
  },
  onMeta: async () => {},
  signal: hugeAbortController.signal,
});
assert.equal(hugeAborted.sessionId, "fake-session-1", "an aborted huge run must still resolve its session");
assert.deepEqual(hugeAborted.executionRecovery, {
  kind: "interrupted",
  providerStopped: true,
  sessionPreserved: true,
  actionOutcomes: "settled",
});
assert.deepEqual(hugeAborted.resultJson.executionCancellation, { state: "acknowledged" });

const steerLog = path.join(root, "rpc-steer.log");
const previousSteerLog = process.env.FAKE_STEER_LOG;
process.env.FAKE_STEER_LOG = steerLog;
const waitForSteering = async (runId) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (adapter.getSteeringState(runId) === "available") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("OMP RPC prompt never became steerable");
};
try {
  const steerRunId = "00000000-0000-4000-8000-00000000001b";
  assert.equal(adapter.getSteeringState(steerRunId), "temporarily_unavailable");
  const steerLogs = [];
  const running = adapter.execute({
    runId: steerRunId, agent, runtime: emptyRuntime, config: { ...baseConfig, noSession: true },
    context: { expected: "STEER_HOLD" },
    onLog: async (stream, chunk) => { if (stream === "stdout") steerLogs.push(chunk); },
  });
  await waitForSteering(steerRunId);
  let acknowledged = 0;
  const steerInput = { runId: steerRunId, message: "change course", correlationId: "comment-42" };
  await assert.rejects(
    () => adapter.steer({ ...steerInput, onAcknowledged: async () => { throw new Error("durable acknowledgement failed"); } }),
    /durable acknowledgement failed/,
  );
  const firstAck = await adapter.steer({ ...steerInput, onAcknowledged: async () => { acknowledged += 1; } });
  const repeatedAck = await adapter.steer({ ...steerInput, onAcknowledged: async () => { acknowledged += 1; } });
  assert.deepEqual(repeatedAck, firstAck);
  assert.equal(acknowledged, 2, "a host retry must replay its durable acknowledgement callback");
  const steeredResult = await running;
  assert.equal(steeredResult.exitCode, 0, steeredResult.errorMessage);
  assert.match(steeredResult.summary, /STEER=change course/);
  assert.equal(steeredResult.usage.outputTokens, 20);
  assert.equal(adapter.getSteeringState(steerRunId), "temporarily_unavailable");
  assert.equal(await fs.readFile(steerLog, "utf8").then((text) => text.trim().split("\n").length), 1);
  assert(!steerLogs.some((line) => /"type":"response"|"type":"ready"|"type":"prompt_result"/.test(line)),
    "RPC control frames must not enter transcript logs");
  assert.deepEqual(await adapter.steer({ ...steerInput, onAcknowledged: async () => { acknowledged += 1; } }), firstAck);
  assert.equal(acknowledged, 3, "a post-settle host retry must reconcile without another RPC write");
  await assert.rejects(
    () => adapter.steer({ ...steerInput, message: "different message" }),
    (error) => error.code === "steering_rejected",
  );

  const rejectedRunId = "00000000-0000-4000-8000-00000000001c";
  const rejectedRunning = adapter.execute({
    runId: rejectedRunId, agent, runtime: emptyRuntime, config: { ...baseConfig, noSession: true },
    context: { expected: "STEER_HOLD" }, onLog: async () => {},
  });
  await waitForSteering(rejectedRunId);
  let rejectedAck = 0;
  await assert.rejects(
    () => adapter.steer({
      runId: rejectedRunId, message: "REJECT_ME", correlationId: "comment-43",
      onAcknowledged: async () => { rejectedAck += 1; },
    }),
    (error) => error.code === "steering_rejected",
  );
  assert.equal(rejectedAck, 0);
  assert.equal(adapter.getSteeringState(rejectedRunId), "available", "rejected steer must not terminate the prompt");
  await adapter.steer({ runId: rejectedRunId, message: "accepted", correlationId: "comment-43" });
  assert.match((await rejectedRunning).summary, /STEER=accepted/);
  assert.equal((await fs.readFile(steerLog, "utf8")).trim().split("\n").length, 2);

  const remoteArgs = buildOmpArgs({
    rpc: false, config: { noSession: true }, systemPrompt: "contract", userPrompt: "REMOTE_PROMPT",
    sessionDir: "/unused", resumeSessionId: null, omitProfile: true, effectiveProfile: null,
  });
  assert.deepEqual(remoteArgs.slice(0, 3), ["--mode", "json", "-p"]);
  assert.equal(remoteArgs.at(-1), "REMOTE_PROMPT");
  assert(!remoteArgs.includes("--no-ui"));
  assert.equal(adapter.getSteeringState("remote-run-with-no-local-rpc-process"), "temporarily_unavailable");
  await assert.rejects(
    () => adapter.steer({ runId: "remote-run-with-no-local-rpc-process", message: "cannot steer remote", correlationId: "remote-1" }),
    (error) => error.code === "steering_temporarily_unavailable",
  );
} finally {
  if (previousSteerLog === undefined) delete process.env.FAKE_STEER_LOG;
  else process.env.FAKE_STEER_LOG = previousSteerLog;
}

await fs.rm(root, { recursive: true, force: true });
console.log("adapter smoke passed");
