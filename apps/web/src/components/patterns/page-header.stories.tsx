import { Button } from '@heroui/react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from '../icons.tsx';
import { PageHeader } from './page-header.tsx';
import { PillToggles } from './tabs.tsx';
import { StatusChip } from './status-chip.tsx';

const meta = {
  title: 'Patterns/Page header',
  component: PageHeader,
  args: {
    title: 'Routing',
    lede: 'Choose which model answers each kind of request in Product. People can always pick a model themselves.',
  },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The title and lede alone. */
export const TitleAndLede: Story = {};

/** A page's main action, lined up with the lede's last line. */
export const WithAction: Story = {
  args: {
    title: 'Workspaces',
    lede: 'Every workspace on this instance, with its admins and what it spent this month.',
    actions: (
      <Button size="lg" variant="primary">
        <Icon name="plus" />
        Create workspace
      </Button>
    ),
  },
};

/** Date pills, which scroll in their own row on a phone. */
export const WithPills: Story = {
  args: {
    title: 'Spend and budgets',
    lede: 'What Product spent, on what, and the caps that limit it.',
    actions: (
      <PillToggles
        label="Dates"
        options={[
          { id: 'month', label: 'This month' },
          { id: 'last', label: 'Last month' },
          { id: '30', label: 'Last 30 days' },
          { id: '90', label: 'Last 90 days' },
        ]}
        value="month"
        onChange={() => undefined}
      />
    ),
  },
};

/** The trace page: its outcome chip lines up with the top. */
export const AlignedToTop: Story = {
  args: {
    title: 'Trace',
    alignActions: 'start',
    actions: (
      <StatusChip tone="success" icon="check">
        Answered
      </StatusChip>
    ),
  },
};
