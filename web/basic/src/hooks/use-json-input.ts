import { useState, useCallback } from "react";

export interface UseJsonInputReturn {
  /** Current JSON input value */
  value: string;
  /** Validation error message, or null if valid */
  error: string | null;
  /** Whether the current input is valid JSON */
  isValid: boolean;
  /** Update the input value (validates on change) */
  setValue: (value: string) => void;
  /** Reset to a new template value */
  reset: (template: string) => void;
}

/**
 * Hook for managing JSON input with real-time validation.
 */
export function useJsonInput(initialValue: string): UseJsonInputReturn {
  const [value, setValueState] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  const setValue = useCallback((newValue: string) => {
    setValueState(newValue);
    try {
      JSON.parse(newValue);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid JSON");
    }
  }, []);

  const reset = useCallback((template: string) => {
    setValueState(template);
    setError(null);
  }, []);

  const isValid = error === null && value.trim() !== "";

  return { value, error, isValid, setValue, reset };
}
