import type { Meta, StoryObj } from '@storybook/react-vite';
import { Turn } from './message.tsx';

const LONG_LINE = [
  'Can you review this search hook before I merge it?',
  '',
  '```ts',
  'export function useSearch(onSearch: (q: string) => void, delay = 300) {',
  '  useEffect(() => {',
  '    // debounce so we do not hit the API on every keystroke, and keep the last query around',
  '    setTimeout(() => onSearch(query), delay);',
  '  }, [query]);',
  '}',
  '```',
].join('\n');

function Thread({ text }: { text: string }) {
  return (
    <ol className="flex max-w-190 flex-col">
      <Turn text={text} filesPath="/files" />
    </ol>
  );
}

const meta = {
  title: 'Chat/Your message',
  component: Thread,
  args: { text: LONG_LINE },
} satisfies Meta<typeof Thread>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Code wider than the bubble scrolls inside it, never out past its edge. */
export const LongCodeLine: Story = {};
