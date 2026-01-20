/**
 * Audio Recorder Hook
 *
 * Captures audio from the microphone and converts to PCM s16le format
 * compatible with Grok's voice API (48kHz, mono, 16-bit signed little-endian).
 */

import { useState, useRef, useCallback, useEffect } from "react";

const SAMPLE_RATE = 48000;

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export interface AudioRecorderState {
  isRecording: boolean;
  isSupported: boolean;
  error: string | null;
  devices: AudioDevice[];
  selectedDeviceId: string | null;
}

export interface AudioRecorderControls {
  /** Start recording - call on mousedown/touchstart */
  startRecording: () => Promise<void>;
  /** Stop recording and return PCM audio as base64 - call on mouseup/touchend */
  stopRecording: () => Promise<string | null>;
  /** Refresh available audio devices */
  refreshDevices: () => Promise<void>;
  /** Select audio input device */
  selectDevice: (deviceId: string) => void;
}

export function useAudioRecorder(): [AudioRecorderState, AudioRecorderControls] {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);

  const isSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== "undefined";

  // Enumerate audio devices
  const refreshDevices = useCallback(async () => {
    if (!isSupported) return;
    try {
      // Need to request permission first to get device labels
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
        s.getTracks().forEach((t) => t.stop());
      });
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
        }));
      setDevices(audioInputs);
      // Select first device if none selected
      if (!selectedDeviceId && audioInputs.length > 0) {
        setSelectedDeviceId(audioInputs[0].deviceId);
      }
    } catch (err) {
      console.error("[audio-recorder] Failed to enumerate devices:", err);
    }
  }, [isSupported, selectedDeviceId]);

  // Refresh devices on mount
  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  const selectDevice = useCallback((deviceId: string) => {
    setSelectedDeviceId(deviceId);
  }, []);

  const startRecording = useCallback(async () => {
    if (!isSupported) {
      setError("Audio recording not supported in this browser");
      return;
    }

    try {
      setError(null);
      chunksRef.current = [];

      // Get microphone access with selected device
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(selectedDeviceId && { deviceId: { exact: selectedDeviceId } }),
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      // Create audio context
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;

      // Create source from microphone
      const source = audioContext.createMediaStreamSource(stream);

      // Use ScriptProcessorNode for simplicity (deprecated but widely supported)
      // AudioWorklet would be better but requires more setup
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        // Copy the data since the buffer gets reused
        chunksRef.current.push(new Float32Array(inputData));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      workletNodeRef.current = processor as unknown as AudioWorkletNode;
      setIsRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start recording";
      setError(message);
      console.error("[audio-recorder] Start failed:", err);
    }
  }, [isSupported, selectedDeviceId]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!isRecording) return null;

    try {
      // Stop the processor
      if (workletNodeRef.current) {
        workletNodeRef.current.disconnect();
        workletNodeRef.current = null;
      }

      // Close audio context
      if (audioContextRef.current) {
        await audioContextRef.current.close();
        audioContextRef.current = null;
      }

      // Stop media stream
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }

      setIsRecording(false);

      // Concatenate all chunks
      const totalLength = chunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
      if (totalLength === 0) {
        return null;
      }

      const audioData = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunksRef.current) {
        audioData.set(chunk, offset);
        offset += chunk.length;
      }
      chunksRef.current = [];

      // Convert float32 [-1, 1] to int16 PCM
      const pcmData = new Int16Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        const s = Math.max(-1, Math.min(1, audioData[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Convert to base64
      const uint8Array = new Uint8Array(pcmData.buffer);
      let binary = "";
      for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      return btoa(binary);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stop recording";
      setError(message);
      console.error("[audio-recorder] Stop failed:", err);
      setIsRecording(false);
      return null;
    }
  }, [isRecording]);

  return [
    { isRecording, isSupported, error, devices, selectedDeviceId },
    { startRecording, stopRecording, refreshDevices, selectDevice },
  ];
}
