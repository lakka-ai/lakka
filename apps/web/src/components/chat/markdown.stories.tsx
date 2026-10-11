import type { Meta, StoryObj } from '@storybook/react-vite';
import { Markdown } from './markdown.tsx';

const REPLY = [
  '# Release notes',
  '',
  'This reply has **bold**, *italic*, ~~struck~~ and `inline code`.',
  'A single newline keeps its line.',
  '',
  '## Changes',
  '',
  '- First change',
  '- Second change, with a [link to the docs](https://example.com/docs)',
  '  - A nested point',
  '',
  '1. Step one',
  '2. Step two',
  '',
  '- [x] Done',
  '- [ ] Not yet',
  '',
  '> A quoted line from the brief.',
  '',
  '```python',
  'for invoice in invoices:',
  '    print(invoice.total)',
  '```',
  '',
  '| Model | Input per million | Output per million | Reads |',
  '| --- | ---: | ---: | --- |',
  '| claude-haiku-4-5 | $1.00 | $5.00 | Images, PDFs |',
  '| gpt-5-mini | $0.25 | $2.00 | Images |',
  '',
  '| Route | Model |',
  '| --- | --- |',
  '| Code | claude-haiku-4-5 |',
  '',
  '![A chart of spend](https://example.com/chart.png)',
  '',
  'Raw HTML is dropped: <b>not bold</b><script>alert(1)</script>',
].join('\n');

function Reply({ text }: { text: string }) {
  return (
    <div className="max-w-190">
      <Markdown text={text} />
    </div>
  );
}

const meta = {
  title: 'Chat/Reply Markdown',
  component: Reply,
  args: { text: REPLY },
} satisfies Meta<typeof Reply>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Everything a reply can draw, and what it does with an image and raw HTML. */
export const Formatted: Story = {};
