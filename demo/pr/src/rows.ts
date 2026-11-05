import { lockRow } from './locks';

export const rows = new Map<string, { name: string }>();

/** Gives a row a new name, trimmed and at most 80 characters long. */
export function renameRow(id: string, name: string): void {
  const row = rows.get(id);
  if (!row) return;
  const clean = name.trim().slice(0, 80);
  const lock = lockRow(id);
  row.name = clean;
  lock.release();
}
