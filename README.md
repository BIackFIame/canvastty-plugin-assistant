# CanvasTTY Assistant

> **Status: preview.** This plugin needs CanvasTTY plugin API v2 (plugin services, launch contributors, session environments, decision hooks, plugin tools and card actions). Those extension points are proposed upstream and are not in a released CanvasTTY yet, so installing it on a current release fails the manifest check.

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
