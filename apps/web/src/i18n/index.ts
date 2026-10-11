import type { ReactNode } from 'react';
import { en } from './en.ts';
import type { MessageKey } from './en.ts';

export type { MessageKey };

/** Looks up a UI string and fills in {placeholders} (NF-A2). */
export function t(key: MessageKey, params: Record<string, string> = {}): string {
  return en[key].replaceAll(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}

/**
 * Like t, for a sentence with markup in it, such as a tool name in monospace: "Allow {tool} to
 * run?" with `tool` as an element. Returns the pieces in order, for React to render.
 */
export function tNodes(key: MessageKey, params: Record<string, ReactNode>): ReactNode[] {
  return en[key]
    .split(/(\{\w+\})/g)
    .filter((piece) => piece !== '')
    .map((piece) => {
      const name = /^\{(\w+)\}$/.exec(piece)?.[1];
      return name !== undefined && name in params ? params[name] : piece;
    });
}
