import type { Meta, StoryObj } from '@storybook/react-vite';
import { fixtures } from '../../stories/fixtures.ts';
import { ConfirmDialog, TypedConfirmDialog } from './confirm-dialog.tsx';

const meta = {
  title: 'Patterns/10 Destructive confirmation',
  component: TypedConfirmDialog,
  args: {
    isOpen: true,
    onOpenChange: () => undefined,
    onConfirm: () => undefined,
    title: `Delete ${fixtures.people.erik.name} permanently?`,
    children: 'This cannot be undone. Export their data first if you need a copy.',
    confirmLabel: 'Delete permanently',
    expected: fixtures.people.erik.email,
  },
} satisfies Meta<typeof TypedConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TypedConfirmation: Story = {};

export const PlainConfirm: Story = {
  render: () => (
    <ConfirmDialog
      isOpen
      onOpenChange={() => undefined}
      onConfirm={() => undefined}
      title={`Revoke key ${fixtures.keys.ciBot.name}?`}
      confirmLabel="Revoke key"
    >
      Requests with this key stop working at once. You can create a new key at any time.
    </ConfirmDialog>
  ),
};
