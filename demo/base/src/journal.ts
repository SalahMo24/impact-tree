import { lockRow } from './locks';

const entries: string[] = [];

/** Appends a line to a row's journal. */
export function appendEntry(id: string, line: string): void {
  const lock = lockRow(id);
  entries.push(`${id}: ${line}`);
  lock.release();
}
