// @ts-check
'use strict';
// Git's own decorations compare the working tree to HEAD. Our base is usually
// origin/main, so on a PR every committed change is "clean" vs HEAD and the built-in
// badges would be blank on exactly the files under review. Hence our own provider.
//
// Decorations key on URI, and many symbols share a file, so each row gets a unique
// `file:///path#offset` URI. The icon theme still matches on extension; the fragment
// only distinguishes rows for us.

/** @type {Record<string, string>} */
const STATUS_BADGE = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
// the letter is the whole signal now, so spell it out on hover
/** @type {Record<string, string>} */
const STATUS_LABEL = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' };

// FileDecoration exposes ONE colour and VS Code applies it to the badge *and* the
// label -- there is no badge-only tint (same reason the Explorer turns a modified
// filename orange). Now that rows carry only a name, a glyph and a badge, tinting the
// whole row reads as emphasis rather than noise, so the git palette is back.
/** @type {Record<string, string>} */
const STATUS_COLOR = {
  added: 'gitDecoration.addedResourceForeground',
  modified: 'gitDecoration.modifiedResourceForeground',
  deleted: 'gitDecoration.deletedResourceForeground',
  renamed: 'gitDecoration.renamedResourceForeground',
};

/** @typedef {{ badge?: string, color?: string, tooltip?: string }} DecorationValue */
/** @param {any} vscode */
function createDecorationProvider(vscode) {
  // Owned by this decoration provider, retained until clear/dispose. Dirty URIs are
  // bounded by registered rows and drained on each flush; unchanged reads add nothing.
  /** @type {Map<string, DecorationValue>} */
  const byKey = new Map();
  // Each dirty entry keeps the value before this batch. Restoring that value before
  // flush removes the entry, avoiding notifications for transient tooltip changes.
  /** @type {Map<string, { uri: any, previous: DecorationValue|undefined }>} */
  const dirty = new Map();
  let disposed = false;
  const emitter = new vscode.EventEmitter();
  const key = (/** @type {any} */ uri) => `${uri.fsPath}#${uri.fragment || ''}`;

  return {
    onDidChangeFileDecorations: emitter.event,
    provideFileDecoration(/** @type {any} */ uri) {
      const d = byKey.get(key(uri));
      if (!d) return undefined;
      const deco = /** @type {any} */ ({});
      if (d.badge) deco.badge = d.badge;              // at most two characters
      if (d.color) deco.color = new vscode.ThemeColor(d.color);
      if (d.tooltip) deco.tooltip = d.tooltip;
      deco.propagate = false;                          // never bubble to parent rows
      return Object.keys(deco).length ? deco : undefined;
    },
    // called as nodes are built; fire once per batch so VS Code re-renders
    // `tint: false` keeps the badge and tooltip but leaves the label's colour alone: a row
    // that is not a file (a change inside one) shows the status letter without turning orange.
    /** @param {any} uri @param {{ status?: string, tooltip?: string, tint?: boolean }} decoration */
    register(uri, { status, tooltip, tint = true }) {
      if (disposed) return;
      const badge = STATUS_BADGE[status || ''];
      const next = {
        badge: badge || undefined,
        color: tint ? STATUS_COLOR[status || ''] || undefined : undefined,
        tooltip: badge ? `${STATUS_LABEL[status || '']}${tooltip ? ` — ${tooltip}` : ''}` : tooltip,
      };
      const previous = byKey.get(key(uri));
      if (previous && previous.badge === next.badge && previous.color === next.color && previous.tooltip === next.tooltip) return;
      const pending = dirty.get(key(uri));
      const baseline = pending ? pending.previous : previous;
      byKey.set(key(uri), next);
      if (baseline && baseline.badge === next.badge && baseline.color === next.color && baseline.tooltip === next.tooltip) {
        dirty.delete(key(uri));
      } else dirty.set(key(uri), { uri, previous: baseline });
    },
    flush() {
      if (!dirty.size) return;
      const uris = [...dirty.values()].map(entry => entry.uri);
      dirty.clear();
      emitter.fire(uris);
    },
    clear() { if (disposed) return; byKey.clear(); dirty.clear(); emitter.fire(undefined); },
    dispose() { disposed = true; byKey.clear(); dirty.clear(); emitter.dispose(); },
    _size: () => byKey.size,
    STATUS_BADGE,
    STATUS_COLOR,
  };
}
module.exports = { createDecorationProvider, STATUS_BADGE, STATUS_COLOR, STATUS_LABEL };
