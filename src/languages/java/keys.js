// @ts-check
'use strict';
// Java symbol keys (docs/MULTI_LANGUAGE_PLAN.md, J-D3 as confirmed after J0): a method is
// keyed `Outer.Inner.method(T1, T2)` with each parameter type erased and simple, so adding
// or reordering an overload moves no other key, and adding a generic argument
// (`List` → `List<String>`) is a type change of the same symbol, not a deletion plus an
// addition. jdtls names a method with its parameter types as written
// (`getAdapter(TypeToken<T>) <T>`, J0); the editor's provider (J2) and the text outline (J7)
// both build keys here, so the two agree. Pure text in, text out.
//
// The fixed forms, shared with the header parser (./signature.js, J3):
// - type arguments are dropped, with nesting: `Map<String, List<T>>` → `Map`;
// - a qualified type keeps its last segment: `java.util.Map` → `Map`, `Map.Entry` → `Entry`;
// - arrays keep `[]` (`List<T>[]` → `List[]`) and varargs keep `...` (jdtls' own form);
// - type variables stay as written (`T`), never erased to their bound;
// - annotations and white space are dropped.

// Budget: the longest name or type text read, in UTF-16 units. Valid range >= 1; default
// 16 Ki, far above any real parameter list (gson's longest jdtls name is under 200) and
// small enough that a scan costs microseconds. Owner: this module; enforced by
// `memberNameOf` and `erasedType`, which throw RangeError past it: names come from a
// language server, and a longer one is a broken answer, not a method to key.
const MAX_NAME_CHARS = 16384;

/** @param {string} text @param {string} what */
function checkLength(text, what) {
  if (typeof text !== 'string') throw new TypeError(`${what} must be a string`);
  if (text.length > MAX_NAME_CHARS) throw new RangeError(`${what} has ${text.length} characters, above ${MAX_NAME_CHARS}`);
}

/**
 * The text with every `<…>` group removed, nesting matched. An unbalanced `>` is kept as
 * text (it cannot come from a type), and an unclosed `<` drops the rest.
 * @param {string} text
 * @returns {string}
 */
function withoutTypeArguments(text) {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '<') depth++;
    else if (ch === '>' && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * A parameter type as a key carries it: type arguments dropped, the last segment of a
 * qualified name, `[]` and `...` kept, annotations and white space dropped.
 * `Class<T>` → `Class`, `java.util.Map<K, V>` → `Map`, `List<? extends V>` → `List`,
 * `List<T>[]` → `List[]`, `Class<?>...` → `Class...`, `int [] []` → `int[][]`, `T` → `T`.
 * @param {string} text
 * @returns {string}
 */
function erasedType(text) {
  checkLength(text, 'a type');
  // Annotations (`@Nullable`, `@a.B(...)`) are not part of a type's identity. jdtls drops
  // them (J0); a text outline may not.
  const bare = withoutTypeArguments(text)
    .replace(/@[\w$.]+\s*(\([^)]*\))?/g, ' ')
    .replace(/\s+/g, '');
  const m = /^([\w$.]*?)((?:\[\])*(?:\.\.\.)?)$/.exec(bare);
  if (!m) return bare;
  const name = m[1];
  const dot = name.lastIndexOf('.');
  return `${dot < 0 ? name : name.slice(dot + 1)}${m[2]}`;
}

/**
 * Splits a parameter list's text at its top-level commas (commas inside `<>`, `()` or `[]`
 * are not separators). Empty text is no parameters.
 * @param {string} text The text between the parentheses.
 * @returns {string[]}
 */
function splitParameters(text) {
  if (text.trim() === '') return [];
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if ((ch === '>' || ch === ')' || ch === ']') && depth > 0) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * A method or constructor name as jdtls gives it, read: `getAdapter(TypeToken<T>) <T>`
 * gives `{ simpleName: 'getAdapter', params: ['TypeToken<T>'] }`. The trailing
 * type-parameter suffix is dropped. Null for a name with no parameter list (a field, a
 * type) or with unbalanced parentheses.
 * @param {string} name
 * @returns {{ simpleName: string, params: string[] }|null}
 */
function memberNameOf(name) {
  checkLength(name, 'a member name');
  const open = name.indexOf('(');
  if (open <= 0) return null;
  let depth = 0;
  for (let i = open; i < name.length; i++) {
    if (name[i] === '(') depth++;
    else if (name[i] === ')' && --depth === 0) {
      return { simpleName: name.slice(0, open).trim(), params: splitParameters(name.slice(open + 1, i)).map((p) => p.trim()) };
    }
  }
  return null;
}

/**
 * A type's name as a key segment: its type parameters dropped. `TypeToken<T>` → `TypeToken`,
 * `Generic<T extends Comparable<T>>` → `Generic`.
 * @param {string} name
 * @returns {string}
 */
const typeSegmentOf = (name) => withoutTypeArguments(name).trim();

/**
 * The key of a method or constructor: `Outer.Inner.method(T1, T2)`, or
 * `Outer.Inner.<init>(T1, T2)` for a constructor, each parameter type `erasedType`.
 * @param {string[]} path The enclosing type (and enum-constant or field) segments, outermost first.
 * @param {string} simpleName The method's name; ignored for a constructor.
 * @param {string[]} params Parameter types as written.
 * @param {boolean} isConstructor
 * @returns {string}
 */
function javaKeyOf(path, simpleName, params, isConstructor) {
  const name = isConstructor ? '<init>' : simpleName;
  return `${[...path, name].join('.')}(${params.map(erasedType).join(', ')})`;
}

module.exports = { erasedType, splitParameters, memberNameOf, typeSegmentOf, javaKeyOf, withoutTypeArguments, MAX_NAME_CHARS };
