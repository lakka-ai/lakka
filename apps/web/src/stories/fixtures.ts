import type { MeterCap } from '../lib/budget-meter.ts';

/*
 * The sample story that runs through every design board (docs/design/docs/fixtures.md), for
 * stories and tests, so a component can be compared with its board. Model prices here are
 * examples, never real data.
 */

const usd = (dollars: string) => {
  const [whole = '0', cents = '00'] = dollars.replaceAll(',', '').split('.');
  return String(BigInt(whole) * 1_000_000n + BigInt(cents.padEnd(6, '0')));
};

export const fixtures = {
  server: 'ai.nordlys.se',
  workspace: { id: '01a0ed4c-9213-734a-bf60-7c1974ec97ce', name: 'Product' },
  requestId: '01a0ed4c-aaaa-7bbb-8ccc-000000000001',
  people: {
    maja: { name: 'Maja Lind', email: 'maja@nordlys.se' },
    jonas: { name: 'Jonas Ek', email: 'jonas@nordlys.se' },
    erik: { name: 'Erik Holm', email: 'erik.holm@nordlys.se' },
    sara: { name: 'Sara Nyberg', email: 'sara@nordlys.se' },
    lina: { name: 'Lina Berg' },
    nils: { name: 'Nils Strand', email: 'nils@nordlys.se' },
  },
  keys: {
    ciBot: { name: 'CI bot', secret: 'lk_4Qm8Zr2vT9sLxW1pNc6yHb0eKd3uJfA7' },
    supportMacros: { name: 'Support macros' },
    notebook: { name: 'Notebook' },
  },
} as const;

/** Caps as the budget meter takes them. */
export const caps = {
  healthy: [
    {
      name: 'Your cap',
      limitMicro: usd('50.00'),
      usedMicro: usd('18.80'),
      period: 'Every month.',
      resets: 'Resets Oct 1',
    },
    {
      name: 'Workspace cap',
      limitMicro: usd('1,000.00'),
      usedMicro: usd('588.00'),
      period: 'Every month.',
      resets: 'Resets Oct 1',
    },
  ],
  low: [
    {
      name: 'Your cap',
      limitMicro: usd('200.00'),
      usedMicro: usd('182.40'),
      period: 'Every month.',
      resets: 'Resets Oct 1',
    },
    {
      name: 'Workspace cap',
      limitMicro: usd('1,000.00'),
      usedMicro: usd('999.60'),
      period: 'Every month.',
      resets: 'Resets Oct 1',
    },
  ],
  exhausted: [
    {
      name: 'Key cap',
      limitMicro: usd('25.00'),
      usedMicro: usd('25.00'),
      period: 'Never resets.',
    },
  ],
} satisfies Record<string, MeterCap[]>;
