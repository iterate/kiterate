/**
 * Grok Voice Reducer - Handles grok:event events, collects audio, displays transcript
 *
 * The reducer is pure - it just accumulates state. Audio playback decisions
 * are made by the client based on whether events came from the live connection.
 */
import type { MessageFeedItem, ContentBlock } from "@kiterate/server-basic/feed-types";

export type { MessageFeedItem, ContentBlock };

// Grok event types we care about
interface GrokEvent {
  type: string;
  payload?: {
    type?: string;
    delta?: string;
    [key: string]: unknown;
  };
  offset?: string;
  createdAt?: string;
}

/** Grok-specific FeedItem */
export type FeedItem = MessageFeedItem;

export interface GrokState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage: MessageFeedItem | undefined;
  activeTools: Map<string, { feedIndex: number }>;
  /** Accumulated transcript text for current response */
  streamingTranscript: string;
  /** Accumulated audio chunks (base64) for current response */
  audioChunks: string[];
}

export function createInitialGrokState(): GrokState {
  return {
    feed: [],
    isStreaming: false,
    streamingMessage: undefined,
    activeTools: new Map(),
    streamingTranscript: "",
    audioChunks: [],
  };
}

/** Play audio chunks - call from client when live events complete */
export function playAudio(audioChunks: string[]): void {
  if (audioChunks.length === 0) return;

  // Convert base64 chunks to audio buffer
  const binaryChunks = audioChunks.map((chunk) => {
    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  });

  // Concatenate all chunks
  const totalLength = binaryChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const audioData = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of binaryChunks) {
    audioData.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert PCM s16le to AudioBuffer and play
  const sampleRate = 48000;
  const numSamples = audioData.length / 2; // 16-bit = 2 bytes per sample
  const audioContext = new AudioContext({ sampleRate });
  const audioBuffer = audioContext.createBuffer(1, numSamples, sampleRate);
  const channelData = audioBuffer.getChannelData(0);

  // Convert s16le to float32
  const dataView = new DataView(audioData.buffer);
  for (let i = 0; i < numSamples; i++) {
    const sample = dataView.getInt16(i * 2, true); // little-endian
    channelData[i] = sample / 32768; // normalize to [-1, 1]
  }

  // Play
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.start();
}

export function grokReducer(state: GrokState, event: GrokEvent): GrokState {
  const now = Date.now();

  // Only handle iterate:grok:response:sse type
  if (event.type !== "iterate:grok:response:sse" || !event.payload) {
    return state;
  }

  const payloadType = event.payload.type;

  switch (payloadType) {
    // Response starting - begin collecting
    case "response.created": {
      return {
        ...state,
        isStreaming: true,
        streamingTranscript: "",
        audioChunks: [],
      };
    }

    // Transcript delta - accumulate and update streaming message (not in feed yet)
    case "response.output_audio_transcript.delta": {
      const delta = event.payload.delta ?? "";
      const newTranscript = state.streamingTranscript + delta;

      // Update streaming message only - will be added to feed on response.done
      const streamingMessage: MessageFeedItem = {
        kind: "message",
        role: "assistant",
        content: [{ type: "text", text: newTranscript }],
        timestamp: now,
      };

      return {
        ...state,
        streamingMessage,
        streamingTranscript: newTranscript,
      };
    }

    // Audio delta - collect chunks
    case "response.output_audio.delta": {
      const delta = event.payload.delta;
      if (delta) {
        return {
          ...state,
          audioChunks: [...state.audioChunks, delta],
        };
      }
      return state;
    }

    // Response done - add final message to feed and clear streaming state
    case "response.done": {
      // Add final message to feed if we have transcript content
      let feed = state.feed;
      if (state.streamingTranscript) {
        const finalMessage: MessageFeedItem = {
          kind: "message",
          role: "assistant",
          content: [{ type: "text", text: state.streamingTranscript }],
          timestamp: now,
        };
        feed = [...state.feed, finalMessage];
      }

      return {
        ...state,
        feed,
        isStreaming: false,
        streamingMessage: undefined,
        // Note: audioChunks and streamingTranscript are NOT cleared - client reads them for playback
      };
    }

    // User audio transcription completed - add user message with recognized speech
    case "conversation.item.input_audio_transcription.completed": {
      const transcript = event.payload.transcript;
      if (typeof transcript === "string" && transcript.trim()) {
        const userMessage: MessageFeedItem = {
          kind: "message",
          role: "user",
          content: [{ type: "text", text: transcript.trim() }],
          timestamp: now,
        };
        return {
          ...state,
          feed: [...state.feed, userMessage],
        };
      }
      return state;
    }

    default:
      return state;
  }
}

export function getMessages(state: GrokState): MessageFeedItem[] {
  return state.feed.filter((item): item is MessageFeedItem => item.kind === "message");
}
