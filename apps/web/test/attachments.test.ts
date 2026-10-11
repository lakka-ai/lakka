import { describe, expect, it } from 'vitest';
import { acceptedTypes } from '../src/components/chat/composer.tsx';
import {
  carriesFiles,
  isTextFile,
  LONG_PASTE_CHARS,
  pastedFiles,
  pastedName,
  textDataUrl,
} from '../src/lib/attachments.ts';

/* Files given to chat by Attach files, a drop or a paste (CH-5, ADR 0106). */

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('text files (CH-5, ADR 0106)', () => {
  it('CH-5: text is known by its type, or by its name when the browser gives no useful type', () => {
    expect(isTextFile(file('notes.txt', 'text/plain'))).toBe(true);
    expect(isTextFile(file('a.csv', 'text/csv; charset=utf-8'))).toBe(true);
    expect(isTextFile(file('data.json', 'application/json'))).toBe(true);
    expect(isTextFile(file('main.ts', ''))).toBe(true);
    expect(isTextFile(file('README.md', 'application/octet-stream'))).toBe(true);
    expect(isTextFile(file('photo.png', 'image/png'))).toBe(false);
    expect(isTextFile(file('report.pdf', 'application/pdf'))).toBe(false);
    expect(isTextFile(file('archive.zip', 'application/zip'))).toBe(false);
    expect(isTextFile(file('binary', ''))).toBe(false);
  });

  it('CH-5: a text file is sent as plain UTF-8 text, and one that is not UTF-8 is not sent', () => {
    const utf8 = new TextEncoder().encode('Grüße');
    expect(textDataUrl(utf8)).toBe(`data:text/plain;base64,${btoa('GrÃ¼Ã\u009fe')}`);
    expect(textDataUrl(new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]))).toBeUndefined();
  });

  it('CH-5: Attach files offers text files whatever the model reads', () => {
    const none = acceptedTypes({ images: false, pdf: false });
    expect(none).toContain('text/*');
    expect(none).toContain('.md');
    expect(none).not.toContain('application/pdf');
    expect(acceptedTypes({ images: true, pdf: true })).toEqual(
      expect.arrayContaining(['image/png', 'application/pdf', 'text/*']),
    );
  });
});

describe('pasting (CH-5, ADR 0106)', () => {
  it('CH-5: a paste over 2,000 characters becomes a document named so no two clash', () => {
    expect(LONG_PASTE_CHARS).toBe(2_000);
    expect(pastedName([], 'Pasted text')).toBe('Pasted text.txt');
    expect(pastedName(['Pasted text.txt', 'Pasted text 2.txt'], 'Pasted text')).toBe(
      'Pasted text 3.txt',
    );
  });

  it('CH-5: pasted files are attached when the text beside them is empty or only their names', () => {
    const png = file('shot.png', 'image/png');
    expect(pastedFiles([png], '')).toEqual([png]);
    // A file copied in a file manager carries its name as text too.
    expect(pastedFiles([png], 'shot.png\n')).toEqual([png]);
    // Spreadsheet cells come with a picture of them; their text wins.
    expect(pastedFiles([png], 'Q1\t120\nQ2\t140')).toEqual([]);
    expect(pastedFiles([], 'text')).toEqual([]);
  });

  it('CH-5: only a drag that carries files is taken', () => {
    expect(carriesFiles(['Files'])).toBe(true);
    expect(carriesFiles(['text/plain', 'text/html'])).toBe(false);
  });
});
