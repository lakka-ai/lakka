import type { Meta, StoryObj } from '@storybook/react-vite';
import { CodeBlock } from './code-block.tsx';

const args = JSON.stringify(
  {
    repository: 'lakka/lakka',
    title: 'The People table has a Role column',
    labels: ['web', 'accessibility'],
    body: 'An instance admin role was a chip beside their name in the Person cell; it is now its own column after Person.',
  },
  null,
  2,
);

const result = Array.from({ length: 30 }, (_, i) => `issue ${String(120 - i)}: open`).join('\n');

const meta = {
  title: 'Patterns/Code block',
  component: CodeBlock,
  args: { children: args },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Tool arguments: long lines scroll sideways and keep their indentation. */
export const Arguments: Story = {};

/** A tool's result, held to 16rem tall. */
export const Capped: Story = { args: { children: result, capped: true } };
