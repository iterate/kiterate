# Development Diary

Append-only log of significant changes and decisions.

---

## 2026-01-21 16:15

### Fixed LLM re-triggering loop

**Problem:** Consumer was triggering LLM requests in a loop. After a request completed, it would immediately start another one.

**Root cause:** The trigger condition used `shouldSendLlmRequest: boolean` which stayed true until we processed our own `request-started` event. But older events (like `request-cancelled` from a previous request) would arrive first due to offset ordering, and the boolean was still true.

**Solution:** Replace boolean with offset comparison:

- `llmRequestRequiredFrom: Option<Offset>` - offset of user message needing response
- `llmLastRespondedAt: Option<Offset>` - offset of last request-started (never cleared)
- Trigger when `requiredFrom > lastRespondedAt`

This naturally prevents re-triggering because `request-started` always has a higher offset than the user message that triggered it.

**Key insight:** Don't clear `llmLastRespondedAt` on request-ended/cancelled. It represents "what we've responded to", not "what's currently in flight". In-flight tracking uses local `currentFiber` variable instead.

Added `Offset.gt/gte/lt/lte` comparison utilities to domain.

---

## 2026-01-21 ~15:45

### Switched stream storage from NDJSON to YAML

Changed FileSystem storage format from newline-delimited JSON to YAML documents separated by `---`. More human-readable for debugging sessions.

---

## 2026-01-21 ~15:30

### Added consumer-based architecture

Introduced `SimpleConsumer` abstraction for path-scoped consumers. Each consumer's `run` is called once per path with a `SimpleStream` interface for reading/writing events.

Created `OpenAiSimpleConsumer` that:

- Hydrates conversation history from events
- Triggers OpenAI generation on user messages
- Streams responses back as events
- Supports fiber interruption for cancelling in-flight requests
