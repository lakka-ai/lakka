import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToolSwitch } from './tool-switch.tsx';

function Row({
  label,
  initial,
  disabledReason,
}: {
  label: string;
  initial: boolean;
  disabledReason?: string;
}) {
  const [on, setOn] = useState(initial);
  return (
    <li className="flex items-center justify-between gap-6 border-b border-separator py-3">
      <span>{label}</span>
      <ToolSwitch
        label={label}
        isSelected={on}
        onChange={setOn}
        {...(disabledReason === undefined ? {} : { disabledReason })}
      />
    </li>
  );
}

const meta = {
  title: 'Patterns/12 Settings section/Tool switch',
  component: ToolSwitch,
  args: { label: 'Enabled', isSelected: true, onChange: () => undefined },
} satisfies Meta<typeof ToolSwitch>;

export default meta;
type Story = StoryObj<typeof meta>;

/** On, off, and one an admin has to allow first: it stays focusable and says why. */
export const Switches: Story = {
  render: () => (
    <ul className="flex max-w-md flex-col">
      <Row label="Enabled, search_issues" initial />
      <Row label="Enabled, create_issue" initial={false} />
      <Row
        label="Enabled, delete_repo"
        initial={false}
        disabledReason="An instance admin has to allow this tool first."
      />
    </ul>
  ),
};
