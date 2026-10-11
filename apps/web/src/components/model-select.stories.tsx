import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ModelView } from '@lakka/contracts';
import { ModelSelect } from './model-select.tsx';

const model = (id: string, displayName: string): ModelView =>
  ({
    id,
    displayName,
    prices: {
      inputMicroUsdPerMtok: 1_000_000,
      outputMicroUsdPerMtok: 5_000_000,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  }) as unknown as ModelView;

const models = [
  model('anthropic:claude-haiku-4-5', 'Claude Haiku 4.5'),
  model('anthropic:claude-sonnet-4-5', 'Claude Sonnet 4.5'),
  model('openai:gpt-4.1-mini', 'GPT-4.1 mini'),
  model('openai:gpt-4.1-mini-2025-04-14', 'GPT-4.1 mini 2025.04 14'),
  model('openai:gpt-4o-mini', 'GPT-4o mini'),
  model('openai:gpt-5-mini', 'GPT-5 mini'),
  model('openai:gpt-5-mini-2025-08-07', 'GPT-5 mini 2025.08 07'),
  model('openai:gpt-5.4', 'GPT-5.4'),
  model('openai:gpt-5.4-mini', 'GPT-5.4 mini'),
  model('openai:gpt-5.4-mini-2026-03-17', 'GPT-5.4 mini 2026.03 17'),
  model('openai:gpt-5.4-nano', 'GPT-5.4 nano'),
  model('openai:gpt-6-luna', 'GPT-6 Luna'),
  model('mistral:mistral-small', 'Mistral Small'),
  model('ollama:mistral-small', 'Mistral Small'),
];

/** About as many as the bundled catalogue offers, to see the list open and scroll at size. */
const catalogue = [
  ...models,
  ...Array.from({ length: 105 }, (_, i) =>
    model(`provider${i % 6}:model-${i}`, `Model ${String(i).padStart(3, '0')}`),
  ),
];

function Pinned({ setting = false, many = false }: { setting?: boolean; many?: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <div className={setting ? 'max-w-2xl' : 'max-w-sm'}>
      <ModelSelect
        label="Pinned model"
        description="When set, every request uses this model."
        models={many ? catalogue : models}
        value={value}
        onChange={setValue}
        allowNone
        setting={setting}
      />
    </div>
  );
}

const meta = {
  title: 'Components/Model select',
  component: Pinned,
} satisfies Meta<typeof Pinned>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each option shows its id under its name; two providers serve Mistral Small. */
export const WithSearch: Story = {};

/** As a row of a settings section (Pattern 12), as the Routing page shows it. */
export const AsSetting: Story = { args: { setting: true } };

/** The size of the bundled catalogue, as a settings row. */
export const Catalogue: Story = { args: { setting: true, many: true } };
