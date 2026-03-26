# Architecture & Design Decisions

This document explains *why* the project is structured this way, not just *what* it does. Read this before making structural changes.

---

## Why no framework?

Frameworks like LangChain and LangGraph solve real problems — but only at a scale of complexity this project doesn't need yet. The cost they extract upfront is:

- A new conceptual vocabulary to learn (chains, graphs, nodes, edges, runnables)
- A layer of abstraction that makes debugging harder
- Dependency on a fast-moving library with frequent breaking changes
- Performance overhead from middleware you didn't ask for

The agent loop in its simplest form is ~60 lines of TypeScript. There is no complexity hiding in there that justifies a framework. When this project grows to the point where LangGraph's stateful graph or checkpoint/resume would genuinely help, it will be obvious — and the clean layer separation here will make migration straightforward.

Reference: nanobot (~4k lines Python, zero framework dependencies) proves a production-capable agent doesn't need one.

---

## Why Anthropic's message format internally?

The internal `Message` type mirrors Anthropic's native format:
- `tool_result` lives as a content block inside a `user` message
- `tool_use` lives as a content block inside an `assistant` message

This is more expressive than OpenAI's format (where tool results are `role: 'tool'` messages). The `openai.ts` adapter converts in both directions so the rest of the codebase never thinks about this difference.

If we had used OpenAI's format internally, we'd have to special-case Anthropic's richer block types everywhere.

---

## Why JSONL for session storage?

Three reasons:

1. **Append-only writes are safe.** A crash mid-write corrupts at most one line, not the whole session. You can replay from any point.
2. **No query needs.** Sessions are always loaded in full by ID. There's no "find sessions where..." use case yet.
3. **Human-readable.** You can `cat sessions/my-session.jsonl | jq` to debug a session without any tooling.

SQLite would add a dependency, a schema migration story, and connection management for no benefit at this scale. If the project grows to need concurrent writes or cross-session queries, switching to SQLite is straightforward because `store.ts` is isolated behind the `SessionManager` interface.

---

## Why prune by message count, not token count?

Accurate token counting requires either calling the API (latency + cost) or running a local tokenizer (dependency). Message count is a reasonable proxy and free to compute. The `MAX_CONTEXT_MESSAGES` default of 40 is conservative — at typical message lengths, 40 messages is well under 100k tokens for any current model.

When token-accurate pruning matters (very long tool outputs, large documents), replace `prune()` in `session/manager.ts` only — the interface doesn't change.

---

## Why two transports instead of one?

CLI and HTTP solve different needs:

- **CLI** is for development, debugging, and personal use. Zero setup, immediate feedback, readable output.
- **HTTP** is for integration — Aurora or any other service calling the agent as a microservice.

They are thin wrappers around the same `runAgent()` function. The agent loop has no idea which transport is active. This is the right separation: transport concerns (request parsing, response serialisation, connection handling) never leak into agent logic.

---

## The provider abstraction

```
ENV: LLM_PROVIDER=anthropic | ark
         ↓
createLLMClient(provider)
         ↓
returns: LLMClient (interface)
         ↓
agent loop calls: client.chat(messages, tools)
```

The loop never imports `AnthropicClient` or `ArkClient` directly. It receives an `LLMClient` instance. This means:

- Switching providers is one env var change, zero code change
- Adding a third provider (e.g. local Ollama) means adding one file in `src/llm/` and one branch in `index.ts`
- Testing the loop with a mock LLM is trivial (pass a mock that implements `LLMClient`)

---

## Tool system design

Tools are data, not classes. A `Tool` is:
```
{ schema: ToolSchema, handler: AsyncFunction }
```

The `ToolRegistry` is a `Map<name, Tool>`. Registration is explicit — there's no auto-discovery, no decorators, no magic. Every tool the agent can use appears in `src/index.ts` as a `registry.register(...)` call.

This makes the agent's capabilities auditable at a glance. You open `index.ts`, you see exactly what it can do.

---

## Error handling philosophy

Three categories of errors:

**Infrastructure errors** (network failure, disk full, API rate limit): let them throw. The transport layer catches them and returns an appropriate error response to the user. Do not retry inside the agent loop — retry belongs in the transport or a future resilience layer.

**Tool errors** (tool handler throws): catch inside `ToolRegistry.dispatch()`, return the error message as the tool result string. The LLM sees the error and can decide how to handle it (retry with different input, explain to user, etc.). This is intentional — the LLM is a better error handler than hardcoded retry logic.

**Loop errors** (max iterations exceeded, malformed response): throw `AgentLoopError`. These indicate a bug or an adversarial prompt, not a recoverable situation.

---

## What comes after Phase 6

These are not in scope for the current build but are designed for:

**Phase 7 — Intelligence layer** (from claw0 s06)
System prompt assembly from files on disk: `SOUL.md`, `IDENTITY.md`, `SKILLS.md`. Swap files, change personality. The `SessionManager` already has a slot for a system message at `messages[0]`.

**Phase 8 — Streaming**
`LLMClient.chat()` becomes `LLMClient.stream()`, returning an `AsyncIterable<string>`. The HTTP transport pipes chunks to the client via SSE or chunked transfer. CLI transport prints tokens as they arrive. No other code changes.

**Phase 9 — Resilience** (from claw0 s09)
3-layer retry: auth rotation (multiple API keys), context overflow compaction (summarise old messages instead of dropping), tool-use retry loop.

**Phase 10 — Concurrency** (from claw0 s10)
Named lanes per session ID. Multiple requests for the same session serialize automatically. Different sessions run concurrently.