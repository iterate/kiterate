/**
 * YAML-based Event Store
 *
 * Simple file-based storage for event streams.
 * Agent path maps directly to file path:
 *   /pi/bla → .iterate/agents/pi/bla.yaml
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
   * Convert agent path to file path.
   * /pi/bla → {dataDir}/pi/bla.yaml
   */
  private getFilePath(agentPath: string): string {
    // Remove leading slash and add .yaml
    const relativePath = agentPath.startsWith("/") ? agentPath.slice(1) : agentPath;
    return path.join(this.dataDir, relativePath + ".yaml");
  }

  /**
   * Convert file path back to agent path.
   * {dataDir}/pi/bla.yaml → /pi/bla
   */
  private filePathToAgentPath(filePath: string): string {
    const relativePath = path.relative(this.dataDir, filePath);
    const withoutExt = relativePath.replace(/\.yaml$/, "");
    return "/" + withoutExt;
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
   * Recursively find all .yaml files in a directory.
   */
  private findYamlFiles(dir: string): string[] {
    const results: string[] = [];
    
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findYamlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
        results.push(fullPath);
      }
    }

    return results;
  }

  /**
   * Load all streams from disk on startup
   */
  private loadAllStreams(): void {
    const files = this.findYamlFiles(this.dataDir);
    
    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const data = YAML.parse(content) as StreamData;
        const agentPath = this.filePathToAgentPath(filePath);
        this.streams.set(agentPath, data);
      } catch (err) {
        console.error(`[Store] Failed to load ${filePath}:`, err);
      }
    }
    
    console.log(`[Store] Loaded ${this.streams.size} streams from ${this.dataDir}`);
  }

  /**
   * Save a stream to disk
   */
  private saveStream(agentPath: string, data: StreamData): void {
    const filePath = this.getFilePath(agentPath);
    
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
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
