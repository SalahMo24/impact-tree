import { lockRow } from './locks';
import { rows } from './rows';

/** Copies a row into the snapshot store. */
export function saveSnapshot(id: string): string {
  const lock = lockRow(id);
  try {
    return JSON.stringify(rows.get(id));
  } finally {
    lock.release();
  }
}
