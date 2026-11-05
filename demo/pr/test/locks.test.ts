import { lockRow, LockTimeout } from '../src/locks';

export function lockIsReleased(): boolean {
  const lock = lockRow('a');
  lock.release();
  return lockRow('a').id === 'a';
}

export function lockTimesOut(): boolean {
  lockRow('b');
  try {
    lockRow('b', 10);
    return false;
  } catch (e) {
    return e instanceof LockTimeout;
  }
}
