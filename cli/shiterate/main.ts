#!/usr/bin/env npx tsx
/**
 * Shiterate CLI - Simple command-line interface for the event stream server
 *
 * Usage:
 *   ./main.ts [--url http://localhost:3001] <agent-path> append <json-event>
 *   ./main.ts [--url http://localhost:3001] <agent-path> stream [--live]
 *
 * Examples:
 *   ./main.ts my-agent append '{"type": "hello", "message": "world"}'
 *   ./main.ts my-agent stream --live
 */

import { stderr, stdout } from "node:process"

const DEFAULT_URL = "http://localhost:3001"

function printUsage() {
  console.error(`
Shiterate CLI - Interact with the event stream server

Usage:
  ./main.ts [--url URL] <agent-path> append <json-event>
  ./main.ts [--url URL] <agent-path> stream [--live] [--offset OFFSET]

Options:
  --url URL        Server URL (default: ${DEFAULT_URL})
  --live           Keep connection open for live updates (SSE)
  --offset OFFSET  Start reading from this offset (default: -1 for beginning)

Commands:
  append <json>    Append a JSON event to the stream
  stream           Subscribe to events from the stream

Examples:
  ./main.ts my-agent append '{"type": "message", "text": "hello"}'
  ./main.ts my-agent stream
  ./main.ts my-agent stream --live --offset -1
  ./main.ts --url http://example.com:3001 my-agent stream --live
`)
}

function buildStreamUrl(baseUrl: string, agentPath: string): string {
  return `${baseUrl}/agents/${encodeURIComponent(agentPath)}`
}

async function appendEvent(baseUrl: string, agentPath: string, jsonData: string) {
  const url = buildStreamUrl(baseUrl, agentPath)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonData)
  } catch {
    stderr.write(`Error: Invalid JSON\n`)
    process.exit(1)
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    })
    if (!res.ok) {
      stderr.write(`Error: ${res.status} ${res.statusText}\n`)
      process.exit(1)
    }
    console.log(`✓ Event appended to ${agentPath}`)
  } catch (error) {
    if (error instanceof Error) {
      stderr.write(`Error appending: ${error.message}\n`)
    }
    process.exit(1)
  }
}

async function streamEvents(baseUrl: string, agentPath: string, live: boolean, offset: string = "-1") {
  const url = new URL(buildStreamUrl(baseUrl, agentPath))
  url.searchParams.set("offset", offset)
  if (live) {
    url.searchParams.set("live", "sse")
  }

  console.error(`Streaming from: ${agentPath}`)
  console.error(`URL: ${url.toString()}`)
  console.error("---")

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: "text/event-stream" },
    })

    if (!res.ok) {
      stderr.write(`Error: ${res.status} ${res.statusText}\n`)
      process.exit(1)
    }

    if (!res.body) {
      stderr.write(`Error: No response body\n`)
      process.exit(1)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Parse SSE events from buffer
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      let currentEvent: { type?: string; data: string[] } = { data: [] }

      for (const line of lines) {
        if (line === "") {
          // Empty line = end of event
          if (currentEvent.type && currentEvent.data.length > 0) {
            const data = currentEvent.data.join("\n")
            if (currentEvent.type === "data") {
              stdout.write(data + "\n")
            }
          }
          currentEvent = { data: [] }
        } else if (line.startsWith("event:")) {
          currentEvent.type = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          const content = line.slice(5)
          currentEvent.data.push(content.startsWith(" ") ? content.slice(1) : content)
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      stderr.write(`Error streaming: ${error.message}\n`)
    }
    process.exit(1)
  }
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage()
    process.exit(0)
  }

  let baseUrl = DEFAULT_URL
  let i = 0

  // Parse --url flag
  if (args[i] === "--url") {
    if (!args[i + 1]) {
      stderr.write("Error: --url requires a value\n")
      process.exit(1)
    }
    baseUrl = args[i + 1]
    i += 2
  }

  // Agent path
  const agentPath = args[i++]
  if (!agentPath) {
    stderr.write("Error: Missing agent-path\n")
    printUsage()
    process.exit(1)
  }

  // Command
  const command = args[i++]

  switch (command) {
    case "append": {
      const jsonData = args[i]
      if (!jsonData) {
        stderr.write("Error: Missing JSON event data\n")
        process.exit(1)
      }
      await appendEvent(baseUrl, agentPath, jsonData)
      break
    }

    case "stream": {
      let live = false
      let offset = "-1"

      while (i < args.length) {
        if (args[i] === "--live") {
          live = true
          i++
        } else if (args[i] === "--offset") {
          if (!args[i + 1]) {
            stderr.write("Error: --offset requires a value\n")
            process.exit(1)
          }
          offset = args[i + 1]
          i += 2
        } else {
          stderr.write(`Error: Unknown option "${args[i]}"\n`)
          process.exit(1)
        }
      }

      await streamEvents(baseUrl, agentPath, live, offset)
      break
    }

    default:
      stderr.write(`Error: Unknown command "${command}". Use "append" or "stream".\n`)
      printUsage()
      process.exit(1)
  }
}

main().catch((error) => {
  stderr.write(`Fatal error: ${error.message}\n`)
  process.exit(1)
})
