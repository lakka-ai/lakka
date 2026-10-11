import { Button } from '@heroui/react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from '../icons.tsx';
import { EmptyState } from './empty-state.tsx';

const meta = {
  title: 'Patterns/Empty state',
  component: EmptyState,
  args: {
    title: 'No spend yet',
    icon: 'spend',
    children: (
      <>
        <p>
          Each request will show up here with who sent it, the model and what it cost, as soon as
          someone uses chat or an API key.
        </p>
        <p className="text-small text-muted">
          No workspace cap is set. Without one, only the instance cap limits spend here, if the
          instance admin set one.
        </p>
      </>
    ),
    action: (
      <Button size="lg" variant="primary">
        <Icon name="plus" />
        Set a workspace cap
      </Button>
    ),
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A page with nothing yet (Spend-States), and what to do about it. */
export const NoSpendYet: Story = {};
