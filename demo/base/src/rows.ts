import { lockRow } from './locks';

export const rows = new Map<string, { name: string }>();

/** Gives a row a new name. */
export function renameRow(id: string, name: string): void {
  const row = rows.get(id);
  if (!row) return;
  const lock = lockRow(id);
  row.name = name;
  lock.release();
}
