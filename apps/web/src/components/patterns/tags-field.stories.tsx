import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TagsField } from './tags-field.tsx';

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The allowed email domains of a sign-in provider: nothing suggested, every value typed. */
function Domains({ initial }: { initial: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="max-w-md">
      <TagsField
        label="Allowed email domains"
        description="Leave empty to allow any domain."
        placeholder="Any domain"
        findLabel="Type a domain"
        findPlaceholder="For example example.com"
        value={value}
        onChange={setValue}
        parse={(text) => {
          const domain = text.trim().toLowerCase();
          return DOMAIN.test(domain) ? domain : undefined;
        }}
        removeLabel={(d) => `Remove ${d}`}
        hint="Type a domain, such as example.com."
        invalid="Enter a domain such as example.com."
        max={50}
      />
    </div>
  );
}

const meta = {
  title: 'Patterns/Tags field',
  component: Domains,
  args: { initial: ['northwind.example', 'contoso.example'] },
} satisfies Meta<typeof Domains>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two domains, each a tag with Remove. */
export const Typed: Story = {};

/** Nothing picked: the field says what that means. */
export const Empty: Story = { args: { initial: [] } };
