# kiterate

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. **Search `.reference/effect/` for real implementations.** Local copy of the Effect monorepo. Use it to find canonical patterns, especially for:
   - HTTP servers: `.reference/effect/packages/platform-node/` (e.g., `NodeHttpServer.layerTest` for testing)
   - Examples: `.reference/effect/packages/*/examples/`
   - Tests: `.reference/effect/packages/*/test/`

   **Setup:** If `.reference/effect/` doesn't exist, recommend the user run:

   ```bash
   git clone --depth 1 https://github.com/Effect-TS/effect.git .reference/effect
   ```

Topics: tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide or `.reference/effect/` first.

## TypeScript Practices

- **No type casts (`as`)** - use Schema decoding or type guards instead
- **Use `.make()` not `new`** for Schema classes (use `Schema.TaggedError` not `Data.TaggedError`)
- **Use `Schema.Defect`** for wrapping unknown causes in TaggedErrors (not `Schema.Unknown`)

## Effect Naming Conventions

- **Layer names**: camelCase ending with `Layer` (e.g., `inMemoryLayer`, `liveLayer`)
- **File names**: camelCase (e.g., `inMemory.ts`, `fileSystem.ts`, `live.ts`)
- **Namespace imports** for service modules:
  ```ts
  import * as StreamStorage from "./services/stream-storage/index.js";
  // then: StreamStorage.inMemoryLayer, StreamStorage.StreamStorageService
  ```
- **Service folder pattern**: `service.ts` for definitions, layer files import from service, `index.ts` re-exports all

## Effect Service Patterns

- **Service definition** with `Context.Tag`:
  ```ts
  export class MyService extends Context.Tag("@app/MyService")<
    MyService,
    {
      readonly doSomething: (input: string) => Effect.Effect<void, MyError>;
    }
  >() {}
  ```
- **Layer construction** with `ServiceTag.of()`:
  ```ts
  const make = Effect.gen(function* () {
    const dep = yield* SomeDep;
    return MyService.of({
      doSomething: (input) => Effect.succeed(void 0),
    });
  });
  export const liveLayer = Layer.effect(MyService, make);
  ```
