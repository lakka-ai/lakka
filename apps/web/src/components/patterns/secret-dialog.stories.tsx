import type { Meta, StoryObj } from '@storybook/react-vite';
import { fixtures } from '../../stories/fixtures.ts';
import { SecretDialog } from './secret-dialog.tsx';

const meta = {
  title: 'Patterns/5 One-time secret dialog',
  component: SecretDialog,
  args: { isOpen: true, onSaved: () => undefined },
} satisfies Meta<typeof SecretDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ApiKey: Story = {
  args: {
    title: 'Copy your new API key',
    warning:
      'This is the only time the key is shown. Store it somewhere safe now. If you lose it, revoke it and create a new one.',
    label: `Key for ${fixtures.keys.ciBot.name}`,
    secret: fixtures.keys.ciBot.secret,
  },
};

export const RecoveryKey: Story = {
  args: {
    title: 'Save your recovery key',
    warning:
      'This key unlocks every stored credential. It is shown once. Without it, a restored backup cannot read its provider keys.',
    label: 'Recovery key',
    secret: 'lkrk_7Tq2-Wm9d-Kx4p-Lr8s-Nc3v-Hb6y-Jf1z-Qa5e-Uo0g-Pt7w',
    multiline: true,
    downloadName: 'lakka-recovery-key.txt',
  },
};
