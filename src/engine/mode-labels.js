// @ts-check
'use strict';

// How each local mode is named to a reader. The keys are the `impactTree.mode` setting
// values and stay as they are for compatibility; only these labels are shown. Its own
// module so the tree's pure row models can name a mode without loading the engine.
/** @type {Readonly<Record<string, string>>} */
const MODE_LABELS = Object.freeze({
  working: 'Uncommitted (agent)',
  checkpoint: 'Since checkpoint',
  branch: 'Branch + uncommitted',
  pr: 'Branch vs base',
});

/**
 * The name a reader sees for a mode id; an unknown id is shown as it is.
 * @param {string} id
 * @returns {string}
 */
const modeLabel = (id) => (Object.hasOwn(MODE_LABELS, id) ? MODE_LABELS[id] : id);

module.exports = { MODE_LABELS, modeLabel };
