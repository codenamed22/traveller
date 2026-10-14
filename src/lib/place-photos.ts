import { z } from "zod";

const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:");

export const placePhotoRequestSchema = z.object({
  placeId: z.string().min(1).max(300),
  index: z.number().int().min(0).max(3),
  operationId: z.uuid(),
}).strict();

const authorSchema = z.object({
  displayName: z.string().min(1),
  uri: httpsUrl.optional(),
  photoUri: httpsUrl.optional(),
}).strict();

const photoSchema = z.object({
  uri: httpsUrl,
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  authors: z.array(authorSchema),
  googleMapsUri: httpsUrl,
  flagContentUri: httpsUrl.optional(),
}).strict();

export const placePhotoResponseSchema = z.object({
  placeId: z.string(),
  index: z.number().int().min(0).max(3),
  total: z.number().int().min(0).max(4),
  photo: photoSchema.nullable(),
}).strict();

export type PlacePhoto = z.infer<typeof photoSchema>;
export type PlacePhotoResponse = z.infer<typeof placePhotoResponseSchema>;