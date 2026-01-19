/**
 * YAML-based Event Store
 *
 * Simple file-based storage for event streams.
 * Each agent path maps to a YAML file in .iterate/agents/
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredEvent {
  offset: string;
  createdAt: string;
  data: unknown;
}

export interface StreamData {
  contentType: string;
  createdAt: string;
  events: StoredEvent[];
}

export interface AppendResult {
  offset: string;
  event: StoredEvent;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

export class EventStore {
  private dataDir: string;
  private streams = new Map<string, StreamData>();
  private waiters = new Map<string, Array<{ resolve: () => void; offset: string }>>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.loadAllStreams();
  }

  /**
   * Encode agent path to safe filename
   */
  private encodePathToFilename(agentPath: string): string {
    // Base64 encode the path for safe filenames
    return Buffer.from(agentPath).toString("base64url") + ".yaml";
  }

  /**
   * Get file path for an agent
   */
  private getFilePath(agentPath: string): string {
    return path.join(this.dataDir, this.encodePathToFilename(agentPath));
  }

  /**
   * Generate next offset (padded timestamp + sequence)
   */
  private generateOffset(eventIndex: number): string {
    const timestamp = Date.now().toString().padStart(16, "0");
    const seq = eventIndex.toString().padStart(8, "0");
    return `${timestamp}_${seq}`;
  }

  /**
   * Load all streams from disk on startup
   */
  private loadAllStreams(): void {
    if (!fs.existsSync(this.dataDir)) return;

    const files = fs.readdirSync(this.dataDir).filter((f) => f.endsWith(".yaml"));
    for (const file of files) {
      try {
        const filePath = path.join(this.dataDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const data = YAML.parse(content) as StreamData;
        
        // Decode the path from filename
        const encodedPath = file.replace(".yaml", "");
        const agentPath = Buffer.from(encodedPath, "base64url").toString("utf-8");
        
        this.streams.set(agentPath, data);
      } catch (err) {
        console.error(`[Store] Failed to load ${file}:`, err);
      }
    }
    console.log(`[Store] Loaded ${this.streams.size} streams from ${this.dataDir}`);
  }

  /**
   * Save a stream to disk
   */
  private saveStream(agentPath: string, data: StreamData): void {
    const filePath = this.getFilePath(agentPath);
    const content = YAML.stringify(data);
    fs.writeFileSync(filePath, content, "utf-8");
  }

  /**
   * Check if a stream exists
   */
  has(agentPath: string): boolean {
    return this.streams.has(agentPath);
  }

  /**
   * Get or create a stream
   */
  getOrCreate(agentPath: string): StreamData {
    let stream = this.streams.get(agentPath);
    if (!stream) {
      stream = {
        contentType: "application/json",
        createdAt: new Date().toISOString(),
        events: [],
      };
      this.streams.set(agentPath, stream);
      this.saveStream(agentPath, stream);
      console.log(`[Store] Created stream: ${agentPath}`);
    }
    return stream;
  }

  /**
   * Append an event to a stream
   */
  append(agentPath: string, eventData: unknown): AppendResult {
    const stream = this.getOrCreate(agentPath);
    const offset = this.generateOffset(stream.events.length);
    const createdAt = new Date().toISOString();

    const event: StoredEvent = {
      offset,
      createdAt,
      data: eventData,
    };

    stream.events.push(event);
    this.saveStream(agentPath, stream);

    // Notify waiters
    const waiters = this.waiters.get(agentPath) ?? [];
    const toNotify = waiters.filter((w) => w.offset < offset);
    for (const waiter of toNotify) {
      waiter.resolve();
    }
    this.waiters.set(
      agentPath,
      waiters.filter((w) => !toNotify.includes(w))
    );

    return { offset, event };
  }

  /**
   * Read events from a stream starting at offset
   */
  read(agentPath: string, offset: string = "-1"): { events: StoredEvent[]; upToDate: boolean } {
    const stream = this.streams.get(agentPath);
    if (!stream) {
      return { events: [], upToDate: true };
    }

    let events: StoredEvent[];
    if (offset === "-1") {
      events = stream.events;
    } else if (offset === "now") {
      events = [];
    } else {
      // Find events after the given offset
      events = stream.events.filter((e) => e.offset > offset);
    }

    return { events, upToDate: true };
  }

  /**
   * Wait for new events after offset
   */
  async waitForEvents(agentPath: string, offset: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Remove this waiter
        const waiters = this.waiters.get(agentPath) ?? [];
        this.waiters.set(
          agentPath,
          waiters.filter((w) => w.resolve !== resolveWaiter)
        );
        resolve(false); // Timed out
      }, timeoutMs);

      const resolveWaiter = () => {
        clearTimeout(timer);
        resolve(true); // Got new events
      };

      const waiters = this.waiters.get(agentPath) ?? [];
      waiters.push({ resolve: resolveWaiter, offset });
      this.waiters.set(agentPath, waiters);
    });
  }

  /**
   * Get the current offset (last event offset or empty string)
   */
  getCurrentOffset(agentPath: string): string {
    const stream = this.streams.get(agentPath);
    if (!stream || stream.events.length === 0) {
      return "";
    }
    return stream.events[stream.events.length - 1].offset;
  }

  /**
   * List all stream paths
   */
  listStreams(): string[] {
    return Array.from(this.streams.keys());
  }
}
