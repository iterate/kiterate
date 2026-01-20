import { useState, useEffect, useCallback } from "react";
import {
  getSessionName,
  detectHarnessType,
  getHarnessPrefix,
  stripHarnessPrefix,
  type HarnessType,
} from "@/lib/agent-api";

export interface UseHashAgentReturn {
  /** The current agent path from the URL hash (e.g., "/pi/my-session") */
  selectedStream: string;
  /** The current input value (includes harness prefix when selected) */
  agentPathInput: string;
  /** The current harness type (pi, claude, opencode, or null for raw) */
  harnessType: HarnessType;
  /** Update the session name input */
  setAgentPathInput: (path: string) => void;
  /** Set harness type - updates input prefix accordingly */
  setHarnessType: (type: HarnessType) => void;
  /** Navigate to the agent (updates URL hash) */
  selectAgent: () => void;
}

/**
 * Hook for managing agent selection via URL hash.
 * Handles hash reading, harness type detection, and navigation.
 * Agent paths always start with "/" (e.g., "/pi/my-session" or "/my-session").
 */
export function useHashAgent(): UseHashAgentReturn {
  const [selectedStream, setSelectedStream] = useState("");
  const [agentPathInput, setAgentPathInput] = useState("");
  const [harnessType, setHarnessTypeInternal] = useState<HarnessType>(null);

  // Handler that updates harnessType and adjusts input prefix accordingly
  const setHarnessType = useCallback((type: HarnessType) => {
    setHarnessTypeInternal(type);
    setAgentPathInput((current) => {
      // Strip any existing harness prefix
      const sessionName = stripHarnessPrefix(current);

      // Add new prefix if type is set
      if (type) {
        return getHarnessPrefix(type) + sessionName;
      }
      return sessionName;
    });
  }, []);

  // Read and sync hash on mount and changes
  useEffect(() => {
    const readHash = () => {
      const hashValue = window.location.hash.replace(/^#/, "");
      let decoded = "";
      try {
        decoded = hashValue ? decodeURIComponent(hashValue) : "";
      } catch {
        // Invalid URI encoding - ignore
        decoded = "";
      }

      // Ensure decoded path starts with /
      const normalizedPath = decoded && !decoded.startsWith("/") ? `/${decoded}` : decoded;
      setSelectedStream(normalizedPath);

      // Auto-detect harness type and set input
      const detectedType = detectHarnessType(normalizedPath);
      setHarnessTypeInternal(detectedType);
      if (detectedType) {
        // Keep the full path including harness prefix in the input
        setAgentPathInput(normalizedPath);
      } else {
        setAgentPathInput(getSessionName(normalizedPath));
      }
    };

    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  const selectAgent = useCallback(() => {
    const trimmed = agentPathInput.trim();
    if (!trimmed) return;

    // The input now contains the full path including harness prefix when selected
    // Just ensure it starts with /
    const finalPath = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    window.location.hash = finalPath;
  }, [agentPathInput]);

  return {
    selectedStream,
    agentPathInput,
    harnessType,
    setAgentPathInput,
    setHarnessType,
    selectAgent,
  };
}
