# OpenSpec Development Mode

> Specification-First Development integrated into the AICoder pipeline.

## What is OpenSpec Mode?

**OpenSpec** is a development workflow where a formal specification (OpenAPI, AsyncAPI, Protocol Buffers, JSON Schema, etc.) serves as the immutable contract. Instead of starting from natural language requirements, the pipeline starts from a **machine-readable spec** and derives implementation, tests, and documentation from it.

This mode is ideal for:
- API-first backends
- Microservice contracts
- Event-driven architectures
- SDK generation projects

## High-Level Flow

```
[User uploads spec]
        ↓
   ┌─────────┐
   │  spec   │  ← Parse & validate the spec
   └────┬────┘
        ↓
   ┌─────────┐
   │  task   │  ← Derive implementation tasks from spec
   └────┬────┘
        ↓
   ┌─────────┐
   │   dev   │  ← Implement code that conforms to spec
   └────┬────┘
        ↓
   ┌─────────┐
   │  test   │  ← Generate & run contract tests from spec
   └────┬────┘
        ↓
   ┌─────────┐
   │ validate│  ← Verify spec compliance (lint + functional)
   └─────────┘
```

In OpenSpec mode, the traditional `clarify` and `design` stages are **replaced** by a single `spec` stage because the spec itself is the clarified requirement and the design document.

## UI Changes

### 1. Create Project Form
Add a new **"Development Mode"** toggle or dropdown:
- **Freeform** (default): 7-stage pipeline starting from text requirements
- **OpenSpec**: Pipeline starts from an uploaded spec

When **OpenSpec** is selected:
- Hide the `requirements` textarea (or make it optional for "additional context")
- Show a **Spec Upload** area (drag-and-drop file, or URL input)
- Show a **Spec Type** selector (auto-detected if possible):
  - OpenAPI 3.x
  - AsyncAPI
  - Protocol Buffers (proto3)
  - JSON Schema
  - GraphQL Schema

### 2. Status Page
- Display **Spec Path** (where the spec was saved in the workspace)
- Show a **Spec Validation** badge (valid / invalid / warnings)
- In the `spec` stage indicator, show a small "preview" of endpoints/types discovered

### 3. Report Page
- Include a **Spec Compliance Score** section
- List generated contract tests and their pass/fail status

## Backend Changes

### 1. Spec Persistence
On session creation:
- Save the uploaded spec to `{projectDir}/workspace/specs/contract.{yaml|json|proto}`
- Record `spec_type` and `spec_path` in the database (`sessions` table)

### 2. New Sub-Agent: `@spec`
Create `agents/spec.md`:

```markdown
---
description: Parses and validates a formal API/spec contract and produces a structured implementation blueprint
mode: secondary
permission: allow
---

You are the **Spec Agent**. Your job is to:
1. Read the provided spec file from the workspace
2. Validate it (check syntax, references, and basic semantic correctness)
3. Extract a structured blueprint containing:
   - List of endpoints / operations / messages
   - Data models (schemas, DTOs)
   - Authentication & authorization requirements
   - Error response patterns
   - Dependencies (databases, external services)
4. Produce a concise summary that the @task agent can use to plan implementation

Output format: strict JSON
{
  "valid": true | false,
  "errors": [],
  "blueprint": {
    "endpoints": [...],
    "models": [...],
    "security": {...},
    "dependencies": [...]
  },
  "summary": "..."
}
```

### 3. Pipeline Template: `openspec`
Add `templates/openspec.json`:

```json
{
  "name": "openspec",
  "stages": ["spec", "task", "dev", "test", "validate"],
  "description": "Specification-first pipeline for API and contract-driven projects"
}
```

`server/pipeline.ts` must support variable stage lists. The prompt builder should read the template and tell AICoder which stages to run in order.

### 4. Test Agent Enhancement for Contract Testing
Enhance `agents/test.md` (or create `agents/spec-test.md`) to:
- Read the original spec
- Generate contract tests using tools like:
  - **OpenAPI**: `schemathesis`, `Dredd`, `Portman`, or custom jest+`openapi-schema-validator`
  - **AsyncAPI**: `asyncapi-cli` validation + custom event tests
  - **Protobuf**: `buf lint` + `buf breaking`
- Run the generated tests against the running implementation
- Report coverage of spec compliance

### 5. Dev Agent Enhancement
Update `agents/dev.md` to include:
- "You MUST implement code that satisfies the provided spec in `{workspaceDir}/specs/contract.*`"
- "You SHOULD generate boilerplate from the spec when appropriate (e.g. route handlers, types, validation middleware)"

## Integration Points

### Spec Parser Service
To avoid relying solely on the LLM for spec parsing, introduce a lightweight parser service:

```typescript
// server/spec-parser.ts
export async function parseSpec(path: string, type: SpecType): Promise<SpecSummary> {
  switch (type) {
    case 'openapi':
      return parseOpenAPI(path);
    case 'asyncapi':
      return parseAsyncAPI(path);
    case 'protobuf':
      return parseProtobuf(path);
    // ...
  }
}
```

Use libraries like:
- `@apidevtools/swagger-parser` for OpenAPI
- `@asyncapi/parser` for AsyncAPI
- `protobufjs` for Protobuf

The parser pre-computes a `spec-summary.json` that the `@spec` agent can validate and refine, rather than doing raw text analysis from scratch.

### Contract Test Generator
```typescript
// server/contract-test-gen.ts
export async function generateContractTests(specPath: string, type: SpecType, outputDir: string) {
  // Generates test files into outputDir based on spec type
}
```

Example: For OpenAPI, generate a Jest test suite that iterates over all `paths` and verifies:
- Each path has a corresponding route handler
- Request/response schemas match the spec
- Required status codes exist

## Database Schema Additions

```sql
ALTER TABLE sessions ADD COLUMN spec_type TEXT;
ALTER TABLE sessions ADD COLUMN spec_path TEXT;
ALTER TABLE session_inputs ADD COLUMN dev_mode TEXT DEFAULT 'freeform'; -- 'freeform' | 'openspec'
```

## Implementation Checklist

- [ ] Add `agents/spec.md` sub-agent
- [ ] Add `templates/openspec.json` pipeline template
- [ ] Refactor `server/pipeline.ts` to accept dynamic stage lists from templates
- [ ] Build `server/spec-parser.ts` with OpenAPI support (MVP)
- [ ] Build `server/contract-test-gen.ts` for OpenAPI (MVP)
- [ ] Update frontend create form with mode toggle and spec upload
- [ ] Update status/report pages to show spec metadata
- [ ] Update `agents/dev.md` and `agents/test.md` to reference the spec when in OpenSpec mode
- [ ] Add validation: reject unsupported spec types with clear error messages

## Success Criteria

A user should be able to:
1. Upload an `openapi.yaml` file on the create page
2. See the pipeline run: `spec → task → dev → test → validate`
3. Find generated boilerplate code in the workspace that matches the spec
4. Find generated contract tests that verify spec compliance
5. See a "Spec Compliance" score in the final report
