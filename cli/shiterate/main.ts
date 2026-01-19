#!/usr/bin/env npx tsx
/**
 * Shiterate CLI - Simple command-line interface for the durable stream server
 *
 * Usage:
 *   ./main.ts [--url http://localhost:3001] <agent-path> append <json-event>
 *   ./main.ts [--url http://localhost:3001] <agent-path> stream [--offset X] [--live]
 *
 * Examples:
 *   ./main.ts my-agent append '{"type": "hello", "message": "world"}'
 *   ./main.ts my-agent stream --live
 *   ./main.ts --url http://localhost:3001 my-agent stream --offset 5
 */

import { stderr, stdout } from "node:process"
import { DurableStream } from "@durable-streams/client"

const DEFAULT_URL = "http://localhost:3001"

function printUsage() {
  console.error(`
Shiterate CLI - Interact with the durable stream server

Usage:
  ./main.ts [--url URL] <agent-path> append <json-event>
  ./main.ts [--url URL] <agent-path> stream [--offset X] [--live]

Options:
  --url URL        Server URL (default: ${DEFAULT_URL})
  --offset X       Start streaming from offset X (default: beginning)
  --live           Keep connection open for live updates

Commands:
  append <json>    Append a JSON event to the stream
  stream           Subscribe to events from the stream

Examples:
  ./main.ts my-agent append '{"type": "message", "text": "hello"}'
  ./main.ts my-agent stream
  ./main.ts my-agent stream --offset 5
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
    const stream = new DurableStream({ url, contentType: "application/json" })
    await stream.append(parsed)
    console.log(`✓ Event appended to ${agentPath}`)
  } catch (error) {
    if (error instanceof Error) {
      stderr.write(`Error appending: ${error.message}\n`)
    }
    process.exit(1)
  }
}

async function streamEvents(baseUrl: string, agentPath: string, offset?: string, live?: boolean) {
  const url = buildStreamUrl(baseUrl, agentPath)

  console.error(`Streaming from: ${agentPath}`)
  console.error(`URL: ${url}`)
  console.error("---")

  try {
    const stream = new DurableStream({ url })
    const res = await stream.stream({
      offset,
      live: live ? "sse" : false,
    })

    for await (const chunk of res.bodyStream()) {
      if (chunk.length > 0) {
        stdout.write(chunk)
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
      let offset: string | undefined
      let live = false

      while (i < args.length) {
        if (args[i] === "--offset") {
          const val = args[++i]
          if (!val) {
            stderr.write("Error: --offset requires a value\n")
            process.exit(1)
          }
          offset = val
          i++
        } else if (args[i] === "--live") {
          live = true
          i++
        } else {
          stderr.write(`Error: Unknown option "${args[i]}"\n`)
          process.exit(1)
        }
      }

      await streamEvents(baseUrl, agentPath, offset, live)
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
