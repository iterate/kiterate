/**
 * Typed event schemas for creating and parsing events with compile-time safety
 */
import { Effect, Option, ParseResult, Schema } from "effect";
import { Event, EventInput, EventType } from "./domain.js";

// -------------------------------------------------------------------------------------
// EventSchema
// -------------------------------------------------------------------------------------

/** The narrowed type returned by EventSchema.make() */
type TypedEventInput<Type extends string, P> = EventInput & {
  readonly type: Type;
  readonly payload: P;
};

interface EventSchema<Type extends string, P> {
  readonly type: EventType;
  readonly typeString: Type;
  /** Phantom type for extracting the event type: `type MyEvent = typeof MyEvent.Type` */
  readonly Type: TypedEventInput<Type, P>;
  readonly make: {} extends P
    ? (payload?: P) => TypedEventInput<Type, P>
    : (payload: P) => TypedEventInput<Type, P>;
  readonly decodeOption: (event: EventInput | Event) => Option.Option<P>;
  readonly decode: (event: EventInput | Event) => Effect.Effect<P, ParseResult.ParseError>;
  /** Type guard that includes the discriminant for proper narrowing, preserving Event vs EventInput */
  readonly is: <E extends EventInput | Event>(event: E) => event is E & { type: Type; payload: P };
}

export const EventSchema = {
  make: <Type extends string, Fields extends Schema.Struct.Fields>(
    type: Type,
    fields: Fields,
  ): EventSchema<Type, Schema.Struct.Type<Fields>> => {
    const eventType = EventType.make(type);
    const payloadSchema = Schema.Struct(fields) as unknown as Schema.Schema<
      Schema.Struct.Type<Fields>
    >;
    type P = Schema.Struct.Type<Fields>;
    const decodePayloadOption = Schema.decodeUnknownOption(payloadSchema);
    const decodePayload = Schema.decodeUnknown(payloadSchema);

    return {
      type: eventType,
      typeString: type,
      Type: undefined as unknown as TypedEventInput<Type, P>, // phantom type
      make: (payload?: P) =>
        EventInput.make({
          type: eventType,
          payload: payload ?? {},
        }) as TypedEventInput<Type, P>,
      decodeOption: (event) => {
        if (String(event.type) !== type) return Option.none();
        return decodePayloadOption(event.payload);
      },
      decode: (event) => {
        if (String(event.type) !== type) {
          return Effect.fail(
            new ParseResult.ParseError({
              issue: new ParseResult.Type(
                Schema.Literal(type).ast,
                event.type,
                `Expected event type "${type}", got "${event.type}"`,
              ),
            }),
          );
        }
        return decodePayload(event.payload);
      },
      // Type guard - only checks the event type, not payload structure.
      // The payload type is guaranteed by how events are created via .make()
      // For runtime validation, use .decode() or .decodeOption()
      is: <E extends EventInput | Event>(event: E): event is E & { type: Type; payload: P } =>
        String(event.type) === type,
    };
  },
};

// -------------------------------------------------------------------------------------
// Event Definitions
// -------------------------------------------------------------------------------------

export const ConfigSetEvent = EventSchema.make("iterate:agent:config:set", {
  model: Schema.Literal("openai", "grok"),
});

export const UserMessageEvent = EventSchema.make("iterate:agent:action:send-user-message:called", {
  content: Schema.String,
});
export type UserMessageEvent = typeof UserMessageEvent.Type;

/**
 * A message from the system/developer to the LLM (not from the user).
 * Used for status updates, codemode results, and other internal notifications.
 * When building messages for the LLM, these are wrapped in <developer-message> XML tags
 * (or could use model-specific "developer" role in the future).
 */
export const DeveloperMessageEvent = EventSchema.make("iterate:developer-message", {
  content: Schema.String,
});
export type DeveloperMessageEvent = typeof DeveloperMessageEvent.Type;

export const UserAudioEvent = EventSchema.make("iterate:agent:action:send-user-audio:called", {
  audio: Schema.String,
});
