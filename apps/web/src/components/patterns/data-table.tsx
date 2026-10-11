import { useEffect, useRef } from 'react';
import type { Key, ReactNode, RefObject } from 'react';
import { Button, Dropdown, Label, Table } from '@heroui/react';
import { t } from '../../i18n/index.ts';
import { Icon } from '../icons.tsx';

/*
 * Pattern 7, the table (with decorative bars where rows are a share of a total), and the inner
 * table of Pattern 14.
 *
 * - A HeroUI Table: a real table, labelled by its card's title.
 * - Amounts and counts are real text in their own cells, right aligned, in tabular figures.
 * - The bar is decoration, drawn inside the last cell after the amount and aria-hidden. The
 *   board draws it as a column of its own, but a react-aria table cell cannot be hidden: that
 *   column would be an empty cell the arrow keys stop on. The header's text sits over the
 *   amount, so it looks the same.
 * - `framed`: the Pattern 14 table next to other content in a card, with a border and 10px
 *   corners. Without it the table runs edge to edge in its card.
 * - Wide tables scroll sideways inside their card with the first column pinned; on a phone the
 *   pinned column is at most 10rem wide and its lines end in an ellipsis. The scroll
 *   area is a focusable region named after the table, ending in "Scrolls sideways", so a
 *   keyboard user can reach it (docs/design/docs/phone.md).
 * - With no rows, the caller shows EmptyList instead of the table (ADR 0112).
 * - When a dialog removes the row that opened it, focus goes to the table's scroll region once
 *   the dialog has closed (useFocusTableOnClose).
 */

export interface Column<Row> {
  /** A column keyed `actions` holds a row's buttons, sits at the right, and names itself to screen readers only. */
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  /** Amounts and counts. */
  numeric?: boolean;
}

export interface DataTableProps<Row> {
  /** The id of the heading that names the table, usually its card's title. */
  labelledBy: string;
  /** The table's name as text, for its scroll region. */
  name: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Each row's share of the largest, 0 to 1, drawn as a bar after the last column. */
  share?: (row: Row) => number;
  framed?: boolean;
  className?: string;
}

export function DataTable<Row>({
  labelledBy,
  name,
  columns,
  rows,
  rowKey,
  share,
  framed = false,
  className = '',
}: DataTableProps<Row>) {
  const withBar = (i: number) => share !== undefined && i === columns.length - 1;
  const atEnd = (column: Column<Row>) => column.numeric === true || column.key === 'actions';
  return (
    <Table
      variant="secondary"
      className={`lk-table ${framed ? 'lk-table-framed' : ''} ${className}`}
    >
      <Table.ScrollContainer
        role="region"
        aria-label={t('common.scrollsSideways', { name })}
        tabIndex={0}
        className="lk-table-scroll"
      >
        <Table.Content aria-labelledby={labelledBy}>
          <Table.Header>
            {columns.map((column, i) => (
              <Table.Column
                key={column.key}
                id={column.key}
                isRowHeader={i === 0}
                // HeroUI's secondary variant rounds the header's ends; the design's header is square.
                className={`rounded-none! ${atEnd(column) ? 'text-end' : ''}`}
                {...(withBar(i) ? { textValue: column.header } : {})}
              >
                {withBar(i) ? (
                  <span className="lk-share-row">
                    <span className="lk-share-amount">{column.header}</span>
                    <span className="lk-share-space" />
                  </span>
                ) : column.key === 'actions' ? (
                  // The buttons say what they do; the header is there for screen readers only.
                  <span className="sr-only">{column.header}</span>
                ) : (
                  column.header
                )}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body>
            {rows.map((row) => (
              <Table.Row key={rowKey(row)} id={rowKey(row)}>
                {columns.map((column, i) => (
                  <Table.Cell
                    key={column.key}
                    className={column.numeric === true ? 'lk-num text-end' : ''}
                  >
                    {withBar(i) && share !== undefined ? (
                      <span className="lk-share-row">
                        <span className="lk-share-amount">{column.cell(row)}</span>
                        <span aria-hidden="true" className="lk-share-space lk-share">
                          <span
                            style={{ width: `${Math.max(0, Math.min(1, share(row))) * 100}%` }}
                          />
                        </span>
                      </span>
                    ) : column.key === 'actions' ? (
                      <span className="flex justify-end">{column.cell(row)}</span>
                    ) : i === 0 ? (
                      // The pinned column: on a phone it has a width limit and its lines end
                      // in an ellipsis, so it never covers the columns scrolling under it.
                      <span className="lk-pinned">{column.cell(row)}</span>
                    ) : (
                      column.cell(row)
                    )}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

/** One thing a row offers, as RowActions draws it. */
/**
 * For a dialog that removes the row that opened it: call the returned function when the row is
 * gone, and the table's scroll region takes focus once the dialog has closed. Focusing it while
 * the dialog is still open loses focus, since the dialog keeps focus inside and, on closing,
 * returns it to the button that opened it, which went with its row. A mutation's callback is not
 * a user event, so its render can come after the next frame; an effect runs after it.
 */
export function useFocusTableOnClose(
  table: RefObject<HTMLElement | null>,
  dialogOpen: boolean,
): () => void {
  const pending = useRef(false);
  useEffect(() => {
    if (dialogOpen || !pending.current) return;
    pending.current = false;
    table.current?.querySelector<HTMLElement>('[role=region]')?.focus();
  }, [dialogOpen, table]);
  return () => {
    pending.current = true;
  };
}

export interface RowAction {
  id: string;
  /** What the button and the menu item say: "Revoke". */
  label: string;
  /** The button's name, with the row's: "Revoke key CI bot". */
  name: string;
  onAction: () => void;
  /** Destructive: a danger text button, and a danger menu item. */
  danger?: boolean;
  /** The one thing the row needs now, such as replacing a key the provider refused. */
  primary?: boolean;
  isPending?: boolean;
}

/**
 * A row's actions, at the end of its actions cell (phone.md). From 768px they are buttons on one
 * line. Below, they fold into one menu button named "Actions for" and the row, as on the People
 * page, so a row never needs the table to scroll to reach them.
 */
export function RowActions({ name, actions }: { name: string; actions: readonly RowAction[] }) {
  const label = t('common.actionsFor', { name });
  return (
    <>
      <span className="hidden items-center justify-end gap-2 whitespace-nowrap md:flex">
        {actions.map((action) => (
          <Button
            key={action.id}
            variant={
              action.danger === true ? 'ghost' : action.primary === true ? 'primary' : 'outline'
            }
            className={action.danger === true ? 'lk-danger-text' : ''}
            aria-label={action.name}
            isPending={action.isPending === true}
            onPress={action.onAction}
          >
            {action.label}
          </Button>
        ))}
      </span>
      <span className="flex justify-end md:hidden">
        <Dropdown>
          <Button isIconOnly variant="ghost" aria-label={label} className="text-muted">
            <Icon name="more" />
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label={label}
              disabledKeys={actions.filter((a) => a.isPending === true).map((a) => a.id)}
              onAction={(key: Key) => actions.find((a) => a.id === key)?.onAction()}
            >
              {actions.map((action) => (
                <Dropdown.Item
                  key={action.id}
                  id={action.id}
                  textValue={action.label}
                  {...(action.danger === true ? { variant: 'danger' as const } : {})}
                >
                  <Label>{action.label}</Label>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </span>
    </>
  );
}

/** A name with a muted second line, for a table's first column: "Maja Lind", "Admin". */
export function TwoLine({ first, second }: { first: ReactNode; second?: ReactNode }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="truncate font-medium">{first}</span>
      {second !== undefined && <span className="truncate text-caption text-muted">{second}</span>}
    </span>
  );
}
