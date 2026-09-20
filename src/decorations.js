'use strict';
// Git's own decorations compare the working tree to HEAD. Our base is usually
// origin/main, so on a PR every committed change is "clean" vs HEAD and the built-in
// badges would be blank on exactly the files under review. Hence our own provider.
//
// Decorations key on URI, and many symbols share a file, so each row gets a unique
// `file:///path#offset` URI. The icon theme still matches on extension; the fragment
// only distinguishes rows for us.

const STATUS_BADGE = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
// the letter is the whole signal now, so spell it out on hover
const STATUS_LABEL = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' };

// FileDecoration exposes ONE colour and VS Code applies it to the badge *and* the
// label -- there is no badge-only tint (same reason the Explorer turns a modified
// filename orange). Now that rows carry only a name, a glyph and a badge, tinting the
// whole row reads as emphasis rather than noise, so the git palette is back.
const STATUS_COLOR = {
  added: 'gitDecoration.addedResourceForeground',
  modified: 'gitDecoration.modifiedResourceForeground',
  deleted: 'gitDecoration.deletedResourceForeground',
  renamed: 'gitDecoration.renamedResourceForeground',
};

function createDecorationProvider(vscode) {
  const byKey = new Map();
  const emitter = new vscode.EventEmitter();
  const key = (uri) => `${uri.fsPath}#${uri.fragment || ''}`;

  return {
    onDidChangeFileDecorations: emitter.event,
    provideFileDecoration(uri) {
      const d = byKey.get(key(uri));
      if (!d) return undefined;
      const deco = {};
      if (d.badge) deco.badge = d.badge;              // at most two characters
      if (d.color) deco.color = new vscode.ThemeColor(d.color);
      if (d.tooltip) deco.tooltip = d.tooltip;
      deco.propagate = false;                          // never bubble to parent rows
      return Object.keys(deco).length ? deco : undefined;
    },
    // called as nodes are built; fire once per batch so VS Code re-renders
    register(uri, { status, tooltip }) {
      const badge = STATUS_BADGE[status];
      byKey.set(key(uri), {
        badge: badge || undefined,
        color: STATUS_COLOR[status] || undefined,   // intentionally empty; see above
        tooltip: badge ? `${STATUS_LABEL[status]}${tooltip ? ` — ${tooltip}` : ''}` : tooltip,
      });
    },
    flush(uris) { emitter.fire(uris && uris.length ? uris : undefined); },
    clear() { byKey.clear(); emitter.fire(undefined); },
    _size: () => byKey.size,
    STATUS_BADGE,
    STATUS_COLOR,
  };
}
module.exports = { createDecorationProvider, STATUS_BADGE, STATUS_COLOR, STATUS_LABEL };
