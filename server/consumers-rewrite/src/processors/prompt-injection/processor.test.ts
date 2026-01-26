/**
 * Tests for the Prompt Injection Detector Processor
 *
 * Note: Full integration tests would require a complete test harness for the
 * detection model. This file contains basic unit tests for the detection logic.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  PromptInjectionBlockedEvent,
  PromptInjectionCheckCompletedEvent,
  PromptInjectionCheckStartedEvent,
  PromptInjectionWarningEvent,
} from "./events.js";

// -------------------------------------------------------------------------------------
// Event Schema Tests
// -------------------------------------------------------------------------------------

describe("Prompt Injection Events", () => {
  it("PromptInjectionCheckStartedEvent encodes/decodes correctly", () => {
    const event = PromptInjectionCheckStartedEvent.make({
      requestOffset: "0000000000000001" as any,
    });

    expect(event.type).toBe("iterate:prompt-injection:check-started");
    expect(event.payload.requestOffset).toBe("0000000000000001");
  });

  it("PromptInjectionCheckCompletedEvent encodes safe result", () => {
    const event = PromptInjectionCheckCompletedEvent.make({
      requestOffset: "0000000000000001" as any,
      result: "safe",
      confidence: 0.95,
      reason: "Normal conversation",
    });

    expect(event.type).toBe("iterate:prompt-injection:check-completed");
    expect(event.payload.result).toBe("safe");
    expect(event.payload.confidence).toBe(0.95);
  });

  it("PromptInjectionCheckCompletedEvent encodes injection-detected result", () => {
    const event = PromptInjectionCheckCompletedEvent.make({
      requestOffset: "0000000000000001" as any,
      result: "injection-detected",
      confidence: 0.85,
      reason: "Prompt attempts to override instructions",
    });

    expect(event.type).toBe("iterate:prompt-injection:check-completed");
    expect(event.payload.result).toBe("injection-detected");
  });

  it("PromptInjectionBlockedEvent encodes correctly", () => {
    const event = PromptInjectionBlockedEvent.make({
      requestOffset: "0000000000000001" as any,
      blockedEventType: "iterate:llm-loop:request-ended",
      reason: "Injection detected",
    });

    expect(event.type).toBe("iterate:prompt-injection:blocked");
    expect(event.payload.blockedEventType).toBe("iterate:llm-loop:request-ended");
  });

  it("PromptInjectionWarningEvent encodes correctly", () => {
    const event = PromptInjectionWarningEvent.make({
      requestOffset: "0000000000000001" as any,
      message: "Potential attack detected",
      confidence: 0.8,
      detectionReason: "Override attempt",
    });

    expect(event.type).toBe("iterate:prompt-injection:warning");
    expect(event.payload.message).toContain("attack detected");
  });
});

// -------------------------------------------------------------------------------------
// Detection Result Schema Tests
// -------------------------------------------------------------------------------------

describe("Detection Result Parsing", () => {
  const DetectionResultSchema = Schema.Struct({
    isInjection: Schema.Boolean,
    confidence: Schema.Number,
    reason: Schema.String,
  });

  it.effect("parses valid safe response", () =>
    Effect.gen(function* () {
      const json = '{"isInjection": false, "confidence": 0.95, "reason": "Normal request"}';
      const result = yield* Schema.decodeUnknown(Schema.parseJson(DetectionResultSchema))(json);

      expect(result.isInjection).toBe(false);
      expect(result.confidence).toBe(0.95);
      expect(result.reason).toBe("Normal request");
    }),
  );

  it.effect("parses valid injection response", () =>
    Effect.gen(function* () {
      const json =
        '{"isInjection": true, "confidence": 0.85, "reason": "Override attempt detected"}';
      const result = yield* Schema.decodeUnknown(Schema.parseJson(DetectionResultSchema))(json);

      expect(result.isInjection).toBe(true);
      expect(result.confidence).toBe(0.85);
    }),
  );

  it.effect("fails on invalid JSON", () =>
    Effect.gen(function* () {
      const json = "not valid json";
      const result = yield* Schema.decodeUnknown(Schema.parseJson(DetectionResultSchema))(
        json,
      ).pipe(Effect.either);

      expect(result._tag).toBe("Left");
    }),
  );

  it.effect("fails on missing fields", () =>
    Effect.gen(function* () {
      const json = '{"isInjection": true}'; // missing confidence and reason
      const result = yield* Schema.decodeUnknown(Schema.parseJson(DetectionResultSchema))(
        json,
      ).pipe(Effect.either);

      expect(result._tag).toBe("Left");
    }),
  );
});
