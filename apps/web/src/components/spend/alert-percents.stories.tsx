import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertPercentsField } from './alert-percents.tsx';

function Field({ saved }: { saved: number[] }) {
  const [value, setValue] = useState(saved);
  return (
    <div className="max-w-md">
      <AlertPercentsField value={value} onChange={setValue} />
    </div>
  );
}

const meta = {
  title: 'Spend/Alert percentages',
  component: Field,
  args: { saved: [80, 100] },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The fixtures' workspace cap: alerts at 80% and 100%, picked from every 10 percent. */
export const Picked: Story = {};

/** A cap with 75%, typed or set through the api, off the 10 percent grid: it shows and can go. */
export const OffTheGrid: Story = { args: { saved: [50, 75] } };

/** Five picked, the most a cap takes: the other options wait until one is removed. */
export const Full: Story = { args: { saved: [10, 30, 50, 80, 100] } };

/** No alerts: the field says so. */
export const None: Story = { args: { saved: [] } };
