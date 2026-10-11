import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { RequestableView } from '@lakka/contracts';
import { ModelPicker } from './model-picker.tsx';

const reads = { images: true, pdf: true };
const text = { images: false, pdf: false };

const models: RequestableView['models'] = [
  { id: 'anthropic:claude-fable-5', displayName: 'Claude Fable 5', input: reads },
  { id: 'anthropic:claude-haiku-4-5', displayName: 'Claude Haiku 4.5', input: reads },
  { id: 'bedrock:claude-haiku-4-5', displayName: 'Claude Haiku 4.5', input: reads },
  { id: 'anthropic:claude-opus-4-5', displayName: 'Claude Opus 4.5', input: reads },
  { id: 'openai:gpt-5-mini', displayName: 'GPT-5 mini', input: reads },
  { id: 'mistral:mistral-small', displayName: 'Mistral Small', input: text },
];

const requestable = (many: boolean): RequestableView => ({
  auto: reads,
  routes: [
    {
      name: 'coding',
      model: 'anthropic:claude-haiku-4-5',
      modelName: 'Claude Haiku 4.5',
      input: reads,
    },
  ],
  models: many
    ? [
        ...models,
        // About as many as the bundled catalogue offers, to see the list open and scroll at size.
        ...Array.from({ length: 110 }, (_, i) => ({
          id: `provider${i % 6}:model-${i}`,
          displayName: `Model ${String(i).padStart(3, '0')}`,
          input: text,
        })),
      ]
    : models,
  routing: { enabled: true, defaultModel: null, pinnedModel: null },
});

function Picker({ many = false }: { many?: boolean }) {
  const [choice, setChoice] = useState<string | null>(null);
  return (
    <div className="flex justify-end">
      <ModelPicker
        requestable={requestable(many)}
        choice={choice}
        onChange={setChoice}
        variant="header"
        id="model-picker"
      />
    </div>
  );
}

const meta = {
  title: 'Chat/Model picker',
  component: Picker,
} satisfies Meta<typeof Picker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each model shows its id under its name, and what it reads as icons. */
export const WithSearch: Story = {};

/** The size of the bundled catalogue. */
export const Catalogue: Story = { args: { many: true } };
