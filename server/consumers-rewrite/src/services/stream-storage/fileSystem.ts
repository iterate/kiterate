/**
 * File-system implementation of StreamStorage
 *
 * Stores events as YAML documents separated by `---`.
 * Each stream path maps to a file: {basePath}/{streamPath}.yaml
 */
import * as Fs from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";
import * as YAML from "yaml";

import { Event, EventInput, Offset, StreamPath, Version } from "../../domain.js";
import { StreamStorage, StreamStorageError, StreamStorageTypeId } from "./service.js";

export const fileSystemLayer = (
  basePath: string,
): Layer.Layer<StreamStorage, StreamStorageError, Fs.FileSystem | Path.Path> =>
  Layer.effect(
    StreamStorage,
    Effect.gen(function* () {
      const fs = yield* Fs.FileSystem;
      const path = yield* Path.Path;

      // Ensure base directory exists
      yield* fs.makeDirectory(basePath, { recursive: true });

      const getFilePath = (streamPath: StreamPath) =>
        path.join(basePath, `${streamPath.replace(/\//g, "_")}.yaml`);

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

      return StreamStorage.of({
        [StreamStorageTypeId]: StreamStorageTypeId,

        listPaths: () =>
          Effect.gen(function* () {
            const entries = yield* fs.readDirectory(basePath);
            const paths: StreamPath[] = [];
            for (const entry of entries) {
              if (entry.endsWith(".yaml") && !entry.endsWith(".offset")) {
                // Convert filename back to path: foo_bar.yaml → foo/bar
                const name = entry.slice(0, -5).replace(/_/g, "/");
                paths.push(StreamPath.make(name));
              }
            }
            return paths;
          }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),

        append: ({ path: streamPath, event: input }: { path: StreamPath; event: EventInput }) =>
          Effect.gen(function* () {
            const filePath = getFilePath(streamPath);

            // Get and increment offset
            const nextOffset = yield* readOffsetFile(streamPath);
            const offset = formatOffset(nextOffset);
            const createdAt = yield* DateTime.now;
            const version = input.version ?? Version.make("1");
            const event = Event.make({ ...input, path: streamPath, offset, createdAt, version });

            // Encode Event to YAML document
            const encoded = yield* Schema.encode(Event)(event);
            const yaml = YAML.stringify(encoded);
            const doc = "---\n" + yaml;
            yield* fs.writeFile(filePath, new TextEncoder().encode(doc), { flag: "a" });

            // Update offset file
            yield* writeOffsetFile(streamPath, nextOffset + 1);

            return event;
          }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),

        read: ({ path: streamPath, after }: { path: StreamPath; after?: Offset }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const filePath = getFilePath(streamPath);
              const exists = yield* fs.exists(filePath);

              if (!exists) {
                return Stream.empty;
              }

              const content = yield* fs.readFileString(filePath);
              const docs = YAML.parseAllDocuments(content).map((doc) => doc.toJS());

              // Decode YAML objects to Events
              const events = yield* Effect.all(docs.map((doc) => Schema.decodeUnknown(Event)(doc)));

              // after = last seen offset, so return events AFTER it (exclusive)
              const filtered =
                after !== undefined ? events.filter((e) => e.offset > after) : events;

              return Stream.fromIterable(filtered);
            }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
          ),
      });
    }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
  );
