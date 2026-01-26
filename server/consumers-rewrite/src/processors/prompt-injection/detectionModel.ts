/**
 * Detection Model Service
 *
 * A separate LanguageModel service for prompt injection detection.
 * This allows using a faster/cheaper model for detection while the main
 * LanguageModel service uses a more capable model for actual responses.
 */
import { LanguageModel } from "@effect/ai";
import { Context } from "effect";

/**
 * DetectionModel - a LanguageModel specifically for prompt injection detection.
 *
 * Usage:
 * ```ts
 * const detectionLm = yield* DetectionModel;
 * const result = yield* detectionLm.generateText({ prompt: [...] });
 * ```
 */
export class DetectionModel extends Context.Tag("@app/DetectionModel")<
  DetectionModel,
  LanguageModel.Service
>() {}
