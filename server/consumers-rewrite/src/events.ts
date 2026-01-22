/**
 * Typed event schemas for creating and parsing events with compile-time safety
 */
import { Effect, Option, ParseResult, Schema } from "effect";
import { Event, EventInput, EventType } from "./domain.js";

// -------------------------------------------------------------------------------------
// EventSchema
// -------------------------------------------------------------------------------------

interface EventSchema<Type extends string, P> {
  readonly type: EventType;
  readonly typeString: Type;
  readonly make: {} extends P ? (payload?: P) => EventInput : (payload: P) => EventInput;
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
    const isPayload = Schema.is(payloadSchema);

    return {
      type: eventType,
      typeString: type,
      make: (payload?: P) =>
        EventInput.make({
          type: eventType,
          payload: payload ?? {},
        }),
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
      is: <E extends EventInput | Event>(event: E): event is E & { type: Type; payload: P } =>
        String(event.type) === type && isPayload(event.payload),
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

export const UserAudioEvent = EventSchema.make("iterate:agent:action:send-user-audio:called", {
  audio: Schema.String,
});
