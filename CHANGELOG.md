# Changelog

## [2.3.0] - 2026-06-04

### Added
- **Cost & Token Tracking** (Roadmap 1.3). Sessions table now carries four cumulative columns (`total_tokens_in`, `total_tokens_out`, `total_tokens_reasoning`, `total_cost_usd`). The data plane's `getMessages` normalises OpenCode's free-form `info.tokens` / `info.cost` blob into a typed `MessageInfoMeta`; the control plane recomputes the cumulative totals on every `message-update` callback (deterministic over-write — no risk of double-counting because the data plane sends the full message list each poll).
- Status page now shows a "Usage" row in the session details table (Tokens In / Out / Reasoning / Cost). Values stream in via the existing WebSocket `progress` event's new `usage` payload and reconcile with the periodic `/api/sessions/:id` poll.
- Report page shows the same usage as a small monospace table when the session has any recorded usage (otherwise the row is omitted so the report stays clean).
- New typed surfaces: `TokenUsage`, `MessageInfoMeta` in `server/shared/types.ts`.

### Changed
- `MessageInfo` now has an optional `info?: MessageInfoMeta` field carrying `tokens` / `cost` / `modelID` / `providerID`. Additive — existing consumers ignore it.
- DB migration now backfills `0` for new `INTEGER` / `REAL` columns on existing rows (defensive against `NULL` in the cumulative math).
- `GET /api/sessions/:id` and `GET /api/sessions/:id/refresh` SELECT and return the four new usage columns.

## [2.2.9] - 2026-06-04

### Added
- **Pipeline resume API** (`POST /api/sessions/:id/resume`): control-plane endpoint that re-attaches a failed session to its data plane so the pipeline picks up from the last completed stage. Pairs with a new "Resume Pipeline" button on the status page that appears whenever a session ends in `failed` state.
- `AgentClient.resumePipeline()` helper that wraps `attachPipeline` with intent-revealing naming for control-plane callers.
- Status page CSS for the new resume action (`.error-actions`, `.action-btn`, `.action-btn-primary`).
- New validation tests covering project-name length boundaries, optional `techStack` semantics, and the new `existingPath` path-sandbox rules.

### Fixed
- **P0 security**: `validateSessionInput` now sandbox-checks the `existingPath` for `mode: "existing"`. It rejects `.` / `..` segments and requires the resolved path to live under the user's home directory. Previously a user could pass `/etc/foo` or `/System/...` and the server would happily run `git worktree add` against it.
- **Project name boundary inconsistency**: `validation.ts` used `length <= 4` (effectively minimum 5) with an error message saying "more than 4 characters", while the constant was named `PROJECT_NAME_MIN_LENGTH = 4`. Tightened the rule to `length < 4` and updated the message to "at least 4 characters" so the constant, the message, and the test expectations all line up.
- **`techStack` is optional**: validation now matches the rest of the codebase (and the prompt itself) — `techStack` is treated as an optional field. The `validation.test.ts` expectations for a required `techStack` were outdated relative to production behaviour and have been corrected.

### Changed
- `package.json` `test` script now also runs `server/validation.test.ts` and `server/db.test.ts` (previously only `tests/e2e-integration.test.ts` ran, so the unit-test drift above went undetected).

## [2.2.8] - 2026-04-06

### Added
- Agent management now supports model selection. When creating/editing an Agent, you can test the OpenCode connection and select models for both main agent and subagents.
- Agents now store `main_model` and `subagent_model` in the database.
- New API endpoint `POST /api/agents/test-connection` to test OpenCode connection and fetch available models.
- Create project page now auto-selects the Agent's configured models when an Agent is chosen.

## [2.2.7] - 2026-04-06

### Fixed
- Removed obsolete `MODE=local` from `.env.example`.
- Changed default `AGENT_PORT` in `.env.example` from 8443 to 2080.

### Changed
- Agents page: added "+ Add OpenCode Runtime" button in the Add Agent modal to auto-fill runtime config and link.

## [2.2.6] - 2026-04-06

### Fixed
- Release assets now correctly include `agents/` and `schemas/` directories required at runtime.

## [2.2.5] - 2026-04-06

### Added
- Release assets now include `README.md` and `start.sh` for easier deployment.
- Release assets now include `.env.example` so users can configure the server out of the box.

## [2.2.4] - 2026-04-06

### Changed
- Release builds now use a dedicated `tsconfig.release.json` with `sourceMap: false`, producing smaller and cleaner release assets.
- GitHub Actions release workflow updated to use `bun run build:release` instead of stripping maps after build.

## [2.2.3] - 2026-04-04

### Fixed
- Data plane now always starts alongside control plane (removed obsolete `MODE=local` guard).
- Fixed P0 auto-complete bug caused by literal `"finish"`/`"stop"` string matching in playbook instructions.
- Filesystem watcher reconnect: existing `*.json` stage files are now processed on `watchPipeline` startup.
- Reattach after control plane restart preserves original pipeline mode from checkpoint instead of defaulting to `standard`.

### Added
- New E2E integration test suite (`tests/e2e-integration.test.ts`) covering health, agent/models, pipeline completion, reconnect, and callback loops.
- GitHub Actions release workflow for automated builds and asset packaging on tag push.
