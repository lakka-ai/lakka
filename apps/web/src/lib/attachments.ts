import { TEXT_MEDIA_TYPE } from '@lakka/contracts';

/*
 * What chat does with files it is given, by Attach files, a drop or a paste (CH-5, ADR 0106).
 * Text files of many kinds, notes, code, data, are all sent as plain UTF-8 text, the one text
 * type the gateway takes; their names keep what they were. A long paste becomes a text file too,
 * so the message stays readable and the text arrives whole.
 */

/** A paste longer than this becomes a document instead of message text. */
export const LONG_PASTE_CHARS = 2_000;

/** Media types, other than text/*, that are text. */
const TEXT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
  'application/x-ndjson',
]);

/** File name endings that are text, for files the browser gives no type or a vague one. */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'rst',
  'adoc',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'log',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'm',
  'php',
  'pl',
  'lua',
  'r',
  'jl',
  'dart',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'sql',
  'graphql',
  'proto',
  'vue',
  'svelte',
  'tex',
  'srt',
  'vtt',
]);

/** What Attach files offers for text, beside the images and PDFs the model may read. */
export const TEXT_ACCEPT = ['text/*', ...TEXT_TYPES, ...[...TEXT_EXTENSIONS].map((e) => `.${e}`)];

const extension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** Whether a file is text, by its type or, failing that, its name. */
export function isTextFile(file: { name: string; type: string }): boolean {
  const type = file.type.toLowerCase().split(';')[0]?.trim() ?? '';
  if (type.startsWith('text/') || TEXT_TYPES.has(type)) return true;
  // Browsers give many text files no type, or one that says nothing, such as octet-stream.
  return (
    (type === '' || type === 'application/octet-stream') &&
    TEXT_EXTENSIONS.has(extension(file.name))
  );
}

/** The bytes as base64. */
function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * A text file as chat sends it: a text/plain data URL of its bytes, or undefined when they are
 * not UTF-8, which the gateway would refuse.
 */
export function textDataUrl(bytes: Uint8Array): string | undefined {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return `data:${TEXT_MEDIA_TYPE};base64,${base64Of(bytes)}`;
}

/** A name for a pasted document that none of the files already chosen has. */
export function pastedName(taken: readonly string[], base: string): string {
  const names = new Set(taken);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? `${base}.txt` : `${base} ${n}.txt`;
    if (!names.has(name)) return name;
  }
}

/**
 * The files a paste attaches. Copying a file in a file manager puts its name on the clipboard as
 * text as well, and copying spreadsheet cells puts a picture of them beside their text. So files
 * are taken only when the text is empty or is just their names; otherwise the text is pasted.
 */
export function pastedFiles(files: readonly File[], text: string): File[] {
  if (files.length === 0) return [];
  const names = new Set(files.map((f) => f.name));
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.every((line) => names.has(line)) ? [...files] : [];
}

/** Whether a drag carries files, so the page offers to take them. */
export const carriesFiles = (types: readonly string[]) => types.includes('Files');
