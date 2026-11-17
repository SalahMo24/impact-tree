export interface Lock {
  id: string;
  release(): void;
}

const held = new Set<string>();

/** Takes the lock on a row, waiting while another writer holds it. */
export function lockRow(id: string): Lock {
  while (held.has(id)) {
    // Another writer has the row; wait for it.
  }
  held.add(id);
  return { id, release: () => held.delete(id) };
}
