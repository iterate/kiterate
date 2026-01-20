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
