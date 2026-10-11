import { textOfFile } from '@lakka/contracts';
import type { FilePart } from '@lakka/contracts';

/*
 * A text/plain attachment as the model reads it (ADR 0106). Providers take plain text files in
 * different ways or not at all, so every model gets the text itself, delimited and named, in
 * place of the file. The contract has already checked it is UTF-8.
 */

/** The file's name as an attribute value: no quotes or line breaks to end it early. */
const nameOf = (file: FilePart) => (file.filename ?? 'document.txt').replaceAll(/["\r\n]/g, ' ');

export function textDocument(file: FilePart): string {
  return `<document name="${nameOf(file)}">\n${textOfFile(file.data) ?? ''}\n</document>`;
}
