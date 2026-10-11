import type { Meta, StoryObj } from '@storybook/react-vite';
import { fixtures } from '../../stories/fixtures.ts';
import { KeyApprovalNotice, ToolApprovalCard } from './tool-approval.tsx';

const meta = {
  title: 'Patterns/9 Tool approval card',
  component: ToolApprovalCard,
  args: {
    tool: 'github.create_pull_request',
    source: 'From the GitHub tool server. It acts as your GitHub account, maja-lind.',
    args: 'repo: nordlys/billing\nbase: main\nhead: fix/invoice-query\ntitle: Load invoice rows in one query',
    onAllowOnce: () => undefined,
    onAlwaysAllow: () => undefined,
    onDeny: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ToolApprovalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Approval: Story = {};

/** Arguments are shown as text: markup in them is never rendered. */
export const UntrustedArguments: Story = {
  args: { args: 'title: <img src=x onerror=alert(1)> [click](https://example.com)' },
};

export const FromAnApiKey: Story = {
  render: () => (
    <KeyApprovalNotice keyName={fixtures.keys.ciBot.name} tool="github.create_pull_request" />
  ),
};
