import type { Meta, StoryObj } from '@storybook/react-vite';
import { CardInset, CardSection, EmptyList, Pager } from './card-section.tsx';
import { DataTable } from './data-table.tsx';
import { ErrorNotice } from './notices.tsx';
import { StatusChip } from './status-chip.tsx';

interface Sent {
  when: string;
  alert: string;
  delivered: boolean;
}

const sent: Sent[] = [
  { when: 'Sep 28, 09:14', alert: 'Workspace cap reached 80%', delivered: true },
  { when: 'Sep 22, 11:02', alert: 'Key Support macros reached 100%', delivered: false },
];

function AlertsSent() {
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <CardSection
        title="Alerts sent"
        subtitle="Posted to the workspace webhook."
        titleId="alerts-sent"
      >
        <DataTable
          labelledBy="alerts-sent"
          name="Alerts sent"
          framed
          rows={sent}
          rowKey={(r) => r.when}
          columns={[
            {
              key: 'when',
              header: 'When',
              numeric: false,
              cell: (r) => <span className="lk-num">{r.when}</span>,
            },
            { key: 'alert', header: 'Alert', cell: (r) => r.alert },
            {
              key: 'result',
              header: 'Result',
              cell: (r) =>
                r.delivered ? (
                  <StatusChip tone="success">Delivered</StatusChip>
                ) : (
                  <StatusChip tone="danger">Not delivered</StatusChip>
                ),
            },
          ]}
        />
      </CardSection>
      <Pager
        from={1}
        to={2}
        total={9}
        hasPrevious={false}
        hasNext
        byTime
        onPrevious={() => undefined}
        onNext={() => undefined}
      />
    </div>
  );
}

const meta = {
  title: 'Patterns/14 Card header, inner table and paging',
  component: AlertsSent,
} satisfies Meta<typeof AlertsSent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InnerTableAndPaging: Story = {};

export const PreviousAndNext: Story = {
  render: () => (
    <div className="max-w-2xl">
      <Pager
        from={1}
        to={7}
        total={31}
        hasPrevious={false}
        hasNext
        onPrevious={() => undefined}
        onNext={() => undefined}
      />
    </div>
  ),
};

/** A flush card's table, with a notice above it 20px in, level with the first column. */
export const FlushWithNotice: Story = {
  render: () => (
    <div className="max-w-2xl">
      <CardSection title="Members" titleId="members" flush>
        <CardInset>
          <ErrorNotice title="That did not work. Try again in a minute." />
        </CardInset>
        <DataTable
          labelledBy="members"
          name="Members"
          rows={[{ name: 'Maja Lind', role: 'Admin' }]}
          rowKey={(r) => r.name}
          columns={[
            { key: 'name', header: 'Person', cell: (r) => r.name },
            { key: 'role', header: 'Role', cell: (r) => r.role },
          ]}
        />
      </CardSection>
    </div>
  ),
};

/**
 * An empty list is one muted line (ADR 0112): under the header of a flush card and of a padded
 * one, and in a card of its own where the list has no card, as a filter that matches nothing.
 */
export const EmptyLists: Story = {
  render: () => (
    <div className="flex max-w-2xl flex-col gap-6">
      <CardSection title="Invites" titleId="invites" flush>
        <EmptyList>No open invites. Invite someone to add them to this workspace.</EmptyList>
      </CardSection>
      <CardSection title="Recent overrides" titleId="overrides">
        <EmptyList>Nobody picked a model by hand in the last 30 days.</EmptyList>
      </CardSection>
      <EmptyList>Nobody matches that search.</EmptyList>
    </div>
  ),
};

/** A chip that says the card's state sits right after the title. */
export const WithBadge: Story = {
  render: () => (
    <div className="max-w-2xl">
      <CardSection title="Trace export" badge={<StatusChip tone="success">Exporting</StatusChip>}>
        <p>Traces go to the OpenTelemetry collector at otel.example.com.</p>
      </CardSection>
    </div>
  ),
};
