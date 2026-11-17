import { lockRow } from './locks';
import { rows } from './rows';

/** Copies a row into the snapshot store; a row that stays locked is skipped (empty string). */
export function saveSnapshot(id: string): string {
  let lock;
  try {
    lock = lockRow(id, 200);
  } catch {
    return ''; // Row busy: the next snapshot round saves it.
  }
  try {
    return JSON.stringify(rows.get(id));
  } finally {
    lock.release();
  }
}
