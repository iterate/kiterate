/**
 * Voice PE Server
 *
 * A Node.js/TypeScript backend for Home Assistant Voice Preview Edition devices.
 * Connects to ESPHome devices using the Native API protocol and provides a
 * pluggable voice pipeline for STT, intent processing, and TTS.
 */

export {
  // Voice Connection
  VoiceConnectionService,
  VoiceConnectionLive,
  VoiceConnectionError,
  DeviceConfig,
  type VoiceConnection,
  type VoiceRequest,
  type AudioChunk,
  type VoiceEventData,
  type DeviceInfo,
  type VoiceAssistantEventType,
} from "./VoiceConnection.js";

export {
  // Voice Pipeline
  VoicePipelineService,
  VoicePipelineLive,
  VoicePipelineError,
  SpeechToTextService,
  IntentProcessorService,
  TextToSpeechService,
  EchoSpeechToText,
  EchoIntentProcessor,
  SilentTextToSpeech,
  EchoPipelineLive,
  VOICE_PE_INPUT_FORMAT,
  type VoicePipeline,
  type SpeechToText,
  type IntentProcessor,
  type TextToSpeech,
  type TranscriptionResult,
  type IntentResult,
  type AudioFormat,
} from "./VoicePipeline.js";

export {
  // Voice Manager
  VoiceManagerService,
  VoiceManagerLive,
  VoiceManagerError,
  type VoiceManager,
  type VoiceSession,
  type VoiceSessionState,
  type VoiceEvent,
} from "./VoiceManager.js";

export {
  // Server
  AppLive,
  ServerLive,
} from "./server.js";
