import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '@heroui/react';
import { ViewDialog } from './form-dialog.tsx';

/* Pattern 13 for a list to act on, as the Routing page shows messages routed to a route. */

const meta = {
  title: 'Patterns/13 Form dialog/View dialog',
  component: ViewDialog,
  args: {
    isOpen: true,
    onOpenChange: () => undefined,
    title: 'Messages routed to Summary',
    doneLabel: 'Done',
    children: null,
  },
} satisfies Meta<typeof ViewDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MessagesToReview: Story = {
  args: {
    children: (
      <section aria-labelledby="chose-strong" className="flex flex-col gap-2">
        <h3 id="chose-strong" className="text-label font-semibold">
          People chose Claude Opus
        </h3>
        <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">
          {[
            'Summarize the incident review and list what we should change in the on-call rota.',
            'Give me a short summary of the contract changes, with the clauses that moved.',
          ].map((text, i) => (
            <li key={text} className="flex flex-col gap-2 px-3.5 py-3">
              <p id={`text-${i}`} className="text-body break-words whitespace-pre-wrap">
                {text}
              </p>
              <p className="text-small text-muted">Sep 28. Chose Claude Opus. Kept until Oct 5.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" aria-describedby={`text-${i}`}>
                  Add to a route
                </Button>
                <Button variant="ghost" aria-describedby={`text-${i}`}>
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    ),
  },
};
