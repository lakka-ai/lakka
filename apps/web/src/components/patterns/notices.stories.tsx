import type { Meta, StoryObj } from '@storybook/react-vite';
import { ErrorNotice, FallbackNotice, InfoNote } from './notices.tsx';

const meta = {
  title: 'Patterns/3 and 4 Notices',
  component: ErrorNotice,
} satisfies Meta<typeof ErrorNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProviderError: Story = {
  args: {
    title: 'Anthropic is not responding',
    children:
      'Try again in a minute, or pick another model. Your message is back in the box below.',
    actions: [
      { label: 'Try again', primary: true, onPress: () => undefined },
      { label: 'Pick another model', onPress: () => undefined },
    ],
  },
};

export const BudgetsUnavailable: Story = {
  args: {
    title: 'Budgets cannot be checked right now, so requests are refused',
    children:
      'Nothing was charged. Try again in a few minutes. If it keeps happening, tell your admin.',
  },
};

export const RoutingOff: Story = {
  args: { title: '' },
  render: () => (
    <InfoNote title="Routing is off in this workspace" announce>
      Replies use the default model, Claude Sonnet 4.5, unless you pick another.
    </InfoNote>
  ),
};

export const PageNote: Story = {
  args: { title: '' },
  render: () => (
    <InfoNote>
      You are a member. Workspace admins manage people, invites and settings. You can manage your
      own API keys.
    </InfoNote>
  ),
};

export const Fallback: Story = {
  args: { title: '' },
  render: () => (
    <FallbackNotice title="A cheaper model answered">
      Your budget would not cover Claude Sonnet 4.5, so Claude Haiku 4.5 answered instead. $0.40 is
      left on the workspace cap.
    </FallbackNotice>
  ),
};
