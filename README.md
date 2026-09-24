# Paperclip OMP Adapter

[![CI](https://github.com/tickernelz/paperclip-omp-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/tickernelz/paperclip-omp-adapter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40zhafron%2Fpaperclip-omp-adapter.svg)](https://www.npmjs.com/package/@zhafron/paperclip-omp-adapter)
[![license](https://img.shields.io/npm/l/%40zhafron%2Fpaperclip-omp-adapter.svg)](LICENSE)

External Paperclip adapter for running Oh My Pi (OMP) CLI in headless mode with native model discovery, custom providers, resumable local sessions, skills synchronization, multi-workspace support, and structured transcripts.

## Overview

This adapter integrates OMP into Paperclip as an external adapter module (`omp_local`). It communicates with the host Paperclip instance via the `@paperclipai/adapter-utils` contract and parses OMP's non-interactive JSONL event stream into Paperclip transcript entries.

## Feature Matrix

| Feature | Paperclip Integration | OMP CLI Mapping |
|---|---|---|
| Model Discovery | Dynamic model list and badge updates | `omp models --json` and `omp models refresh --json` |
| Execution Mode | Headless execution per heartbeat run | `omp --mode json -p` |
| Session Resume | Resumes conversation across runs | `--session-dir <dir> --resume <id>` |
| Multi-Workspace | Multi-workspace context synchronization | `--add-dir <path>` (repeatable) |
| Thinking / Reasoning | Live transcript streaming plus durable `omp.thinking` run events | `--thinking <level>`, `--print-thoughts` |
| Tool Events | Real-time tool calls, progress updates, durable `omp.tool` run events | Maps `tool_execution_*` to Paperclip entries |
| Skills Integration | Paperclip workspace skills synchronization | Links skills into `~/.omp/agent/skills` |
| Cancellation | Host-driven run abortion | Listens to `ctx.signal` and signals process group |
| Targets | Local and remote execution | Direct spawn, SSH, or managed sandboxes |

## Requirements

- Node.js >= 24.11.0
- Paperclip >= 2026.916.0
- Oh My Pi (OMP) installed in the environment (`omp` executable available in `PATH` or explicitly configured via `command`)

Install OMP globally:

```bash
npm install -g @oh-my-pi/pi-coding-agent@latest
```

## Installation

### Via Paperclip CLI

In a running Paperclip instance, install the adapter using the official package:

```bash
paperclipai adapter install --payload-json '{"packageName":"@zhafron/paperclip-omp-adapter","version":"0.2.3"}' --json
```

To upgrade an existing installation:

```bash
paperclipai adapter reinstall omp_local --json
```

### Verification

Check that the adapter is registered and loaded:

```bash
paperclipai adapter get omp_local --json
```

Verify model discovery for a company:

```bash
paperclipai adapter models omp_local --company-id <company-id> --json
```

## Configuration Reference

The adapter exposes the following configuration schema fields under an agent's adapter configuration:

### Core Execution
- `command` (string): Path to the OMP executable. Default: `omp`.
- `model` (string): Default model selector (e.g., `anthropic/claude-3-7-sonnet`, `openai/gpt-4o`).
- `thinking` (string): Reasoning level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`).
- `printThoughts` (boolean): Stream thinking blocks into the Paperclip transcript (`--print-thoughts`). Default: `true`; `false` passes `--hide-thinking`. Thinking only appears when the selected model actually emits reasoning deltas.
- `profile` (string): Named OMP profile to activate (`OMP_PROFILE`).

### Workspace & Sessions
- `cwd` (string): Working directory override. Defaults to the Paperclip issue workspace.
- `addDirs` (textarea): Additional directory paths passed via repeatable `--add-dir` flags.
- `sessionDir` (string): Directory for storing OMP session state.
- `noSession` (boolean): Set true to disable session resumption (ephemeral execution).
- `allowHome` (boolean): Pass `--allow-home` if working directly in the user home directory.

### Capabilities & Tools
- `tools` (string): Comma-separated list of enabled tool names.
- `noTools` (boolean): Disable default OMP tools.
- `skills` (string): Comma-separated list of explicit skill names to enable.
- `noSkills` (boolean): Disable built-in skills discovery.
- `noRules` (boolean): Skip loading `RULES.md`.
- `approvalMode` (select): Tool execution approval policy (`yolo`, `write`, `always-ask`). Default: `yolo`, always passed as `--approval-mode` so the run never depends on `tools.approvalMode` in the OMP config.

### Diagnostics & Extensions
- `timeoutSec` (number): Maximum wall-clock execution time in seconds before SIGINT. Default: `43200` (12 hours).
- `graceSec` (number): Grace period before SIGKILL after SIGINT. Default: `20`.
- `configFiles` (textarea): Custom `config.yml` overlay paths.
- `extensions` (textarea): Paths to custom OMP extensions.
- `pluginDirs` (textarea): Paths to plugin directories.
- `hooks` (textarea): Paths to hook files.
- `extraArgs` (textarea): Raw additional flags passed to the OMP CLI.

## Development

### Building and Testing

```bash
git clone https://github.com/tickernelz/paperclip-omp-adapter.git
cd paperclip-omp-adapter
npm install
npm run typecheck
npm test
```

### Testing Local Package in Paperclip

Pack the local repository and install the tarball directly into your Paperclip instance:

```bash
TARBALL=$(npm pack)
paperclipai adapter install --payload-json "{\"packageName\":\"$PWD/$TARBALL\",\"version\":\"0.2.3\"}" --json
```

## License

MIT

