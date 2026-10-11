import { describe, expect, it } from 'vitest';
import { detectSignals } from '../src/routing/signals.ts';

describe('deterministic signals (RT-3 step 4, E5)', () => {
  it('code_fence: a fenced block at the start of a line, with backticks or tildes', () => {
    expect(detectSignals('Why does this fail?\n```ts\nconst x: number = "a";\n```')).toEqual([
      'code_fence',
    ]);
    expect(detectSignals('  ~~~\nSELECT 1;\n~~~')).toEqual(['code_fence']);
    expect(detectSignals('```\nplain fence opening the message')).toEqual(['code_fence']);
  });

  it('code_fence: inline code and backticks mid-line do not count', () => {
    expect(detectSignals('rename the `total` column in the quarterly report')).toEqual([]);
    expect(detectSignals('he wrote ``` in the middle of a sentence')).toEqual([]);
  });

  it('code_file: a file name with a source-code extension', () => {
    for (const text of [
      'why does main.py crash on startup',
      'refactor src/routes/index.tsx into two components',
      'the build fails in ./scripts/deploy.sh',
      'look at (app.go) please',
      'what does "Program.cs" do',
      'is lib/parser.rs, the old one, still used?',
      'check Dockerfile and build.gradle.',
      'I get an error with Node.js',
    ]) {
      expect({ text, signals: detectSignals(text) }).toEqual({ text, signals: ['code_file'] });
    }
  });

  it('code_file: data files, domains, versions and abbreviations are not code', () => {
    for (const text of [
      'summarize the numbers in sales.csv',
      'update config.yaml and notes.md',
      'visit example.com for details',
      'upgrade to version 2.5 next week',
      'meet me at 10 a.m. tomorrow',
      'thanks, done.Go ahead and send it',
      'the docs live at nodejs.org',
      'the file.tsxx is not a real extension',
      'e.g. this, i.e. that, etc.',
    ]) {
      expect({ text, signals: detectSignals(text) }).toEqual({ text, signals: [] });
    }
  });

  it('reports every signal present, in the published order', () => {
    expect(detectSignals('in utils.ts:\n```\nexport {}\n```')).toEqual(['code_fence', 'code_file']);
  });
});
