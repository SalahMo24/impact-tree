// @ts-check
'use strict';
// C# symbol keys (Part C, C-D6 and the owner's addendum after the C0–C2 review), built exactly
// as the Roslyn syntax oracle builds them (test/csharp-syntax-oracle/README.md, "Keys"), so a
// row's key is the oracle's and, later, the semantic oracle's. The outline (./outline.js) names
// each symbol with its key segment (`memberKeyName`, `typeKeySegment`); `csharpKeyOf` joins a
// type path and a member's segment. Pure text in, text out.
//
// - Type path: enclosing types with arity when > 0 (`Result<1>.Map(…)`), namespaces dropped; a
//   C# 14 `extension(…)` block adds no segment.
// - Methods `Name<arity>(T1, T2)`; constructors `<init>(…)` (a primary constructor's parameter
//   list too); static constructor `<cinit>()`; properties `Name`; indexers `this[int]`;
//   operators `operator +(T, T)` (`operator checked +` kept apart); conversions
//   `implicit operator X(Y)`; explicit implementations insert the interface
//   (`IEnumerable<1>.GetEnumerator()`); top-level statements: the file's basename.
// - Extension blocks: an instance method keys as the classic extension method (`this Foo`
//   first, arity = the block's type parameters + the method's own); an instance property gets
//   the receiver in brackets (`Count(this Foo)`); static members and operators of a block key
//   as members of the static class.
// - Parameter types are the parser's `keyType` (./signature.js: namespaces dropped, generic
//   arguments erased, `?`, arrays, pointers and `ref`/`out`/`in`/`params`/`this` kept).

const { csharpKeyParams } = require('./signature');

/** `<n>` when n > 0, else ''. @param {number} n */
const arity = (n) => (n > 0 ? `<${n}>` : '');

/**
 * A type's key segment: its name with its arity (`Result<1>`, `Outer`).
 * @param {string} name @param {number} typeParameterCount
 * @returns {string}
 */
const typeKeySegment = (name, typeParameterCount) => `${name}${arity(typeParameterCount)}`;

/**
 * The receiver of an extension block, as its members' keys carry it.
 * @typedef {{ receiver: string, arity: number }} ExtensionBlock
 * `receiver`: `this Foo` (`this ref Span` for `ref Span<int> s`), '' when it could not be read;
 * `arity`: the block's type-parameter count.
 */

/**
 * A member's key segment (the key after the type path).
 * @param {{ kind: string, name: string, explicitInterface: string|null, params: Array<{ keyType: string }>,
 *   typeParameters: string[], modifiers: string[] }} decl As `parseCsharpDeclaration` gives it.
 * @param {ExtensionBlock|null} ext The extension block the member is declared in, or null.
 * @returns {string}
 */
function memberKeyName(decl, ext) {
  const pre = decl.explicitInterface ? `${decl.explicitInterface}.` : '';
  const params = csharpKeyParams(decl.params);
  const extended = ext !== null && ext.receiver !== '' && !decl.modifiers.includes('static');
  switch (decl.kind) {
    case 'method':
      if (extended) {
        const ps = [/** @type {ExtensionBlock} */ (ext).receiver, ...decl.params.map((p) => p.keyType)].join(', ');
        return `${decl.name}${arity(/** @type {ExtensionBlock} */ (ext).arity + decl.typeParameters.length)}(${ps})`;
      }
      return `${pre}${decl.name}${arity(decl.typeParameters.length)}(${params})`;
    case 'constructor': return `<init>(${params})`;
    case 'static-constructor': return '<cinit>()';
    case 'property': return extended ? `${decl.name}(${/** @type {ExtensionBlock} */ (ext).receiver})` : `${pre}${decl.name}`;
    case 'indexer': return `${pre}this[${params}]`;
    default: return `${pre}${decl.name}(${params})`; // operators and conversions
  }
}

/**
 * A primary constructor's key segment. @param {Array<{ keyType: string }>} params
 * @returns {string}
 */
const primaryConstructorKeyName = (params) => `<init>(${csharpKeyParams(params)})`;

/**
 * A member's key: the type path and its segment joined by `.`; the top-level statements' key
 * (no path) is the segment alone, the file's basename.
 * @param {string[]} path Type segments, outermost first.
 * @param {string} name The member's key segment.
 * @returns {string}
 */
const csharpKeyOf = (path, name) => [...path, name].join('.');

/**
 * The part of a key two overloads share: the key up to its parameter list (`Type.M` of
 * `Type.M<1>(int)`, `Type.this` of `Type.this[int]`, `Type.operator +`), for J-D3's pairing.
 * A `#n` repeat number is dropped.
 * @param {string} key @returns {string}
 */
function overloadNameOf(key) {
  const k = key.replace(/#\d+$/, '');
  // The parameter list is the last bracket group: `(…)` or, for an indexer, `[…]` (tuples
  // nest inside it); arity `<n>` right before it belongs to the name's overloads too.
  if (!/[)\]]$/.test(k)) return k;
  let depth = 0;
  for (let i = k.length - 1; i >= 0; i--) {
    const c = k[i];
    if (c === ')' || c === ']') depth++;
    else if ((c === '(' || c === '[') && --depth === 0) return k.slice(0, i).replace(/<\d+>$/, '');
  }
  return k;
}

module.exports = { typeKeySegment, memberKeyName, primaryConstructorKeyName, csharpKeyOf, overloadNameOf };
