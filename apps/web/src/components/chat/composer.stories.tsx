import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Composer } from './composer.tsx';
import type { PendingFile } from './composer.tsx';

const ready: PendingFile = {
  key: 'notes',
  name: 'Pasted text.txt',
  mediaType: 'text/plain',
  size: 4_210,
  dataUrl: 'data:text/plain;base64,',
  problem: null,
};

const unreadable: PendingFile = {
  key: 'chart',
  name: 'chart.png',
  mediaType: 'image/png',
  size: 182_000,
  dataUrl: 'data:image/png;base64,',
  problem: 'Claude Haiku 4.5 cannot read this kind of file.',
};

function Box({ dropping = false, files = [] }: { dropping?: boolean; files?: PendingFile[] }) {
  const [text, setText] = useState('');
  return (
    <div className="max-w-190">
      <Composer
        text={text}
        onText={setText}
        files={files}
        onPick={() => undefined}
        onLongPaste={() => undefined}
        dropping={dropping}
        onRemove={() => undefined}
        onSubmit={() => undefined}
        onStop={() => undefined}
        streaming={false}
        busy={false}
        support={{ images: false, pdf: false }}
        status=""
        usedUp={null}
      />
    </div>
  );
}

const meta = {
  title: 'Chat/Message box',
  component: Box,
} satisfies Meta<typeof Box>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Files dragged over the conversation: the box says where they go (ADR 0106). */
export const Dropping: Story = { args: { dropping: true } };

/** A long paste turned into a document, beside a file the model cannot read. */
export const WithFiles: Story = { args: { files: [ready, unreadable] } };
