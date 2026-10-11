import type { Meta, StoryObj } from '@storybook/react-vite';
import { caps } from '../../stories/fixtures.ts';
import { BudgetMeter } from './budget-meter.tsx';

const meta = {
  title: 'Patterns/2 Budget meter',
  component: BudgetMeter,
  decorators: [
    (Story) => (
      <div className="max-w-60">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BudgetMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

/** $31.20 left of a $50.00 monthly cap. */
export const Healthy: Story = { args: { caps: caps.healthy } };

/** The fixtures' workspace: $0.40 left of $1,000.00. */
export const Low: Story = { args: { caps: caps.low } };

/** The Support macros key: $25.00, never resets, used up. */
export const UsedUp: Story = { args: { caps: caps.exhausted } };

export const Open: Story = { args: { caps: caps.healthy, defaultOpen: true } };

/** In the chat header, as tall as the model picker beside it. */
export const InChatHeader: Story = { args: { caps: caps.healthy, variant: 'header' } };
