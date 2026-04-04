# Workspace & Project Directory Model

AICoder supports two project modes with different workspace strategies.

## Directory Layout (New Project Mode)

When creating a **new** project named `my-app`:

```
~/.aicoder/projects/my-app/
├── .opencode/
│   └── agent/          # Copied agents (AICoder.md, clarify.md, dev.md, ...)
├── schemas/            # Copied JSON schemas
├── workspace/          # 🟢 Where source code lives
│   └── .git/           # Fresh git init
├── logs/               # Runtime logs
└── run-{sessionId}/    # Pipeline stage JSON outputs
    ├── clarify.json
    ├── design.json
    ├── task.json
    ├── dev.json
    ├── test.json
    ├── review.json
    ├── validate.json
    └── status.yaml
```

- `workspace/` is the git worktree for new code
- `run-{sessionId}/` stores immutable pipeline artifacts

## Directory Layout (Existing Project Mode)

When the user provides an existing git repository path (e.g. `/Users/ddy/workspace/my-app`):

```
~/.aicoder/projects/my-app/          # Managed directory
├── .opencode/agent/                 # Copied agents
├── schemas/                         # Copied schemas
├── workspace/                       # 🟢 Git worktree pointing to original repo
│   └── .git                        # Worktree metadata (not a full repo)
└── run-{sessionId}/                 # Pipeline stage JSON outputs

/Users/ddy/workspace/my-app/         # Original repo (untouched)
└── .git/worktrees/...               # Git worktree reference
```

### Why Git Worktree?

Instead of writing directly into the user's existing directory, AICoder creates a **git worktree**:

```bash
git worktree add "{managedDir}/workspace" -b aicoder-my-app
```

Benefits:
- **Original repo stays clean** — no accidental file modifications in the source tree
- **Isolated branch** — each AICoder session gets its own branch for safe experimentation
- **Easy integration** — the user can review the worktree and merge when satisfied

### Branch Naming

- Format: `aicoder-{sanitized-project-name}`
- If the branch already exists, we attach to it instead of creating a new one

### Validation Requirements

For existing project mode, the provided path **must**:
1. Be an absolute path
2. Be an existing directory
3. Be a **git repository** (`git rev-parse --git-dir` must succeed)

If any check fails, the API returns `400 Bad Request` with a descriptive error.

## Pipeline Prompt Context

The primary agent (AICoder) is told:

- **Workspace Directory** = where `@dev` writes code
- **Run Directory** = where stage JSON outputs are saved

This separation ensures:
- Source code and pipeline metadata do not intermingle
- The workspace stays clean for the developer
- Pipeline results are persisted for reporting and debugging
