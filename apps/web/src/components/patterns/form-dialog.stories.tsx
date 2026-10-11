import type { Meta, StoryObj } from '@storybook/react-vite';
import { UnitField } from './fields.tsx';
import { FormDialog } from './form-dialog.tsx';

const meta = {
  title: 'Patterns/13 Form dialog',
  component: FormDialog,
  args: {
    isOpen: true,
    onOpenChange: () => undefined,
    onSubmit: () => undefined,
    title: 'Cap for CI bot',
    submitLabel: 'Save cap',
    children: null,
  },
} satisfies Meta<typeof FormDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SetACap: Story = {
  args: {
    destructive: { label: 'Remove cap', onPress: () => undefined },
    children: (
      <UnitField
        name="amount"
        label="Amount in US dollars"
        prefix="$"
        defaultValue="100.00"
        description="$61.20 is already used in this period."
      />
    ),
  },
};

export const SaveFailed: Story = {
  args: {
    error: {
      title: 'The cap was not saved',
      body: 'Budgets cannot be checked right now. Try again in a few minutes.',
    },
    children: (
      <UnitField name="amount" label="Amount in US dollars" prefix="$" defaultValue="100.00" />
    ),
  },
};

/** A failure the person can act on from the alert: an instance admin allows the origin (NF-S4). */
export const SaveFailedWithAction: Story = {
  args: {
    title: 'Add a tool server',
    submitLabel: 'Add and sync tools',
    error: {
      title: 'The server was not saved',
      body: 'https://mcp.example.com is not on the list of allowed origins. Allow it for every workspace, then this server is saved.',
      actions: [
        { label: 'Allow https://mcp.example.com', primary: true, onPress: () => undefined },
      ],
    },
    children: <UnitField name="url" label="Address" defaultValue="https://mcp.example.com/mcp" />,
  },
};
