import { lockRow } from '../src/locks';

export function lockIsReleased(): boolean {
  const lock = lockRow('a');
  lock.release();
  return lockRow('a').id === 'a';
}
