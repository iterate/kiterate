// import { Effect } from "effect";

// export interface SimpleStream {
//   /** Subscribe to live events, optionally starting after an offset */
//   readonly subscribe: (options?: { from?: Offset }) => Stream.Stream<Event>;

//   /** Read historical events, optionally within a range */
//   readonly read: (options?: { from?: Offset; to?: Offset }) => Stream.Stream<Event>;

//   /** Append an event to a path */
//   readonly append: (event: EventInput) => Effect.Effect<void>;
// }

// // -------------------------------------------------------------------------------------
// // SimpleConsumer
// // -------------------------------------------------------------------------------------

// /**
//  * A simple consumer - just a function that runs with access to a SimpleStream.
//  */
// export interface SimpleConsumer<R> {
//   readonly name: string;
//   readonly run: (stream: SimpleStream) => Effect.Effect<void, never, R | Scope.Scope>;
// }

// const openaiConsumer: SimpleConsumer<never> = {
//   name: "openai",
//   run: (stream) =>
//     Effect.gen(function* () {
//       let state = {
//         active: false,
//       };

//       let ongoingHttpRequest = null;
//       let lastOffset = ???

//       // Hydrate by reducing the history
//       ((state = reduceState), state.read);

//       // Subscribe to events since last offset
//       // for event
//       //   - reduce
//       //   - if event.type == prompt && ongoingHttpRequest == null
//       //       ongoingHttpRequest = openai.fetch(event.payload.prompt)

//     }),
// };
