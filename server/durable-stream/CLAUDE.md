# durable-stream

Effect-native event streaming infrastructure with AI integration.

## Architecture

```mermaid
graph TB
    subgraph HTTP["HTTP Layer"]
        GET["GET /agents/:path?offset&live → SSE"]
        POST["POST /agents/:path → append"]
    end

    subgraph SM["StreamManager"]
        AL["agentLayer (decorator)"]
        LL["liveLayer (core)"]
        AL -->|wraps| LL
    end

    subgraph Storage["StreamStorage"]
        FS["fileSystemLayer<br/>.data/streams/*.yaml"]
        IM["inMemoryLayer (testing)"]
    end

    subgraph AI["AiClient"]
        OAI["OpenAI<br/>gpt-4o via @effect/ai"]
        GROK["Grok<br/>WebSocket to api.x.ai"]
    end

    subgraph ES["EventStream"]
        APP["append() → Storage + PubSub"]
        SUB["subscribe() → History + Live"]
    end

    HTTP --> SM
    LL --> Storage
    LL --> AI
    LL --> ES
```

## Layer Composition

```mermaid
graph TB
    SL["ServerLive(port)"] --> AL["AppLive"]
    AL --> AGL["StreamManager.agentLayer"]
    AGL --> LL["StreamManager.liveLayer"]
    LL --> SSL["StreamStorage.fileSystemLayer"]
    SSL --> NC["NodeContext.layer"]
    LL --> AIC["AiClient.layer"]
    AIC --> LM["LanguageModel (OpenAI)"]
    LM --> OAC["OpenAiClient.layer"]
    AIC --> GVC["GrokVoiceClient.Default"]
    GVC --> GVCfg["GrokVoiceConfig.defaultLayer"]
```

## Data Flow: Append (POST)

```mermaid
sequenceDiagram
    participant C as Client
    participant H as HTTP Handler
    participant A as agentLayer
    participant I as inner (liveLayer)
    participant AI as AiClient
    participant S as Storage + PubSub

    C->>H: POST /agents/:path
    H->>A: append(event)

    alt Config Event
        A->>A: Update model selection
        A->>I: append(event)
    else Prompt Event
        A->>I: append(event)
        A->>AI: prompt(model, input)
        loop Stream Response
            AI-->>A: EventInput
            A->>I: append(response)
        end
    else Other Event
        A->>I: append(event)
    end

    I->>S: Storage.append() + PubSub.publish()
```

## Data Flow: Subscribe (GET)

```mermaid
sequenceDiagram
    participant C as Client
    participant H as HTTP Handler
    participant SM as StreamManager
    participant ES as EventStream
    participant S as Storage
    participant PS as PubSub

    C->>H: GET /agents/:path?offset&live
    H->>SM: subscribe(path, offset, live)
    SM->>ES: subscribe()

    par Historical Events
        ES->>S: read(after: offset)
        S-->>ES: Stream[Event]
    and Live Events (if enabled)
        ES->>PS: subscribe()
        PS-->>ES: Stream[Event]
    end

    ES->>ES: Deduplicate via Ref
    ES-->>H: Stream[Event]
    H-->>C: SSE Response
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
