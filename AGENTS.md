# AGENTS.md

## Project Basics

This repository is a Manifest V3 Chrome extension named **Visualping Cloud Jobs**.

Primary capabilities:
- Detect Visualping login/session state.
- Create Visualping monitoring jobs from the active tab.
- Suggest monitorable conditions for the current page using Chrome's local Prompt API (`LanguageModel`).
- Generate structured script actions in the side panel and save them to a Visualping job.
- Sync site cookies into Visualping preactions so authenticated pages can be monitored reliably.

## Tech Stack

- Plain JavaScript (no TypeScript, no bundler).
- Chrome Extension APIs: `tabs`, `cookies`, `storage`, `scripting`, `sidePanel`, `permissions`.
- Entry points are loaded directly from source files listed in `manifest.json`.

## Important Files

- `manifest.json`: extension metadata, permissions, host permissions, side panel + popup wiring.
- `background.js`: service worker; main orchestration for popup messages, job CRUD integration, cookie sync, monitor suggestions, side-panel/script-generator launch.
- `popup.html` / `popup.js` / `popup.css`: popup UI for create/jobs/settings workflows.
- `script_generator.html` / `script_generator.js` / `script_generator.css`: side panel UI for generating/validating/saving script actions.
- `lib/config.js`: config loading and caching.
- `lib/visualping.js`: Visualping API calls and payload shaping.
- `lib/storage.js`: tracked job persistence in Chrome storage.
- `lib/constants.js`: shared constants and storage keys.
- `scripts/package-extension.sh`: creates distributable zip in `dist/`.

## Runtime Flow (High Level)

1. Popup loads state from background worker.
2. User can create a job for the active tab URL.
3. Extension requests per-site permission when needed.
4. Background reads site cookies and writes cookie preactions to matching Visualping jobs.
5. Side panel script generator inspects DOM via `chrome.scripting.executeScript`, prompts local model for structured steps, executes steps in-tab, validates, then saves.

## Build / Package

No compile step is required.

Package command:
- `bash scripts/package-extension.sh`

Output:
- `dist/vp-cloud-chrome-ext-<version>.zip`

Package must include:
- `manifest.json`
- JS/HTML/CSS entry files
- `icons/`
- `lib/`

## Development Notes

- Keep changes MV3-compatible and service-worker-safe.
- Prefer minimal permissions and preserve runtime permission prompts.
- Do not hardcode secrets; config is loaded dynamically and cached.
