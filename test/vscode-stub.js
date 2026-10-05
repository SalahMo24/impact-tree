'use strict';
const path = require('path');
function uri(scheme, fsPath, query, fragment) {
  const u = {
    scheme, fsPath, path: fsPath, query: query || '', fragment: fragment || '', __isUri: true,
    with(o) {
      return uri(scheme, fsPath, o.query !== undefined ? o.query : query,
        o.fragment !== undefined ? o.fragment : fragment);
    },
    toString() {
      return `${scheme}://${fsPath}${query ? '?' + query : ''}${fragment ? '#' + fragment : ''}`;
    },
  };
  return u;
}

const vscodeStub = {
  MarkdownString: class { constructor(v) { this.value = v; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: {
    file: (p) => uri('file', p, '', ''),
    parse: (s) => {
      const [base, frag] = String(s).split('#');
      const q = base.indexOf('?');
      const main = q === -1 ? base : base.slice(0, q);
      const query = q === -1 ? '' : base.slice(q + 1);
      const colon = main.indexOf(':');
      const scheme = main.slice(0, colon);
      const p = main.slice(colon + 1);
      return uri(scheme, p, query, frag || '');
    },
    from: ({ scheme, path: p, query }) => uri(scheme, p, query || '', ''),
  },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  ThemeIcon: Object.assign(
    class { constructor(id) { this.id = id; } },
    { File: { id: '__file__' }, Folder: { id: '__folder__' } }),
  TreeItem: class {
    constructor(labelOrUri, state) {
      if (labelOrUri && labelOrUri.__isUri) {
        this.resourceUri = labelOrUri;
        this.label = path.basename(labelOrUri.fsPath);
      } else this.label = labelOrUri;
      this.collapsibleState = state;
    }
  },
};

module.exports = vscodeStub;
