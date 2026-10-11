import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusChip } from './status-chip.tsx';

const meta = {
  title: 'Patterns/Status chip',
  component: StatusChip,
  args: { tone: 'success', children: 'Healthy' },
} satisfies Meta<typeof StatusChip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every tone, with the icon a state that carries meaning comes with (tokens.md). */
export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <StatusChip tone="success" icon="check">
        Healthy
      </StatusChip>
      <StatusChip tone="warning" icon="warning">
        Low
      </StatusChip>
      <StatusChip tone="danger" icon="ban">
        Used up
      </StatusChip>
      <StatusChip tone="neutral">No cap</StatusChip>
      <StatusChip tone="outline">Admin</StatusChip>
      <StatusChip tone="accent">Exporting</StatusChip>
      <StatusChip tone="cheaper" icon="cheaper">
        Cheaper model
      </StatusChip>
      <StatusChip tone="refused" icon="ban">
        Refused
      </StatusChip>
    </div>
  ),
};
