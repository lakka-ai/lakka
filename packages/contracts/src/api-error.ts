import { z } from 'zod';

/**
 * Error body returned by every API endpoint. `code` is stable and documented. `details` carries
 * what a few errors need to be acted on, such as the origin to list for mcp_origin_not_allowed.
 */
export const apiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBody>;
