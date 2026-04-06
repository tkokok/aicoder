# Changelog

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
