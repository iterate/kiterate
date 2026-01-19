# Durable Streams Reference Server

A super vanilla durable-streams backend using the official `@durable-streams/server` test server with purely in-memory storage.

## Quick Start

```bash
npm install
npm run start
```

Server runs at `http://127.0.0.1:3000` by default.

## Configuration

- `PORT` - Port to listen on (default: 3000)
- `HOST` - Host to bind to (default: 127.0.0.1)

## Usage

All streams are accessed via the root path. Use `/agents/*` paths for agent streams.

### Create a stream

```bash
curl -X PUT http://localhost:3000/agents/my-agent
```

### Append to a stream

```bash
curl -X POST http://localhost:3000/agents/my-agent \
  -H "Content-Type: application/json" \
  -d '{"type":"message","text":"hello"}'
```

### Read from a stream

```bash
# One-shot read
curl http://localhost:3000/agents/my-agent

# SSE streaming (live updates)
curl "http://localhost:3000/agents/my-agent?offset=-1&live=sse"
```

### Delete a stream

```bash
curl -X DELETE http://localhost:3000/agents/my-agent
```

### Get stream metadata

```bash
curl -I http://localhost:3000/agents/my-agent
```

## Protocol

This server implements the [Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md) - an open protocol for reliable, resumable streaming to client applications.
