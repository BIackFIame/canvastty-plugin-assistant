# CanvasTTY Assistant

> **Requires the CanvasTTY core with plugin API v2** (plugin services, launch contributors, session environments, decision hooks, plugin tools and card actions, and the `profile`/`canAsk` decide fields): the upcoming release after 1.7.0. CanvasTTY 1.7.0 and earlier do not have these extension points, so installing it there fails the manifest check.

[English](README.md) · [Русский](README.ru.md)

The Assistant («Помощник») for [CanvasTTY](https://github.com/howdeploy/CanvasTTY): a small decision model that
reviews agents' commands before they run, triages the task you give a card, and advises orchestrators. It is off
until you turn it on in its settings page; while off it answers nothing and calls nothing.

## What it does

- **Command review** (decision hook). Before a local agent's shell command or file write runs, CanvasTTY's base
  protection answers first; then the Assistant: a read-only allow list (`git status`, `ls`, `rg`…), a small model's
  nine yes/no questions about the command, and on a disputed case a larger second model that also reads the scripts
  or diff the command runs; otherwise you. A script the agent wrote in this session is never allowed without you.
- **Modes** per use case: Off, Learning (answers are only recorded), Suggest (shown as a card badge, nothing
  enforced), Auto (may ask you or decline; allows only outcomes that qualified on your own ✓/✗ labels, and only when
  you let the plugin allow in CanvasTTY). Every error, timeout or missing key ends with you deciding, never in an allow.
- **Launch triage**: type the card's task in the launcher (Advanced → Use CanvasTTY Assistant). The Assistant reads
  it, marks risky tasks for strict review and shows its advice as a badge (difficulty, category, worktree or
  container, strong model).
- **Orchestrator tools**: `canvastty-assistant__recommend` (advice before `spawn_agent`) and
  `canvastty-assistant__review_status`.
- **Agents that cannot ask**: only Claude Code can put a question in front of you from the hook. For every other agent
  an Auto review that would ask you answers a deny with its reason and what to do instead; a review that could not
  finish in a card whose profile still asks you (normal, plan) leaves the call to the CLI's own prompt.
- YOLO and isolation are CanvasTTY's own rules (your acknowledgement per CLI, the isolation layer for non-manual
  agents); the former "YOLO only isolated" option, which counted a worktree as isolated, is gone.
- **Data checks**: Strict, Warn only or Off; what may leave this computer (code facts only, texts up to D1 or D2);
  your trust per remote model. A local Ollama model gets everything; keys are redacted before anything is sent.

## Decision models

- **Jev** through TypeSafe, OpenRouter (zero data retention enforced) or Vercel: needs a key.
- **Laya** and an **Eikos** `serve.py` server on your computer or over https.
- **Ollama**: any local instruct model (for example `qwen3.5:9b`), read through its option-letter logprobs; a larger
  local model (for example `gpt-oss:20b`) as the second reviewer.

Keys are written from the settings page straight into the plugin's secrets and never shown again; only the service
reads them, at call time, bound to the address they were saved for, and CanvasTTY masks them in everything agents read.
**Check** («Проверить») runs a fixed synthetic battery (no data of yours).

## Limits

- Budgets per minute, per day and in USD per day for cloud calls. A cloud call holds an upper estimate of its cost
  against the USD cap while it runs, so parallel calls cannot pass the cap together; the real cost replaces it.
- A failing model server opens a circuit breaker; late answers to calls admitted before it opened change nothing, and
  only the one probe call closes it again.
- A model server on this computer (loopback, confirmed local) gets one request at a time with a queue of 4; the
  second reviewer shares that slot.
- Memory: statistics keep what the log keeps (`logRetentionDays`, at most 100 000 decisions); per-session review state
  is kept for at most 512 sessions, least recently used dropped first.
- Between the service and CanvasTTY a frame is at most 1 MiB, a host call fails after 30 s or past 64 in flight, and
  while CanvasTTY is not reading, waiting events and logs are capped at 8 MiB (answers are never dropped).

## Needs

CanvasTTY with plugin services and the Assistant extension points (`secrets.get` for services, `decide.timeoutMs`,
the `profile` and `canAsk` decide fields). Trust the plugin's native code in Settings → Agents → Extension native code, and turn on
**May allow agent actions** if the Assistant may allow commands on its own.

## Build

```sh
npm install        # esbuild, typescript
npm run build      # bundles services/assistant.mjs and settings/assistant.js, stamps the manifest
npm test
```
