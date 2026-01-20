/**
 * Event Storage
 *
 * IndexedDB-based storage for event streams.
 * Caches events locally for delta sync on page reload.
 *
 * IMPORTANT: message_update filtering happens HERE at the innermost level,
 * just before persisting to IndexedDB (matching backend behavior).
 */

import { get, set, del, createStore } from "idb-keyval";

// Toggle to disable IndexedDB caching without removing implementation.
export const EVENT_STORAGE_ENABLED = false;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredEvent {
  offset: string;
  type?: string;
  [key: string]: unknown;
}

export interface CachedStream {
  events: StoredEvent[];
  lastOffset: string;
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

const store = createStore("basic-events", "streams");

// ─────────────────────────────────────────────────────────────────────────────
// Write Queue (prevents race conditions when multiple appends happen in quick succession)
// ─────────────────────────────────────────────────────────────────────────────

const writeQueues = new Map<string, Promise<void>>();

/**
 * Enqueue a write operation to ensure serial execution per storage key.
 * This prevents race conditions where concurrent appendEvents calls would
 * read stale cache state and overwrite each other's data.
 */
function enqueueWrite(storageKey: string, operation: () => Promise<void>): Promise<void> {
  const currentQueue = writeQueues.get(storageKey) ?? Promise.resolve();
  const newQueue = currentQueue.then(operation).catch((err) => {
    console.warn("[event-storage] Write operation failed:", err);
  });
  writeQueues.set(storageKey, newQueue);
  return newQueue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if an event should be persisted.
 * Filters out transient events like message_update (matching backend logic).
 */
function shouldPersist(event: StoredEvent): boolean {
  // Check for PI SDK events wrapped in event-received envelope
  const payload = event.payload as { piEventType?: string; openCodeEventType?: string } | undefined;
  if (payload?.piEventType === "message_update") {
    return false;
  }
  if (payload?.openCodeEventType === "message.part.updated") {
    return false;
  }

  // Also check direct event type for non-wrapped events
  if (event.type === "message_update" || event.type === "message_chunk") {
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get cached events for a storage key.
 * Returns null if no cache exists.
 */
export async function getCachedEvents(storageKey: string): Promise<CachedStream | null> {
  try {
    const cached = await get<CachedStream>(storageKey, store);
    return cached ?? null;
  } catch (error) {
    console.warn("[event-storage] Failed to read cache:", error);
    return null;
  }
}

/**
 * Append new events to the cache.
 * Filters out message_update events before persisting.
 * Uses a write queue to prevent race conditions from concurrent calls.
 */
export async function appendEvents(
  storageKey: string,
  newEvents: StoredEvent[],
  lastOffset: string,
): Promise<void> {
  // Filter out transient events
  const persistableEvents = newEvents.filter(shouldPersist);

  if (persistableEvents.length === 0 && !lastOffset) {
    return; // Nothing to persist
  }

  // Use write queue to serialize operations and prevent race conditions
  return enqueueWrite(storageKey, async () => {
    try {
      const cached = await getCachedEvents(storageKey);
      const existingEvents = cached?.events ?? [];

      const updatedCache: CachedStream = {
        events: [...existingEvents, ...persistableEvents],
        lastOffset,
        updatedAt: Date.now(),
      };

      await set(storageKey, updatedCache, store);
    } catch (error) {
      // Log but don't throw - caching is best-effort
      console.warn("[event-storage] Failed to append events:", error);
    }
  });
}

/**
 * Clear the cache for a storage key.
 * Uses the write queue to ensure this doesn't race with pending appends.
 */
export async function clearCache(storageKey: string): Promise<void> {
  return enqueueWrite(storageKey, async () => {
    try {
      await del(storageKey, store);
    } catch (error) {
      console.warn("[event-storage] Failed to clear cache:", error);
    }
  });
}

/**
 * Clear all cached streams.
 */
export async function clearAllCaches(): Promise<void> {
  try {
    // Delete the entire database by clearing the store
    // Note: idb-keyval doesn't have a clear() for custom stores,
    // so we'd need to track keys or use a different approach
    // For now, this is a placeholder - individual clears work fine
    console.log("[event-storage] clearAllCaches not implemented");
  } catch (error) {
    console.warn("[event-storage] Failed to clear all caches:", error);
  }
}
