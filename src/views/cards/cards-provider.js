// @ts-check
'use strict';

// The Cards view's tree data provider: renders the nodes of cards-view-model.js as tree
// items and turns a node's `target` into a command. The model is built on the first read
// after a refresh and kept until the next one, so a row's identity is stable while it is on
// screen (reveal needs the same object).

const { cardsViewModel } = require('./cards-view-model');
const { latestCardsResult } = require('../../agent/agent-cards');

/** @typedef {import('./cards-view-model').CardNode} CardNode */

/** The command that selects another card in this view; registered by extension.js. */
const REVEAL_COMMAND = 'impactTree.revealCard';

const EMPTY_NODE = /** @type {CardNode} */ ({
  id: 'notice:empty', label: 'Cards appear here once a change is analysed.', icon: 'info', contextValue: 'cardsNote',
});

/**
 * @typedef {object} CardsSource
 * @property {boolean} enabled Whether `impactTree.cards.enabled` is on.
 * @property {any} state The session's view state: `result`, `cards`, `hintsPending`, `cardsError`.
 * @property {AgentSource|null} [agent] The agent part (impactTree.agents.enabled), or null/absent when agents are off.
 */

/**
 * @typedef {object} AgentSource
 * @property {{ askedAt: number }|null} waiting
 * @property {boolean} showEngine
 * @property {Array<{ kind: string, key: string, payload: unknown, storedAt: number }>} results The stored results for the shown head.
 */

/** @param {number} ms @returns {string} The local time as HH:MM. */
function clockText(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** @param {AgentSource} agent @returns {import('./cards-view-model').AgentInput} */
function agentInput(agent) {
  const latest = latestCardsResult(agent.results);
  return {
    waiting: agent.waiting ? { askedAtText: clockText(agent.waiting.askedAt) } : null,
    result: latest ? { key: latest.key, storedAtText: clockText(latest.storedAt), payload: latest.payload } : null,
    showEngine: agent.showEngine,
  };
}

/**
 * @param {any} vscode
 * @param {{ getSource: () => CardsSource }} deps `getSource` is read on each rebuild.
 * @returns {{
 *   getChildren: (node?: CardNode) => CardNode[], getTreeItem: (node: CardNode) => any, getParent: (node: CardNode) => CardNode|undefined,
 *   onDidChangeTreeData: any, refresh: () => void, find: (id: string) => CardNode|undefined, dispose: () => void }}
 */
function createCardsProvider(vscode, { getSource }) {
  const changed = new vscode.EventEmitter();
  // Built from the session's state on first read after refresh(); dropped by refresh().
  // Owner: this provider. The parent map and id map are derived from `roots` and share its lifetime.
  /** @type {CardNode[]|null} */
  let roots = null;
  /** @type {Map<CardNode, CardNode>} */
  let parents = new Map();
  /** @type {Map<string, CardNode>} */
  let byId = new Map();
  /** @type {Map<string, any>} */
  let changes = new Map();

  /** @param {CardNode[]} nodes @param {CardNode|null} parent */
  function index(nodes, parent) {
    for (const node of nodes) {
      byId.set(node.id, node);
      if (parent) parents.set(node, parent);
      if (node.children) index(node.children, node);      // depth is bounded by the model: card, group, row
    }
  }

  function build() {
    const { enabled, state, agent } = getSource();
    parents = new Map(); byId = new Map(); changes = new Map();
    if (!enabled || !state || !state.result) {
      roots = enabled ? [EMPTY_NODE] : [];
    } else {
      for (const c of state.result.allChanged || []) changes.set(`${c.relPath}#${c.namePos}`, c);
      roots = cardsViewModel({
        result: state.result, cards: state.cards || null, hintsPending: state.hintsPending === true,
        preview: state.result.tierA === true, error: state.cardsError || null,
        agent: agent ? agentInput(agent) : null,
      });
    }
    index(roots, null);
    return roots;
  }

  /**
   * The command a node runs when activated, with the arguments the Changes view's own rows give it.
   * @param {CardNode} node
   * @returns {{ command: string, title: string, arguments: any[] }|undefined}
   */
  function commandFor(node) {
    const target = node.target;
    if (!target) return undefined;
    if (target.kind === 'command') return { command: target.command, title: node.label, arguments: target.args };
    if (target.kind === 'card') return { command: REVEAL_COMMAND, title: 'Show card', arguments: [target.id] };
    if (target.kind === 'change') {
      const finding = changes.get(`${target.relPath}#${target.namePos}`);
      // A change that is no longer in the shown result has nothing to open.
      return finding ? { command: 'impactTree.openChange', title: 'Open change', arguments: [{ type: 'finding', label: finding.label, finding, file: finding.file, pos: finding.namePos }] } : undefined;
    }
    return { command: 'impactTree.openFile', title: 'Open diff', arguments: [{ type: 'deleted', relPath: target.relPath, label: node.label }] };
  }

  return {
    onDidChangeTreeData: changed.event,
    refresh() { roots = null; changed.fire(undefined); },
    getChildren(node) { return node ? (node.children || []) : (roots || build()); },
    getParent(node) { if (!roots) build(); return parents.get(node); },
    find(id) { if (!roots) build(); return byId.get(id); },
    getTreeItem(node) {
      const state = node.children && node.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
      const item = new vscode.TreeItem(node.label, state);
      item.id = node.id;
      if (node.description) item.description = node.description;
      if (node.tooltip) item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.contextValue = node.contextValue;
      const command = commandFor(node);
      if (command) item.command = command;
      return item;
    },
    dispose() { changed.dispose(); },
  };
}

module.exports = { createCardsProvider, REVEAL_COMMAND, clockText };
