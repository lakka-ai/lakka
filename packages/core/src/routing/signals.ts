import { ROUTING_SIGNALS } from '@lakka/contracts';
import type { RoutingSignal } from '@lakka/contracts';

/*
 * Deterministic signals (tech spec, resolution order step 4; E5; ADR 0046). A fixed, published
 * list, so the behaviour is predictable: admins choose which route claims a signal, not what the
 * signal means. Each check is a plain text test on the message the conversation is routed on.
 *
 * - code_fence: a fenced code block, a line that starts with ``` or ~~~. Inline `code` does not
 *   count; people quote names that way in ordinary prose.
 * - code_file: a file name with a source-code extension, such as `src/app.ts` or `main.py`.
 *   Data and document formats (json, yaml, csv, md, txt) are left out: a message about a CSV is
 *   as likely to be analysis as code.
 */

export const CODE_FILE_EXTENSIONS = [
  'bash',
  'c',
  'cc',
  'cjs',
  'clj',
  'cpp',
  'cs',
  'cxx',
  'dart',
  'erl',
  'ex',
  'exs',
  'fs',
  'go',
  'gradle',
  'h',
  'hpp',
  'hs',
  'java',
  'jl',
  'js',
  'jsx',
  'kt',
  'kts',
  'lua',
  'ml',
  'mjs',
  'php',
  'pl',
  'ps1',
  'py',
  'rb',
  'rs',
  'scala',
  'sh',
  'sol',
  'sql',
  'svelte',
  'swift',
  'tf',
  'ts',
  'tsx',
  'vue',
  'zig',
  'zsh',
] as const;

const CODE_FENCE = /^[ \t]*(```|~~~)/m;
/*
 * A name of word characters, dots, slashes or dashes that ends in ".<extension>" and stands on
 * its own, so "file.tsx" is not read as "file.ts" and "node.js.org" is not a file. Extensions are
 * matched in lower case only: "done.Go ahead", a missing space after a full stop, is not Go.
 */
const CODE_FILE = new RegExp(
  String.raw`(?:^|[^\w.\/-])[\w.\/-]*\w\.(?:${CODE_FILE_EXTENSIONS.join('|')})(?![\w\/-]|\.\w)`,
);

const CHECKS: Readonly<Record<RoutingSignal, (text: string) => boolean>> = {
  code_fence: (text) => CODE_FENCE.test(text),
  code_file: (text) => CODE_FILE.test(text),
};

/** The signals present in a message, in the published order. */
export function detectSignals(text: string): RoutingSignal[] {
  return ROUTING_SIGNALS.filter((signal) => CHECKS[signal](text));
}
