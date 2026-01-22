/**
 * File-system implementation of StreamStorageManager
 *
 * Stores events as YAML documents separated by `---`.
 * Each stream path maps to a file: {basePath}/{streamPath}.yaml
 */
import * as Fs from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";
import * as YAML from "yaml";

import { Event, EventInput, Offset, StreamPath, Version } from "../../domain.js";
import {
  StreamStorage,
  StreamStorageError,
  StreamStorageManager,
  StreamStorageManagerTypeId,
} from "./service.js";

export const fileSystemLayer = (
  basePath: string,
): Layer.Layer<StreamStorageManager, StreamStorageError, Fs.FileSystem | Path.Path> =>
  Layer.effect(
    StreamStorageManager,
    Effect.gen(function* () {
      const fs = yield* Fs.FileSystem;
      const path = yield* Path.Path;

      // Ensure base directory exists
      yield* fs.makeDirectory(basePath, { recursive: true });

      const getFilePath = (streamPath: StreamPath) =>
        path.join(basePath, `${streamPath.replace(/\//g, "_")}.yaml`);

      const formatOffset = (n: number): Offset => Offset.make(n.toString().padStart(16, "0"));

      const countExistingDocs = (filePath: string) =>
        Effect.gen(function* () {
          const exists = yield* fs.exists(filePath);
          if (!exists) return 0;
          const content = yield* fs.readFileString(filePath);
          return YAML.parseAllDocuments(content).length;
        });

      const append = ({
        path: streamPath,
        event: input,
      }: {
        path: StreamPath;
        event: EventInput;
      }) =>
        Effect.gen(function* () {
          const filePath = getFilePath(streamPath);

          // Derive offset from existing document count
          const docCount = yield* countExistingDocs(filePath);
          const offset = formatOffset(docCount);
          const createdAt = yield* DateTime.now;
          const version = input.version ?? Version.make("1");
          const event = Event.make({ ...input, path: streamPath, offset, createdAt, version });

          // Encode Event to YAML document
          const encoded = yield* Schema.encode(Event)(event);
          const yaml = YAML.stringify(encoded);
          const doc = "---\n" + yaml;
          yield* fs.writeFile(filePath, new TextEncoder().encode(doc), { flag: "a" });

          return event;
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause })));

      const read = ({
        path: streamPath,
        from,
        to,
      }: {
        path: StreamPath;
        from?: Offset;
        to?: Offset;
      }) =>
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
            let events = yield* Effect.all(docs.map((doc) => Schema.decodeUnknown(Event)(doc)));

            if (from !== undefined) {
              events = events.filter((e) => e.offset > from);
            }
            if (to !== undefined) {
              events = events.filter((e) => e.offset <= to);
            }

            return Stream.fromIterable(events);
          }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
        );

      const forPath = (streamPath: StreamPath): StreamStorage => ({
        read: (options) =>
          read({
            path: streamPath,
            ...(options?.from !== undefined && { from: options.from }),
            ...(options?.to !== undefined && { to: options.to }),
          }).pipe(Stream.catchAllCause(() => Stream.empty)),
        append: (event) => append({ path: streamPath, event }).pipe(Effect.orDie),
      });

      return StreamStorageManager.of({
        [StreamStorageManagerTypeId]: StreamStorageManagerTypeId,
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
        forPath,
        append,
        read,
      });
    }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
  );
