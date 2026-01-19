import { useState, useRef } from "react";

import { DisplayModeContext, type DisplayMode } from "./use-raw-mode.ts";

const STORAGE_KEY = "daemon:displayMode";

function isValidDisplayMode(value: string | null): value is DisplayMode {
  return value === "pretty" || value === "raw-pretty" || value === "raw" || value === "raw-raw";
}

function getInitialDisplayMode(): DisplayMode {
  if (typeof window === "undefined") return "raw-pretty";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Handle legacy boolean values
    if (stored === "true") return "raw-pretty";
    if (stored === "false") return "pretty";
    // Handle enum values
    if (isValidDisplayMode(stored)) {
      return stored;
    }
  } catch {
    // Ignore localStorage errors
  }
  return "raw-pretty"; // Default
}

export function RawModeProvider({ children }: { children: React.ReactNode }) {
  const [displayMode, setDisplayModeState] = useState<DisplayMode>(getInitialDisplayMode);
  const [rawEventsCount, setRawEventsCountState] = useState(0);
  const lastCountRef = useRef(0);

  const setDisplayMode = (value: DisplayMode) => {
    setDisplayModeState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Ignore localStorage errors (quota exceeded, etc.)
    }
  };

  const setRawEventsCount = (count: number) => {
    if (count !== lastCountRef.current) {
      lastCountRef.current = count;
      setRawEventsCountState(count);
    }
  };

  return (
    <DisplayModeContext.Provider value={{ 
      displayMode, 
      setDisplayMode, 
      rawEventsCount, 
      setRawEventsCount,
    }}>
      {children}
    </DisplayModeContext.Provider>
  );
}
