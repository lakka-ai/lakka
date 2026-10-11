import { z } from 'zod';

/*
 * The OpenAI chat-completions request, as far as we accept it (API-1, API-6, ADR 0058). Loose on
 * purpose where compatibility needs it: clients such as Open WebUI and the official SDKs send
 * optional fields we have no use for, and refusing those would break them. Fields whose meaning
 * we cannot honour are checked where the request is translated, and refused with a clear reason.
 */

const textPart = z.looseObject({ type: z.literal('text'), text: z.string() });
const imagePart = z.looseObject({
  type: z.literal('image_url'),
  image_url: z.looseObject({ url: z.string(), detail: z.string().optional() }),
});
const filePart = z.looseObject({
  type: z.literal('file'),
  file: z.looseObject({
    file_data: z.string().optional(),
    file_id: z.string().optional(),
    filename: z.string().optional(),
  }),
});
const otherPart = z.looseObject({ type: z.string() });

export const openAiContentPart = z.union([textPart, imagePart, filePart, otherPart]);

export const openAiMessage = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(openAiContentPart), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(z.unknown()).nullish(),
  tool_call_id: z.string().optional(),
});

export const openAiChatRequest = z.looseObject({
  model: z.string().min(1),
  messages: z.array(openAiMessage).min(1),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
  max_tokens: z.int().positive().nullish(),
  max_completion_tokens: z.int().positive().nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().gt(0).max(1).nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
  n: z.int().positive().nullish(),
  tools: z.array(z.unknown()).nullish(),
  tool_choice: z.unknown().optional(),
  functions: z.array(z.unknown()).nullish(),
  function_call: z.unknown().optional(),
  response_format: z.looseObject({ type: z.string() }).nullish(),
});
export type OpenAiChatRequest = z.infer<typeof openAiChatRequest>;
