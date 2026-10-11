import type { Meta, StoryObj } from '@storybook/react-vite';
import { UnitField, WriteOnlyField } from './fields.tsx';

const meta = {
  title: 'Patterns/6 and 11 Fields',
  component: WriteOnlyField,
  args: { label: 'Anthropic API key', isSet: false },
} satisfies Meta<typeof WriteOnlyField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WriteOnly: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-5">
      <WriteOnlyField label="Anthropic API key" isSet={false} />
      <WriteOnlyField label="OpenAI API key" isSet setDetail="Set on Sep 12 by Maja Lind." />
    </div>
  ),
};

export const WithUnits: Story = {
  render: () => (
    <div className="grid max-w-xl gap-5 sm:grid-cols-2">
      <UnitField
        label="Input price per million tokens"
        srLabel=", in US dollars"
        prefix="$"
        defaultValue="3.00"
      />
      <UnitField
        label="Context window"
        suffix="tokens"
        defaultValue="200,000"
        inputMode="numeric"
      />
      <UnitField
        label="Keep for"
        suffix="days"
        defaultValue="30"
        inputMode="numeric"
        alignEnd
        className="max-w-36"
      />
      <UnitField
        label="Add an alert percentage"
        suffix="%"
        hideSuffix
        placeholder="Add, for example 50"
        inputMode="numeric"
      />
    </div>
  ),
};

/** A required secret left empty: the error takes the help's place, tied to the input. */
export const WriteOnlyWithError: Story = {
  render: () => (
    <div className="max-w-xl">
      <WriteOnlyField
        label="Client secret"
        isSet={false}
        isRequired
        isInvalid
        error="Paste the client secret from your identity provider."
      />
    </div>
  ),
};
