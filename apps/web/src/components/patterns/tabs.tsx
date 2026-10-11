import type { Key, ReactNode } from 'react';
import { Tabs, ToggleButton } from '@heroui/react';

/*
 * Pattern 15, tabs and pills.
 *
 * - PageTabs, underlined, switch between sections of a page (Report, Budgets and alerts).
 * - PillTabs switch the view inside one card (By person, By model).
 * - Both are a tablist: arrow keys move between tabs, and each panel is labelled by its tab.
 * - Sizes and colors are in app.css: underline tabs 44px tall, pills a segmented control with
 *   2px padding and 10px corners (patterns.md, Controls).
 * - The selected pill has an inset 1px --muted outline and bold text (`lk-pill` in the
 *   theme), so the state never rests on a fill change, which is 1.2:1 against the track.
 * - PillToggles are for choices that are not tabs, such as the date range: toggle buttons with
 *   aria-pressed in a labelled group. On a phone the pills scroll sideways in their own row.
 */

export interface TabItem {
  id: string;
  label: string;
  panel: ReactNode;
}

interface TabsProps {
  label: string;
  items: readonly TabItem[];
  selected?: string;
  onSelectionChange?: (id: string) => void;
  className?: string;
}

const selection = ({ selected, onSelectionChange }: TabsProps) => ({
  ...(selected === undefined ? {} : { selectedKey: selected }),
  ...(onSelectionChange === undefined
    ? {}
    : { onSelectionChange: (key: Key) => onSelectionChange(String(key)) }),
});

export function PageTabs(props: TabsProps) {
  return (
    <Tabs variant="secondary" align="start" className={props.className ?? ''} {...selection(props)}>
      <Tabs.ListContainer>
        <Tabs.List aria-label={props.label}>
          {props.items.map((item) => (
            <Tabs.Tab key={item.id} id={item.id} className="w-auto flex-none">
              {item.label}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
      {props.items.map((item) => (
        // HeroUI pads a panel on every side; a page section's content lines up with the page.
        <Tabs.Panel key={item.id} id={item.id} className="px-0 pt-6 pb-0">
          {item.panel}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

export function PillTabs(props: TabsProps) {
  return (
    <Tabs variant="primary" align="start" className={props.className ?? ''} {...selection(props)}>
      <Tabs.ListContainer className="lk-pills">
        <Tabs.List aria-label={props.label}>
          {props.items.map((item) => (
            <Tabs.Tab
              key={item.id}
              id={item.id}
              className="lk-pill w-auto flex-none whitespace-nowrap"
            >
              {item.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
      {props.items.map((item) => (
        <Tabs.Panel key={item.id} id={item.id} className="lk-pill-panel">
          {item.panel}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

export function PillToggles({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="lk-pills flex">
      {options.map((option) => (
        <ToggleButton
          key={option.id}
          isSelected={option.id === value}
          onChange={() => onChange(option.id)}
          className="lk-pill shrink-0 whitespace-nowrap"
        >
          {option.label}
        </ToggleButton>
      ))}
    </div>
  );
}
