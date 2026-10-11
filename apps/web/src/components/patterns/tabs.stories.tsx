import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CardSection } from './card-section.tsx';
import { PageTabs, PillTabs, PillToggles } from './tabs.tsx';

const ranges = [
  { id: 'month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: '7d', label: 'Last 7 days' },
  { id: 'custom', label: 'Custom' },
];

function Spend() {
  const [range, setRange] = useState('month');
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <PillToggles label="Date range" options={ranges} value={range} onChange={setRange} />
      <PageTabs
        label="Spend sections"
        items={[
          {
            id: 'report',
            label: 'Report',
            panel: (
              <CardSection title="Where the money went" subtitle="September, all surfaces.">
                <PillTabs
                  label="Break down spend by"
                  items={['By person', 'By model', 'By surface', 'By route'].map((label) => ({
                    id: label,
                    label,
                    panel: <p className="text-small text-muted">{label}: the table goes here.</p>,
                  }))}
                />
              </CardSection>
            ),
          },
          { id: 'budgets', label: 'Budgets and alerts', panel: <p>Budgets and alerts.</p> },
        ]}
      />
    </div>
  );
}

const meta = {
  title: 'Patterns/15 Tabs and pills',
  component: Spend,
} satisfies Meta<typeof Spend>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TabsAndPills: Story = {};
