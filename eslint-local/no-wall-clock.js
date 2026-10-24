'use strict';
// ESLint rule: time in src/ comes from the injected clock (src/engine/clock.js), so tests can
// move time forward instead of waiting for it (docs/CODING_STYLE.md §10). Reading the wall
// clock or the global timers directly is an error unless the line, or the line above it,
// carries an allowlist comment naming why the real clock is right there:
//
//   // wall-clock: <category> — <reason>
//
// Categories (the documented allowlist):
// - log-only    a duration or timestamp that is only logged or counted in stats; nothing
//               decides on it.
// - next-turn   `setTimeout(fn, 0)` (and its clearTimeout) batching work into the next
//               event-loop turn; not a duration. The delay must be the literal 0.
// - display     the current date shown to a person (a log prefix, "today" in a label).
// - subprocess  a timeout the operating system enforces on a child process.
//
// A reason is required after the category. An allowlist comment that covers no use is
// reported too, so the list cannot go stale. src/engine/clock.js itself is exempt.

const CATEGORIES = new Set(['log-only', 'next-turn', 'display', 'subprocess']);
const MARKER = /^\s*wall-clock:\s*([a-z-]+)\s*(?:—|--|-|:)\s*(\S.*)$/;
const TIMER_GLOBALS = new Set(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']);
const CLOCK_MEMBERS = { Date: new Set(['now']), performance: new Set(['now']), process: new Set(['hrtime']) };
const GLOBAL_OBJECTS = new Set(['global', 'globalThis', 'window']);

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Use the injected clock (src/engine/clock.js) instead of the wall clock or global timers' },
    schema: [],
    messages: {
      direct: '{{what}} reads the wall clock: take a `clock` (src/engine/clock.js), or add `// wall-clock: <category> — <reason>` with a category from: {{categories}}.',
      badMarker: 'wall-clock allowlist comment needs a known category ({{categories}}) and a reason, as `// wall-clock: <category> — <reason>`.',
      notZero: '`wall-clock: next-turn` allows only setTimeout(fn, 0); this delay is not the literal 0.',
      unused: 'This wall-clock allowlist comment covers no wall-clock use; remove it.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    // Allowlist comments by the line they stand on: { category, used, comment }.
    const markers = new Map();
    for (const comment of source.getAllComments()) {
      const text = comment.value.trim();
      if (!text.startsWith('wall-clock:')) continue;
      const m = MARKER.exec(text);
      if (!m || !CATEGORIES.has(m[1])) {
        context.report({ loc: comment.loc, messageId: 'badMarker', data: { categories: [...CATEGORIES].join(', ') } });
        continue;
      }
      markers.set(comment.loc.end.line, { category: m[1], used: false, comment });
    }

    /** The allowlist comment for a node: on its own line or the line above. */
    const markerFor = (node) => markers.get(node.loc.start.line) || markers.get(node.loc.start.line - 1) || null;

    /**
     * @param {import('estree').Node & { loc: any }} node
     * @param {string} what
     * @param {import('estree').Node|null} call The call expression, when the use is a call.
     */
    function check(node, what, call) {
      const marker = markerFor(node);
      if (!marker) {
        context.report({ node, messageId: 'direct', data: { what, categories: [...CATEGORIES].join(', ') } });
        return;
      }
      marker.used = true;
      if (marker.category === 'next-turn' && what === 'setTimeout') {
        const delay = call && call.type === 'CallExpression' ? call.arguments[1] : null;
        if (!delay || delay.type !== 'Literal' || delay.value !== 0) context.report({ node, messageId: 'notZero' });
      }
    }

    /** The call a node is the callee of, or null. */
    const callOf = (node) => (node.parent && node.parent.type === 'CallExpression' && node.parent.callee === node ? node.parent : null);

    return {
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier' || node.object.type !== 'Identifier') return;
        const object = node.object.name, property = node.property.name;
        if (CLOCK_MEMBERS[object] && CLOCK_MEMBERS[object].has(property) && !isShadowed(context, node.object)) {
          check(node, `${object}.${property}`, callOf(node));
        } else if (GLOBAL_OBJECTS.has(object) && TIMER_GLOBALS.has(property)) {
          check(node, property, callOf(node));
        }
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0 && !isShadowed(context, node.callee)) {
          check(node, 'new Date()', null);
        }
      },
      'Program:exit'(program) {
        // Global timer functions referenced without a local binding of the same name.
        // A reference resolves to the declared global when the config declares Node's globals,
        // and stays unresolved (`through`) when it does not: both are the global timer.
        const globalScope = source.getScope(program);
        const refs = globalScope.through.filter((ref) => TIMER_GLOBALS.has(ref.identifier.name));
        for (const name of TIMER_GLOBALS) {
          const declared = globalScope.set.get(name);
          if (declared) refs.push(...declared.references);
        }
        const seen = new Set();
        for (const ref of refs) {
          if (seen.has(ref.identifier)) continue;
          seen.add(ref.identifier);
          check(ref.identifier, ref.identifier.name, callOf(ref.identifier));
        }
        for (const marker of markers.values()) {
          if (!marker.used) context.report({ loc: marker.comment.loc, messageId: 'unused' });
        }
      },
    };
  },
};

/** Whether an identifier resolves to a local binding rather than the global object. */
function isShadowed(context, identifier) {
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    if (scope.set.has(identifier.name) && scope.type !== 'global') return true;
    scope = scope.upper;
  }
  return false;
}
