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

/** Audio playback control handle */
export interface AudioPlaybackHandle {
  /** Stop playback */
  stop: () => void;
  /** Duration in seconds */
  duration: number;
}

/**
 * Get duration of PCM s16le audio data in seconds (48kHz, mono).
 */
export function getAudioDuration(audioInput: string | string[]): number {
  if (!audioInput || (Array.isArray(audioInput) && audioInput.length === 0)) return 0;
  const base64Data = Array.isArray(audioInput) ? audioInput.join("") : audioInput;
  if (!base64Data) return 0;
  // base64 encodes 3 bytes as 4 chars, PCM s16le is 2 bytes per sample at 48kHz
  const byteLength = (base64Data.length * 3) / 4;
  const numSamples = byteLength / 2;
  return numSamples / 48000;
}

/**
 * Play audio from PCM s16le base64 data (48kHz, mono).
 * Accepts either an array of base64 chunks or a single base64 string.
 * Returns a handle to stop playback and get duration, or null if no audio.
 */
export function playAudio(
  audioInput: string | string[],
  onEnded?: () => void,
): AudioPlaybackHandle | null {
  if (!audioInput || (Array.isArray(audioInput) && audioInput.length === 0)) return null;

  // Normalize to single base64 string
  const base64Data = Array.isArray(audioInput) ? audioInput.join("") : audioInput;
  if (!base64Data) return null;

  // Decode base64 to bytes
  const binary = atob(base64Data);
  const audioData = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    audioData[i] = binary.charCodeAt(i);
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
  if (onEnded) {
    source.onended = onEnded;
  }
  source.start();

  return {
    stop: () => {
      source.stop();
      audioContext.close();
    },
    duration: numSamples / sampleRate,
  };
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
        // Build message, conditionally including audioData only if we have chunks
        const finalMessage: MessageFeedItem = {
          kind: "message",
          role: "assistant",
          content: [{ type: "text", text: state.streamingTranscript }],
          timestamp: now,
          ...(state.audioChunks.length > 0 ? { audioData: state.audioChunks.join("") } : {}),
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

    // Note: conversation.item.input_audio_transcription.completed is handled
    // in wrapper reducer to merge with pending user audio

    default:
      return state;
  }
}

export function getMessages(state: GrokState): MessageFeedItem[] {
  return state.feed.filter((item): item is MessageFeedItem => item.kind === "message");
}
