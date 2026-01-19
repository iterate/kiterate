import { createContext, useContext } from "react";

/** Display modes for the feed */
export type DisplayMode = "pretty" | "raw-pretty" | "raw" | "raw-raw";

export interface DisplayModeContextValue {
  displayMode: DisplayMode;
  setDisplayMode: (value: DisplayMode) => void;
  rawEventsCount: number;
  setRawEventsCount: (count: number) => void;
}

export const DisplayModeContext = createContext<DisplayModeContextValue | null>(null);

export function useDisplayMode() {
  const context = useContext(DisplayModeContext);
  if (!context) {
    throw new Error("useDisplayMode must be used within a DisplayModeProvider");
  }
  return context;
}

// Legacy alias for backwards compatibility during migration
export const RawModeContext = DisplayModeContext;
export function useRawMode() {
  const { displayMode, setDisplayMode, rawEventsCount, setRawEventsCount } = useDisplayMode();
  return {
    // Legacy boolean - true if showing any raw events
    rawMode: displayMode !== "pretty",
    setRawMode: (value: boolean) => setDisplayMode(value ? "raw-pretty" : "pretty"),
    rawEventsCount,
    setRawEventsCount,
    // New API
    displayMode,
    setDisplayMode,
  };
}
