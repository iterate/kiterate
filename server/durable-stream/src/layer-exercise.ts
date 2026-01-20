/**
 * Layer Exercise: Coffee Shop Domain
 *
 * Layer<Out, Error, In>
 *
 * barista        : Inventory, CoffeeMachine => Barista
 * inventoryLive  : Supplier => Inventory
 * machineLive    : never => CoffeeMachine
 * supplierLive   : never => Supplier
 *
 * Layer tree:
 *   appLayer: Layer<Barista>
 *   └─ barista
 *      ├─ inventoryLive
 *      │  └─ supplierLive
 *      └─ machineLive
 */

import { Context, Effect, Layer } from "effect";

// =============================================================================
// Services
// =============================================================================

class Supplier extends Context.Tag("Supplier")<
  Supplier,
  { readonly orderBeans: (kg: number) => Effect.Effect<void> }
>() {}

class Inventory extends Context.Tag("Inventory")<
  Inventory,
  { readonly checkStock: () => Effect.Effect<number> }
>() {}

class CoffeeMachine extends Context.Tag("CoffeeMachine")<
  CoffeeMachine,
  { readonly brew: (type: string) => Effect.Effect<string> }
>() {}

class Barista extends Context.Tag("Barista")<
  Barista,
  { readonly makeCoffee: (order: string) => Effect.Effect<string> }
>() {}

// =============================================================================
// Layers
// =============================================================================

const SupplierLive: Layer.Layer<Supplier> = Layer.succeed(Supplier, {
  orderBeans: (kg) => Effect.log(`Ordering ${kg}kg of beans`),
});

const InventoryLive: Layer.Layer<Inventory, never, Supplier> = Layer.effect(
  Inventory,
  Effect.gen(function* () {
    const supplier = yield* Supplier;
    let stock = 10;
    return {
      checkStock: () =>
        Effect.gen(function* () {
          if (stock < 5) {
            yield* supplier.orderBeans(20);
            stock += 20;
          }
          return stock;
        }),
    };
  }),
);

const CoffeeMachineLive: Layer.Layer<CoffeeMachine, never, Inventory> = Layer.succeed(
  CoffeeMachine,
  {
    brew: (type) => Effect.succeed(`☕ Fresh ${type}`),
  },
);

const BaristaLive: Layer.Layer<Barista, never, Inventory | CoffeeMachine> = Layer.effect(
  Barista,
  Effect.gen(function* () {
    const inventory = yield* Inventory;
    const machine = yield* CoffeeMachine;
    return {
      makeCoffee: Effect.fn(function* (order) {
        const stock = yield* inventory.checkStock();
        yield* Effect.log(`Stock: ${stock}kg`);
        return yield* machine.brew(order);
      }),
    };
  }),
);

// =============================================================================
// The Program (this will fail to type check - fix it!)
// =============================================================================

const program = Effect.gen(function* () {
  const barista = yield* Barista;
  const coffee = yield* barista.makeCoffee("latte");
  yield* Effect.log(coffee);
});

// TODO: Fix this - the layer composition is incomplete
const AppLayer = BaristaLive.pipe(
  Layer.provide(CoffeeMachineLive),
  Layer.provide(InventoryLive),
  Layer.provide(SupplierLive),
);

const main = program.pipe(Effect.provide(AppLayer));

Effect.runPromise(main);
