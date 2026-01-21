import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { Offset } from "../domain.js";

// TODO: import State, reduce, etc. once exported

describe("OpenAI Simple Consumer", () => {
  describe("State", () => {
    describe("shouldTriggerLlmResponse", () => {
      it.todo("returns false when no user message");

      it.todo("returns true when user message but no response yet");

      it.todo("returns false when response offset > user message offset");

      it.todo("returns true when new user message > last response offset");
    });
  });

  describe("reduce", () => {
    it.todo("sets enabled on config event");

    it.todo("adds user message to history");

    it.todo("sets llmRequestRequiredFrom on user message");

    it.todo("sets llmLastRespondedAt on request-started");

    it.todo("appends text delta to assistant message in history");
  });

  describe("consumer", () => {
    it.todo("triggers LLM on user message when enabled");

    it.todo("does not trigger when disabled");

    it.todo("interrupts existing request on new user message");
  });
});
