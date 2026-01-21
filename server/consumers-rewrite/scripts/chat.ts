#!/usr/bin/env bun
/**
 * Pretty print a conversation from a session YAML file.
 *
 * Usage: bun scripts/chat.ts <path>
 * Example: bun scripts/chat.ts hello5
 */
import * as YAML from "yaml";
import { readFileSync } from "fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: bun scripts/chat.ts <path>");
  process.exit(1);
}

const file = `.data/streams/${path}.yaml`;
const content = readFileSync(file, "utf-8");
const docs = YAML.parseAllDocuments(content).map((doc) => doc.toJS());

let currentAssistant = "";

for (const event of docs) {
  // User message
  if (event.type === "iterate:agent:action:send-user-message:called") {
    if (currentAssistant) {
      console.log(`\x1b[32mAssistant:\x1b[0m ${currentAssistant}\n`);
      currentAssistant = "";
    }
    console.log(`\x1b[34mUser:\x1b[0m ${event.payload.content}\n`);
  }

  // Assistant text delta
  if (event.type === "iterate:openai:response:sse") {
    const part = event.payload.part;
    if (part?.type === "text-delta") {
      currentAssistant += part.delta;
    }
  }

  // Request ended - flush assistant
  if (event.type === "iterate:openai:request-ended" && currentAssistant) {
    console.log(`\x1b[32mAssistant:\x1b[0m ${currentAssistant}\n`);
    currentAssistant = "";
  }

  // Request cancelled
  if (event.type === "iterate:openai:request-cancelled") {
    console.log(`\x1b[31m[Request cancelled]\x1b[0m\n`);
    currentAssistant = "";
  }
}

// Flush any remaining
if (currentAssistant) {
  console.log(`\x1b[32mAssistant:\x1b[0m ${currentAssistant}\n`);
}
