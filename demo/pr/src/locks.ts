export interface Lock {
  id: string;
  release(): void;
}

export class LockTimeout extends Error {
  constructor(id: string) {
    super(`Timed out waiting for the lock on row ${id}`);
  }
}

const held = new Set<string>();

/** Takes the lock on a row, waiting up to `timeoutMs` while another writer holds it. */
export function lockRow(id: string, timeoutMs = 5000): Lock {
  const start = Date.now();
  while (held.has(id)) {
    if (Date.now() - start > timeoutMs) throw new LockTimeout(id);
  }
  held.add(id);
  return { id, release: () => held.delete(id) };
}
