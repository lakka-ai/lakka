import { Description, Input, Label, ListBox, RadioGroup, Select, TextField } from '@heroui/react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { UnitField } from './fields.tsx';
import {
  CheckboxSetting,
  RadioDetails,
  RadioOption,
  ReadOnlySetting,
  SettingsSection,
} from './settings.tsx';

const meta = {
  title: 'Patterns/12 Settings section',
  component: SettingsSection,
  args: { title: 'Settings', children: null, onSave: () => undefined },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SettingsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

const models = ['Claude Sonnet 4.5', 'Claude Haiku 4.5', 'GPT-4.1 mini'];

export const Routing: Story = {
  args: {
    saved: true,
    children: (
      <>
        <CheckboxSetting
          label="Choose models automatically"
          description="People see Auto in the model picker."
          defaultSelected
        />
        <Select className="lk-setting" defaultValue="Claude Sonnet 4.5">
          <Label>Default model</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>Used when no route matches.</Description>
          <Select.Popover>
            <ListBox>
              {models.map((m) => (
                <ListBox.Item key={m} id={m} textValue={m}>
                  {m}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <UnitField
          setting
          label="Keep recorded text for"
          suffix="days"
          alignEnd
          inputMode="numeric"
          defaultValue="30"
          description="From 1 to 90 days."
        />
      </>
    ),
  },
};

/** What a member sees: the same rows, read-only, and no Save. */
export const ReadOnly: Story = {
  args: {
    title: 'Content capture',
    subtitle: 'Workspace admins set this.',
    children: (
      <>
        <ReadOnlySetting label="Record prompts and replies" value="Off" />
        <ReadOnlySetting label="Keep recorded text for" value="30 days" />
      </>
    ),
  },
  render: (args) => {
    const { onSave: _onSave, ...rest } = args;
    return <SettingsSection {...rest} />;
  },
};

/**
 * Radios with descriptions, plain (Set a cap) and as option cards (Add a tool server), with what
 * the chosen one asks for right under it.
 */
export const RadioOptions: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-8">
      <RadioGroup defaultValue="monthly" className="flex flex-col gap-2">
        <Label>Resets</Label>
        <RadioOption value="daily" label="Daily" description="Starts again at midnight UTC." />
        <RadioOption
          value="monthly"
          label="Monthly"
          description="Starts again on the 1st, at midnight UTC."
        />
        <RadioOption value="none" label="Never" description="Spend adds up until you change it." />
      </RadioGroup>
      <RadioGroup defaultValue="streamable_http" className="flex flex-col gap-2">
        <Label>How Lakka reaches it</Label>
        <RadioOption
          card
          value="streamable_http"
          label="Streamable HTTP"
          description="A server at a web address."
        />
        <RadioDetails>
          <TextField defaultValue="https://mcp.example.com" type="url">
            <Label>Address</Label>
            <Input spellCheck={false} />
          </TextField>
        </RadioDetails>
        <RadioOption
          card
          value="stdio"
          label="A command"
          description="Only an instance admin can add one."
          isDisabled
        />
      </RadioGroup>
    </div>
  ),
};
