import "server-only";
import type { ExtractionServices } from "./import";

export function extractionServices(): ExtractionServices {
  const youtube = process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_MODEL
    ? { provider: "gemini" as const, model: process.env.GEMINI_MODEL } : null;
  const standard = process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL
    ? { provider: "openrouter" as const, model: process.env.OPENROUTER_MODEL } : youtube;
  return { standard, youtube };
}
// The trip assistant needs a model that supports tool calling; it defaults to the import model.
export function assistantService() {
  const model = process.env.OPENROUTER_ASSISTANT_MODEL || process.env.OPENROUTER_MODEL;
  return process.env.OPENROUTER_API_KEY && model ? { provider: "openrouter" as const, model } : null;
}
