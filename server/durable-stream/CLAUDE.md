# durable-stream

Effect-native event streaming infrastructure with AI integration.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HTTP Layer                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  GET /agents/:path?offset=X&live=true  →  SSE stream                │    │
│  │  POST /agents/:path                    →  append event              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           StreamManager                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  agentLayer (decorator)                                             │    │
│  │  ├─ Intercepts append() for config/prompt events                    │    │
│  │  ├─ Triggers AI generation on user messages                         │    │
│  │  └─ Streams AI responses back as events                             │    │
│  │         │                                                           │    │
│  │         ▼                                                           │    │
│  │  liveLayer (core implementation)                                    │    │
│  │  └─ Manages per-path EventStream instances                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                        │                           │
                        ▼                           ▼
┌──────────────────────────────────┐  ┌────────────────────────────────────────┐
│         StreamStorage            │  │              AiClient                   │
│  ┌────────────────────────────┐  │  │  ┌────────────────────────────────────┐│
│  │  fileSystemLayer           │  │  │  │  OpenAI (LanguageModel)            ││
│  │  └─ .data/streams/*.yaml   │  │  │  │  └─ gpt-4o via @effect/ai          ││
│  │  └─ Offset tracking        │  │  │  ├────────────────────────────────────┤│
│  ├────────────────────────────┤  │  │  │  Grok (GrokVoiceClient)            ││
│  │  inMemoryLayer (testing)   │  │  │  │  └─ WebSocket to api.x.ai          ││
│  └────────────────────────────┘  │  │  │  └─ Audio + text support           ││
└──────────────────────────────────┘  │  └────────────────────────────────────┘│
                                      └────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                            EventStream                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  append() ──┬──▶ Storage.append() (persist)                         │    │
│  │             └──▶ PubSub.publish() (broadcast)                       │    │
│  │                                                                     │    │
│  │  subscribe() ──▶ Storage.read() (history)                           │    │
│  │              └──▶ PubSub.stream() (live, deduplicated)              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Layer Composition (main.ts)

```
ServerLive(port)
└─ AppLive
   └─ StreamManager.agentLayer
      └─ StreamManager.liveLayer
         ├─ StreamStorage.fileSystemLayer(".data/streams")
         │  └─ NodeContext.layer
         └─ AiClient.layer
            ├─ LanguageModel (OpenAI)
            │  └─ OpenAiClient.layer
            └─ GrokVoiceClient.Default
               └─ GrokVoiceConfig.defaultLayer
```

## Data Flow

### Append (POST)

```
Client POST → appendHandler → agentLayer.append()
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              config event?    prompt event?    other event
                    │               │               │
                    ▼               ▼               ▼
             update model    trigger AI gen    inner.append()
                    │               │
                    │               ▼
                    │         AiClient.prompt()
                    │               │
                    │               ▼
                    │         Stream response events
                    │               │
                    └───────────────┼───────────────┘
                                    ▼
                            inner.append() for each
                                    │
                                    ▼
                            Storage + PubSub
```

### Subscribe (GET)

```
Client GET → subscribeHandler → StreamManager.subscribe()
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
              Historical                               Live (if enabled)
              Storage.read(after: offset)              PubSub.subscribe()
                    │                                       │
                    └───────────────────┬───────────────────┘
                                        ▼
                               Deduplicate (via Ref)
                                        │
                                        ▼
                               Stream.map(Sse.data)
                                        │
                                        ▼
                               SSE Response
```

## Domain Types

| Type         | Description                                                            |
| ------------ | ---------------------------------------------------------------------- |
| `StreamPath` | Branded string, e.g. `"agent/session-123"`                             |
| `Offset`     | Branded string, zero-padded numeric for ordering                       |
| `EventType`  | Branded string, e.g. `"iterate:agent:action:send-user-message:called"` |
| `EventInput` | `{ type, payload, version? }` - what clients send                      |
| `Event`      | EventInput + `{ offset, createdAt }` - what storage returns            |

## Key Event Types

| Event Type                                      | Trigger                                               |
| ----------------------------------------------- | ----------------------------------------------------- |
| `iterate:agent:config:set`                      | Switch AI model (`payload.model: "openai" \| "grok"`) |
| `iterate:agent:action:send-user-message:called` | User message, triggers AI                             |
| `iterate:openai:response:sse`                   | OpenAI streaming response chunk                       |
| `iterate:grok:response:sse`                     | Grok streaming response event                         |

## Storage Format

Events stored as YAML documents in `.data/streams/{path}.yaml`:

```yaml
type: "iterate:agent:action:send-user-message:called"
payload:
  content: "Hello"
offset: "0000000000000001"
createdAt: "2026-01-20T12:00:00.000Z"
version: "1"
---
type: "iterate:openai:response:sse"
payload:
  part: "Hi there!"
offset: "0000000000000002"
createdAt: "2026-01-20T12:00:00.100Z"
version: "1"
```

Offset counter tracked separately in `.data/streams/{path}.yaml.offset`.

## Service Patterns

Services follow the Effect Context.Tag pattern:

```typescript
// Definition
export class StreamManager extends Context.Tag("@app/StreamManager")<
  StreamManager,
  {
    readonly subscribe: (input: {...}) => Stream.Stream<Event, Error>;
    readonly append: (input: {...}) => Effect.Effect<void, Error>;
  }
>() {}

// Layer
export const liveLayer = Layer.effect(StreamManager, make);

// Usage
const manager = yield* StreamManager;
yield* manager.append({ path, event });
```
