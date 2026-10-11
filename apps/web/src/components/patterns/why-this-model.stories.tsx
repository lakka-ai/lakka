import type { Meta, StoryObj } from '@storybook/react-vite';
import { fixtures } from '../../stories/fixtures.ts';
import { DecisionChip, WhyThisModel } from './why-this-model.tsx';

/** As on a reply: the chip next to the model's name. */
function NextToModel(props: Parameters<typeof WhyThisModel>[0]) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-body font-semibold">Claude Sonnet 4.5</span>
      <WhyThisModel {...props} />
    </div>
  );
}

const meta = {
  title: 'Patterns/1 Why this model',
  component: WhyThisModel,
} satisfies Meta<typeof WhyThisModel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Routed: Story = {
  args: {
    decision: {
      kind: 'routed',
      reason: 'Routing matched the message to the Code route. Confidence 92%.',
      modelId: 'anthropic:claude-sonnet-4-5',
      route: 'Code',
      cost: '$0.0094',
      trace: { workspaceId: fixtures.workspace.id, requestId: fixtures.requestId },
    },
  },
  render: (args) => <NextToModel {...args} />,
};

export const Open: Story = {
  args: { ...Routed.args, defaultOpen: true },
  render: (args) => <NextToModel {...args} />,
};

export const Fallback: Story = {
  args: {
    decision: {
      kind: 'fallback',
      reason:
        'Your budget would not cover Claude Sonnet 4.5, so Claude Haiku 4.5 answered instead.',
      modelId: 'anthropic:claude-haiku-4-5',
      route: 'Code',
      cost: '$0.0073',
      trace: { workspaceId: fixtures.workspace.id, requestId: fixtures.requestId },
    },
  },
};

export const AllVariants: Story = {
  args: Routed.args,
  render: () => (
    <div className="flex flex-wrap gap-2">
      <DecisionChip decision={{ kind: 'routed', route: 'Code' }} />
      <DecisionChip decision={{ kind: 'chosen' }} />
      <DecisionChip decision={{ kind: 'default' }} />
      <DecisionChip decision={{ kind: 'pinned' }} />
      <DecisionChip decision={{ kind: 'fallback' }} />
      <DecisionChip decision={{ kind: 'refused' }} />
    </div>
  ),
};
