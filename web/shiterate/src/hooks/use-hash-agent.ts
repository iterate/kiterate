import { useState, useEffect, useCallback } from "react";
import { getSessionName, isPiAgentPath } from "@/lib/agent-api";

export interface UseHashAgentReturn {
  /** The current agent path from the URL hash (e.g., "/pi/my-session") */
  selectedStream: string;
  /** The current input value (includes /pi/ prefix when in pi mode) */
  agentPathInput: string;
  /** Whether PI mode is enabled */
  piMode: boolean;
  /** Update the session name input */
  setAgentPathInput: (path: string) => void;
  /** Toggle PI mode - updates input prefix accordingly */
  setPiMode: (enabled: boolean) => void;
  /** Navigate to the agent (updates URL hash) */
  selectAgent: () => void;
}

/**
 * Hook for managing agent selection via URL hash.
 * Handles hash reading, PI mode detection, and navigation.
 * Agent paths always start with "/" (e.g., "/pi/my-session" or "/my-session").
 */
export function useHashAgent(): UseHashAgentReturn {
  const [selectedStream, setSelectedStream] = useState("");
  const [agentPathInput, setAgentPathInput] = useState("");
  const [piMode, setPiModeInternal] = useState(false);

  // Handler that updates piMode and adjusts input prefix accordingly
  const setPiMode = useCallback((enabled: boolean) => {
    setPiModeInternal(enabled);
    setAgentPathInput((current) => {
      const hasPrefix = current.startsWith("/pi/");
      if (enabled && !hasPrefix) {
        return "/pi/" + current;
      } else if (!enabled && hasPrefix) {
        return current.slice(4); // Remove "/pi/" prefix
      }
      return current;
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

      // Auto-detect PI mode and set input (with prefix if pi mode)
      const isPi = isPiAgentPath(normalizedPath);
      setPiModeInternal(isPi);
      if (isPi) {
        // Keep the full path including /pi/ prefix in the input
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

    // The input now contains the full path including /pi/ prefix when in pi mode
    // Just ensure it starts with /
    const finalPath = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    window.location.hash = finalPath;
  }, [agentPathInput]);

  return {
    selectedStream,
    agentPathInput,
    piMode,
    setAgentPathInput,
    setPiMode,
    selectAgent,
  };
}
