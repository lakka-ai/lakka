import type { Meta, StoryObj } from '@storybook/react-vite';
import { DataTable, RowActions, TwoLine } from './data-table.tsx';

interface Spender {
  name: string;
  sub: string;
  requests: string;
  spend: string;
  share: number;
}

// The board's "Spend by person, September 2026".
const people: Spender[] = [
  { name: 'Maja Lind', sub: 'Admin', requests: '412', spend: '$48.20', share: 1 },
  { name: 'Erik Holm', sub: 'Member', requests: '208', spend: '$22.75', share: 0.47 },
  { name: 'Sara Nyberg', sub: 'Member', requests: '96', spend: '$9.10', share: 0.19 },
  { name: 'CI bot', sub: 'API key of Maja Lind', requests: '1,120', spend: '$6.40', share: 0.13 },
  { name: 'Jonas Ek', sub: 'Member', requests: '14', spend: '$0.85', share: 0.02 },
];

function SpendByPerson({ framed }: { framed: boolean }) {
  return (
    <section aria-labelledby="by-person" className="flex max-w-2xl flex-col gap-3">
      <h2 id="by-person" className="text-heading">
        Spend by person, September 2026
      </h2>
      <DataTable
        labelledBy="by-person"
        name="Spend by person, September 2026"
        framed={framed}
        rows={people}
        rowKey={(p) => p.name}
        share={(p) => p.share}
        columns={[
          {
            key: 'person',
            header: 'Person',
            cell: (p) => <TwoLine first={p.name} second={p.sub} />,
          },
          { key: 'requests', header: 'Requests', numeric: true, cell: (p) => p.requests },
          { key: 'spend', header: 'Spend', numeric: true, cell: (p) => p.spend },
        ]}
      />
    </section>
  );
}

const meta = {
  title: 'Patterns/7 Table with decorative bars',
  component: SpendByPerson,
  args: { framed: true },
} satisfies Meta<typeof SpendByPerson>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Framed: Story = {};
export const EdgeToEdge: Story = { args: { framed: false } };

/** API keys with row actions: buttons from 768px, one Actions menu per row below. */
export const WithRowActions: Story = {
  render: () => (
    <section aria-labelledby="keys" className="flex max-w-2xl flex-col gap-3">
      <h2 id="keys" className="text-heading">
        API keys
      </h2>
      <DataTable
        labelledBy="keys"
        name="API keys"
        framed
        rows={[
          { name: 'CI bot', owner: 'Maja Lind', used: 'Never' },
          { name: 'Support macros', owner: 'Erik Holm', used: 'Sep 28' },
        ]}
        rowKey={(k) => k.name}
        columns={[
          { key: 'key', header: 'Key', cell: (k) => k.name },
          { key: 'owner', header: 'Owner', cell: (k) => k.owner },
          { key: 'used', header: 'Last used', cell: (k) => k.used },
          {
            key: 'actions',
            header: 'Actions',
            cell: (k) => (
              <RowActions
                name={k.name}
                actions={[
                  {
                    id: 'cap',
                    label: 'Set a cap',
                    name: `Set a cap for ${k.name}`,
                    onAction: () => undefined,
                  },
                  {
                    id: 'revoke',
                    label: 'Revoke',
                    name: `Revoke key ${k.name}`,
                    danger: true,
                    onAction: () => undefined,
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </section>
  ),
};
