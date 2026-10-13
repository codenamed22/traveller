import "server-only";
import type { ExtractionServices } from "./import";

export function extractionServices(): ExtractionServices {
  const youtube = process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_MODEL
    ? { provider: "gemini" as const, model: process.env.GEMINI_MODEL } : null;
  const standard = process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL
    ? { provider: "openrouter" as const, model: process.env.OPENROUTER_MODEL } : youtube;
  return { standard, youtube };
}