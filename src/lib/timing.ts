import { z } from "zod";
import { sourceUrlSchema } from "./trip";

export const timingRequestSchema = z.object({
  city: z.string().trim().min(1).max(150),
  places: z.array(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(200) }).strict()).min(1).max(5),
  consent: z.literal(true), operationId: z.uuid(),
}).strict().refine((input) => new Set(input.places.map((place) => place.id)).size === input.places.length, "Choose distinct places.");

export const timingSuggestionsSchema = z.object({
  recommendations: z.array(z.object({
    stopId: z.uuid(), duration: z.number().int().min(5).max(480),
    bestTime: z.string().max(200), reason: z.string().min(1).max(600),
    sourceIndexes: z.array(z.number().int().min(0).max(49)).min(1).max(5),
  }).strict()).max(5),
}).strict();

export const timingResultSchema = timingSuggestionsSchema.extend({
  sources: z.array(z.object({ title: z.string().max(300), url: sourceUrlSchema }).strict()).min(1).max(50),
  research: z.string().min(1).max(40_000),
  searchEntryPoint: z.string().max(100_000).nullable(),
}).strict();
export type TimingResult = z.infer<typeof timingResultSchema>;