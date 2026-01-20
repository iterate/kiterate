/**
 * Parse YAML stream and play Grok audio
 * Run: bun scripts/play-grok-audio.ts [path-to-yaml]
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as YAML from "yaml";

const yamlPath = process.argv[2] || ".data/streams/demo.yaml";
const content = readFileSync(yamlPath, "utf-8");
const docs = YAML.parseAllDocuments(content).map((doc) => doc.toJS());

// Find all audio delta events and extract base64 PCM
const audioChunks: Buffer[] = [];
let transcript = "";

for (const doc of docs) {
  if (doc?.type === "grok:event" && doc?.payload?.type === "response.output_audio.delta") {
    const delta = doc.payload.delta;
    if (delta) {
      audioChunks.push(Buffer.from(delta, "base64"));
    }
  }
  if (
    doc?.type === "grok:event" &&
    doc?.payload?.type === "response.output_audio_transcript.delta"
  ) {
    transcript += doc.payload.delta ?? "";
  }
}

if (audioChunks.length === 0) {
  console.log("No audio found in", yamlPath);
  process.exit(1);
}

const audioBuffer = Buffer.concat(audioChunks);
console.log(`Found ${audioChunks.length} audio chunks (${audioBuffer.length} bytes)`);
console.log(`Transcript: ${transcript}\n`);

// Write PCM and convert to WAV
const pcmPath = "/tmp/grok-stream.pcm";
const wavPath = "/tmp/grok-stream.wav";
writeFileSync(pcmPath, audioBuffer);

execSync(`ffmpeg -y -f s16le -ar 48000 -ac 1 -i ${pcmPath} ${wavPath} 2>/dev/null`);
console.log("Playing...\n");
execSync(`afplay ${wavPath}`, { stdio: "inherit" });
