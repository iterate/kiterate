# durable-stream

Effect-native event streaming infrastructure with AI integration.

## Architecture

```
                            HTTP Layer
  +----------------------------------------------------------+
  |  GET  /agents/:path?offset&live  →  SSE stream           |
  |  POST /agents/:path              →  append event         |
  +----------------------------------------------------------+
                                |
                                v
                         StreamManager
  +----------------------------------------------------------+
  |  agentLayer (decorator)                                  |
  |    - Intercepts append() for config/prompt events        |
  |    - Triggers AI generation on user messages             |
  |    - Streams AI responses back as events                 |
  |                         |                                |
  |                         v                                |
  |  liveLayer (core)                                        |
  |    - Manages per-path EventStream instances              |
  +----------------------------------------------------------+
                  |                       |
                  v                       v
        StreamStorage                 AiClient
  +---------------------+    +---------------------------+
  |  fileSystemLayer    |    |  OpenAI (LanguageModel)   |
  |    .data/streams/   |    |    gpt-4o via @effect/ai  |
  |    *.yaml files     |    +---------------------------+
  +---------------------+    |  Grok (GrokVoiceClient)   |
  |  inMemoryLayer      |    |    WebSocket to api.x.ai  |
  |    (for testing)    |    |    Audio + text support   |
  +---------------------+    +---------------------------+

                          EventStream
  +----------------------------------------------------------+
  |  append()     →  Storage.append() + PubSub.publish()     |
  |  subscribe()  →  Storage.read() + PubSub.stream()        |
  +----------------------------------------------------------+
```

## Layer Composition

```
ServerLive(port)
 └─ AppLive
     └─ StreamManager.agentLayer
         ├─ StreamManager.liveLayer
         │   └─ StreamStorage.fileSystemLayer
         │       └─ NodeContext.layer
         └─ AiClient.layer
             ├─ LanguageModel (OpenAI)
             │   └─ OpenAiClient.layer
             └─ GrokVoiceClient.Default
                 └─ GrokVoiceConfig.defaultLayer
```

## Data Flow

### Append (POST)

```
Client POST
    |
    v
appendHandler
    |
    v
agentLayer.append()
    |
    +-- config event? -----> update model selection
    |                              |
    +-- prompt event? -----> AiClient.prompt()
    |                              |
    |                        stream responses
    |                              |
    +-- other event                |
    |                              |
    v                              v
inner.append() <------------------+
    |
    v
Storage.append() + PubSub.publish()
```

### Subscribe (GET)

```
Client GET
    |
    v
subscribeHandler
    |
    v
StreamManager.subscribe()
    |
    v
EventStream.subscribe()
    |
    +------------------+
    |                  |
    v                  v
Historical         Live (if enabled)
Storage.read()     PubSub.subscribe()
    |                  |
    +--------+---------+
             |
             v
      Deduplicate (Ref)
             |
             v
      Stream.map(Sse.data)
             |
             v
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

| Event Type                                      | Trigger                                                    |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `iterate:agent:config:set`                      | Switch AI model (`payload.model: "openai" \| "grok"`)      |
| `iterate:agent:action:send-user-message:called` | User message, triggers AI                                  |
| `iterate:openai:response:sse`                   | OpenAI streaming response chunk                            |
| `iterate:grok:response:sse`                     | Grok streaming response event                              |
| `iterate:ai:error`                              | AI error (unsupported input, connection/generation failed) |

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
