# External OpenCode Server Support

AICoder connects to OpenCode through the data plane. Users manage one or more **Agents** via `agents.html`. Each Agent record stores the OpenCode URLs, and the data plane connects directly to the OpenCode server when running a pipeline.

Under the hood, the data plane talks to either:
- A **local temporary** `opencode serve` process (auto-spawned on a random port)
- An **external** OpenCode server provided by the user (e.g. `http://127.0.0.1:4096`)

---

## Remote Mode (Default)

In Remote mode, the **Control Plane** (`:8080`) does not talk to OpenCode directly. Instead:

1. The user creates an **Agent** in `agents.html` with these fields:
   - **Name** — human-readable label (e.g. "Local OpenCode")
   - **Agent URL** — data-plane-to-control callback URL (usually `http://localhost:2080` when using the bundled data plane)
   - **OpenCode Local URL** — data-plane-to-OpenCode internal URL (e.g. `http://127.0.0.1:4096`)
   - **OpenCode Public URL** — public-facing OpenCode URL used for frontend links (e.g. `http://127.0.0.1:4096` or a custom domain)
2. On the project creation form (`/create.html`), the user **selects an Agent** from a dropdown instead of typing URLs.
3. When a session starts, the control plane passes the selected Agent's `opencode_local_url` to the data plane, which creates the OpenCode session and dispatches the playbook.

### Why two OpenCode URLs?

| Field | Purpose | Example |
|-------|---------|---------|
| `opencode_local_url` | Where the **data plane** connects internally. May be a private/container address. | `http://127.0.0.1:4096` |
| `opencode_public_url` | Where the **frontend** links users to. May be a public domain or reverse proxy. | `http://127.0.0.1:4096` |

This split allows the data plane to run inside a container or VPN while the frontend still generates clickable links that work from the user's browser.

---

## Behavior Differences

| Aspect | Local Temp Process | External Server |
|--------|-------------------|-----------------|
| Process spawn | Yes (random port 20000-30000) | No |
| Auto-shutdown on completion | Yes | No |
| Health check | Implicit (wait for stdout ready) | Should be explicit |
| `x-opencode-directory` header | Sent | Sent |
| SSE events | Subscribed | Subscribed |

---

## Critical Bug Fixed

There was a bug where `executePipeline()` internally called `OpenCodeManager.getOrCreate(projectDir)` **even when an external server was configured**. This caused a **duplicate local `opencode serve` process** to spawn for every external session.

### Fix

`ExecutePipelineOptions` now requires a `client: OpenCodeClient` parameter:

```typescript
export interface ExecutePipelineOptions {
  sessionId: string;
  opencodeSessionId: string;
  userInput?: string;
  workspaceDir: string;
  projectDir: string;
  client: OpenCodeClient;   // <-- injected by caller
  agentsDir?: string;
  model?: string;
}
```

The caller (data plane) creates the correct client **once** and passes it into the pipeline:

```typescript
// External
const { client } = OpenCodeManager.getOrCreateExternal(projectDir, opencodeUrl, { extraHeaders, auth });

// Local temp process
const { client } = await OpenCodeManager.getOrCreate(projectDir);

// Pipeline uses the same client
executePipeline({ ..., client });
```

---

## OpenCodeManager State Tracking

`OpenCodeManager` tracks which directories use external vs. local processes:

- `processes: Map<string, OpenCodeProcess>` — local only
- `externalDirs: Set<string>` — marks directories as external

When `shutdown(projectDir)` is called:
- Local processes are killed and removed
- External clients are simply removed from the map (the external server stays running)

---

## When to use an external server

- You want to reuse an already-warm OpenCode process
- You want to inspect/debug OpenCode behavior independently
- You want to avoid the ~2-5s startup time of spawning a new process per project
- You run OpenCode in a container or on a remote host and want AICoder to connect to it
