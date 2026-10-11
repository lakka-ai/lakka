import type { Meta, StoryObj } from '@storybook/react-vite';
import { TraceSteps } from './trace-steps.tsx';

const meta = {
  title: 'Patterns/8 Trace timeline step',
  component: TraceSteps,
  decorators: [
    (Story) => (
      <div className="max-w-4xl lk-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TraceSteps>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Steps: Story = {
  args: {
    expanded: ['hold'],
    steps: [
      { id: 'choose', name: 'Choosing the model', durationMs: 12 },
      {
        id: 'hold',
        name: 'Holding the budget',
        durationMs: 4,
        details: [
          ['Held', '$0.042, the most this request could cost'],
          ['Against', 'Your cap, $31.20 left'],
          ['Settled at', '$0.0094. The rest was released.'],
        ],
      },
      {
        id: 'call-1',
        name: 'Calling the model, attempt 1',
        outcome: 'Provider did not respond',
        kind: 'failed',
        durationMs: 30_000,
      },
      { id: 'call-2', name: 'Calling the model, attempt 2', durationMs: 2410 },
    ],
  },
};

/** The fixtures' traced request: moved to a cheaper model, and a tool waited for approval. */
export const WithTiming: Story = {
  args: {
    steps: [
      {
        id: 'route',
        name: 'Choosing the model',
        durationMs: 9,
        timing: { start: 0, length: 0.001 },
      },
      {
        id: 'hold',
        name: 'Holding the budget',
        outcome: 'moved to a cheaper model',
        kind: 'cheaper',
        durationMs: 6,
        timing: { start: 0.001, length: 0.001 },
      },
      {
        id: 'call',
        name: 'Calling the model',
        durationMs: 3100,
        timing: { start: 0.002, length: 0.13 },
      },
      {
        id: 'approval',
        name: 'Waiting for approval',
        outcome: 'Allowed once by Maja Lind',
        kind: 'waiting',
        dominant: true,
        durationMs: 18_000,
        timing: { start: 0.13, length: 0.75, waiting: true },
      },
      {
        id: 'tool',
        name: 'Running the tool',
        durationMs: 1200,
        timing: { start: 0.88, length: 0.05 },
      },
      {
        id: 'reply',
        name: 'Writing the reply',
        durationMs: 1590,
        timing: { start: 0.93, length: 0.07 },
      },
    ],
  },
};

/** A step with details opens; one with nothing to show is a plain row with a dash. */
export const Mixed: Story = {
  args: {
    expanded: ['route'],
    steps: [
      {
        id: 'access',
        name: 'Checking access',
        outcome: 'Allowed',
        durationMs: 2,
        timing: { start: 0, length: 0.5 },
      },
      {
        id: 'route',
        name: 'Choosing the model',
        outcome: 'Default model',
        durationMs: 1,
        details: [
          ['Asked for', 'Auto'],
          ['Rule', 'No route to match'],
          ['Picked', { name: 'Claude Haiku 4.5', id: 'anthropic:claude-haiku-4-5' }],
        ],
        timing: { start: 0.75, length: 0.25 },
      },
    ],
  },
};
