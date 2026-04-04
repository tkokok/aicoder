# External OpenCode Server Support

AICoder can connect to either:
1. A **local temporary** `opencode serve` process (auto-spawned)
2. An **external** OpenCode server provided by the user (e.g. `http://localhost:4096`)

## User-Facing Configuration

In the project creation form (`/create.html`), users can optionally provide:

- **OpenCode URL** — external server endpoint
- **Custom Header** — extra HTTP headers in `Key: Value` format
- **Username / Password** — Basic Auth credentials

## Behavior Differences

| Aspect | Local Temp Process | External Server |
|--------|-------------------|-----------------|
| Process spawn | Yes (random port 20000-30000) | No |
| Auto-shutdown on completion | Yes | No |
| Health check | Implicit (wait for stdout ready) | Should be explicit |
| `x-opencode-directory` header | Sent | Sent |
| SSE events | Subscribed | Subscribed |

## Critical Bug Fixed

There was a bug where `executePipeline()` internally called `OpenCodeManager.getOrCreate(projectDir)` **even when an external server was configured**. This caused a **duplicate local `opencode serve` process** to spawn for every external session.

### Fix

`ExecutePipelineOptions` now requires a `client: OpenCodeClient` parameter:

```typescript
export interface ExecutePipelineOptions {
  sessionId: string;
  opencodeSessionId: string;
  userInput: string;
  workspaceDir: string;
  projectDir: string;
  client: OpenCodeClient;   // <-- injected by routes.ts
  agentsDir?: string;
  model?: string;
}
```

`routes.ts` creates the correct client (external or local) **once** and passes it into the pipeline:

```typescript
// External
const { client } = OpenCodeManager.getOrCreateExternal(projectDir, opencodeUrl, { extraHeaders, auth });

// Local
const { client } = await OpenCodeManager.getOrCreate(projectDir);

// Pipeline uses the same client
executePipeline({ ..., client });
```

## OpenCodeManager State Tracking

`OpenCodeManager` tracks which directories use external vs. local processes:

- `processes: Map<string, OpenCodeProcess>` — local only
- `externalDirs: Set<string>` — marks directories as external

When `shutdown(projectDir)` is called:
- Local processes are killed and removed
- External clients are simply removed from the map (the external server stays running)

## Recommended External Server Setup

For development, users can run a standalone OpenCode server:

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

Then in AICoder's create form, set:
- **OpenCode URL**: `http://127.0.0.1:4096`

This is useful when:
- You want to reuse an already-warm OpenCode process
- You want to inspect/debug OpenCode behavior independently
- You want to avoid the ~2-5s startup time of spawning a new process per project
