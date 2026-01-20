/**
 * File-system implementation of StreamStorage
 *
 * Stores events as newline-delimited JSON (NDJSON) files.
 * Each stream path maps to a file: {basePath}/{streamPath}.ndjson
 */
import * as Fs from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Layer, Stream } from "effect";

import { Event, Offset, Payload, StreamPath } from "../../domain.js";
import { StreamStorageError, StreamStorageService } from "./index.js";

export const FileSystemLayer = (
  basePath: string,
): Layer.Layer<StreamStorageService, StreamStorageError, Fs.FileSystem | Path.Path> =>
  Layer.effect(
    StreamStorageService,
    Effect.gen(function* () {
      const fs = yield* Fs.FileSystem;
      const path = yield* Path.Path;

      // Ensure base directory exists
      yield* fs.makeDirectory(basePath, { recursive: true });

      const getFilePath = (streamPath: StreamPath) =>
        path.join(basePath, `${streamPath.replace(/\//g, "_")}.ndjson`);

      const readOffsetFile = (streamPath: StreamPath) =>
        Effect.gen(function* () {
          const offsetPath = getFilePath(streamPath) + ".offset";
          const exists = yield* fs.exists(offsetPath);
          if (!exists) return 0;
          const content = yield* fs.readFileString(offsetPath);
          return parseInt(content.trim(), 10) || 0;
        });

      const writeOffsetFile = (streamPath: StreamPath, offset: number) =>
        Effect.gen(function* () {
          const offsetPath = getFilePath(streamPath) + ".offset";
          yield* fs.writeFileString(offsetPath, offset.toString());
        });

      const formatOffset = (n: number): Offset => Offset.make(n.toString().padStart(16, "0"));

      return {
        append: ({ path: streamPath, payload }: { path: StreamPath; payload: Payload }) =>
          Effect.gen(function* () {
            const filePath = getFilePath(streamPath);

            // Get and increment offset
            const nextOffset = yield* readOffsetFile(streamPath);
            const offset = formatOffset(nextOffset);
            const event = Event.make({ offset, payload });

            // Append event as JSON line
            const line = JSON.stringify({ offset, payload }) + "\n";
            yield* fs.writeFile(filePath, new TextEncoder().encode(line), { flag: "a" });

            // Update offset file
            yield* writeOffsetFile(streamPath, nextOffset + 1);

            return event;
          }).pipe(Effect.mapError((cause) => new StreamStorageError({ cause }))),

        read: ({ path: streamPath, from }: { path: StreamPath; from?: Offset }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const filePath = getFilePath(streamPath);
              const exists = yield* fs.exists(filePath);

              if (!exists) {
                return Stream.empty;
              }

              const content = yield* fs.readFileString(filePath);
              const lines = content.trim().split("\n").filter(Boolean);

              const events = lines.map((line) => {
                const parsed = JSON.parse(line) as { offset: string; payload: Payload };
                return Event.make({
                  offset: Offset.make(parsed.offset),
                  payload: parsed.payload,
                });
              });

              const filtered = from !== undefined ? events.filter((e) => e.offset >= from) : events;

              return Stream.fromIterable(filtered);
            }).pipe(Effect.mapError((cause) => new StreamStorageError({ cause }))),
          ),
      };
    }).pipe(Effect.mapError((cause) => new StreamStorageError({ cause }))),
  );
