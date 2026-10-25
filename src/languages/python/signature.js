// @ts-check
'use strict';
// Placeholder until P3 lands; replaced by P3's parser at merge.
// It gives the documented "cannot read" answers, so P2's provider runs: no header is
// parsed, no raise is read, and a header change is compared as text (conservatively a
// `type-changed`, never "body only").

/** @type {(declText: string, options: { isMethod: boolean }) => { sig: any, headerEnd: number, decorators: string[], binding: 'function'|'property'|'staticmethod'|'classmethod' }|null} */
const parsePythonDeclaration = () => null;

/** @type {(declText: string, headerEnd: number) => Set<string>} */
const raisesOf = () => new Set();

/**
 * @param {{ header: string }|undefined} base
 * @param {{ header: string }} head
 * @returns {object[]}
 */
function pythonKindsOf(base, head) {
  const { KIND } = require('../../engine/signature');
  if (!base) return [];
  return base.header === head.header ? [] : [KIND.TYPE_CHANGED];
}

/** @type {(sig: unknown) => string} */
const renderPythonSig = () => '(…)';

module.exports = { parsePythonDeclaration, raisesOf, pythonKindsOf, renderPythonSig };
