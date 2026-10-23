'use strict';
// The target repository the suite analyses when IMPACT_TREE_TARGET_REPO is not set: a
// small two-package TypeScript monorepo built from the literals below into a throwaway
// git repository, with a `main` and a `feature/quote-options` branch checked out on top
// of it. Self-contained, so `npm test` needs no clone of anyone else's code and CI needs
// no network; deterministic, so the checks that read the diff (callsites, tree-smoke)
// always find one and never skip.
//
// The branch is written to give the tree one of each thing it draws:
// - `quoteFor` gains a parameter: `createOrder` is updated at the call (green),
//   `buildInvoice` is not (red, a stale caller); a test in `__tests__/` calls it.
// - `formatPrice` changes in its body only; its caller `PriceTag` changes on another
//   line (amber, "changed, but not at the call"), and is a .tsx file.
// - `roundMoney` is a new file (status A) with a caller in `quoteFor`.
// - `legacyRounding` is deleted.
// - README.md changes: a file without a call graph, a third file type.
// The base branch has no remote, so the analysis falls back to local `main` and says so
// in a warning; tree-smoke checks that warnings reach the tree.
//
// Built once per content hash under the OS temp directory and reused by every suite of
// the run; a change to the literals builds a new directory. TypeScript is the copy this
// project ships, linked into the fixture's node_modules as a real install would be.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const J = (v) => JSON.stringify(v, null, 2) + '\n';

const API_TSCONFIG = J({ compilerOptions: { target: 'es2020', module: 'commonjs', strict: true, outDir: 'dist' }, include: ['src'] });
const WEB_TSCONFIG = J({ compilerOptions: { target: 'es2020', module: 'esnext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true }, include: ['src'] });

const QUOTE_BASE = `// Price quotes: the total of a basket in one currency, before tax.
// Discounts apply to the subtotal; rounding happens once, at the end, so a basket of
// many cheap items does not drift by a cent per line.
export type LineItem = { sku: string; unitPrice: number; quantity: number };

export type Quote = { currency: string; subtotal: number; total: number };

const DISCOUNTS: Record<string, number> = { WELCOME10: 0.1, SPRING: 0.15 };

export function applyDiscount(total: number, code: string | undefined): number {
  if (!code) return total;
  const rate = DISCOUNTS[code];
  return rate ? total * (1 - rate) : total;
}

export function legacyRounding(n: number): number {
  return Math.round(n * 100) / 100;
}

export function quoteFor(items: LineItem[], currency: string): Quote {
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const total = legacyRounding(applyDiscount(subtotal, undefined));
  return { currency, subtotal, total };
}
`;

const QUOTE_HEAD = `// Price quotes: the total of a basket in one currency, before tax.
// Discounts apply to the subtotal; rounding happens once, at the end, so a basket of
// many cheap items does not drift by a cent per line.
import { roundMoney } from './rounding';

export type LineItem = { sku: string; unitPrice: number; quantity: number };

export type Quote = { currency: string; subtotal: number; total: number };

export type QuoteOptions = { discountCode?: string; rounding?: 'half-up' | 'bankers' };

const DISCOUNTS: Record<string, number> = { WELCOME10: 0.1, SPRING: 0.15 };

export function applyDiscount(total: number, code: string | undefined): number {
  if (!code) return total;
  const rate = DISCOUNTS[code];
  return rate ? total * (1 - rate) : total;
}

export function quoteFor(items: LineItem[], currency: string, options: QuoteOptions = {}): Quote {
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const total = roundMoney(applyDiscount(subtotal, options.discountCode), options.rounding);
  return { currency, subtotal, total };
}
`;

const ROUNDING_HEAD = `// Money rounding, kept apart from the quote so the rule can be tested on its own.
export function roundMoney(n: number, mode: 'half-up' | 'bankers' = 'half-up'): number {
  const cents = n * 100;
  if (mode === 'bankers') {
    const floor = Math.floor(cents);
    const diff = cents - floor;
    if (diff === 0.5) return (floor % 2 === 0 ? floor : floor + 1) / 100;
  }
  return Math.round(cents) / 100;
}
`;

const CHECKOUT_BASE = `import { quoteFor, LineItem } from '../pricing/quote';

export type Order = { id: string; total: number };

let nextId = 1;

export function createOrder(items: LineItem[]): Order {
  const quote = quoteFor(items, 'USD');
  return { id: String(nextId++), total: quote.total };
}
`;

const CHECKOUT_HEAD = `import { quoteFor, LineItem } from '../pricing/quote';

export type Order = { id: string; total: number };

let nextId = 1;

export function createOrder(items: LineItem[]): Order {
  const quote = quoteFor(items, 'USD', { rounding: 'bankers' });
  return { id: String(nextId++), total: quote.total };
}
`;

const INVOICE = `import { quoteFor, LineItem } from '../pricing/quote';

export type Invoice = { lines: number; amount: number; currency: string };

export function buildInvoice(items: LineItem[], currency: string): Invoice {
  const quote = quoteFor(items, currency);
  return { lines: items.length, amount: quote.total, currency: quote.currency };
}
`;

const QUOTE_TEST = `import { quoteFor } from '../pricing/quote';

describe('quoteFor', () => {
  it('sums the basket', () => {
    const quote = quoteFor([{ sku: 'a', unitPrice: 2, quantity: 3 }], 'EUR');
    if (quote.total !== 6) throw new Error(String(quote.total));
  });
});
`;

const FORMAT_BASE = `export function formatPrice(amount: number, currency: string): string {
  return currency + ' ' + amount.toFixed(2);
}
`;

const FORMAT_HEAD = `export function formatPrice(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
}
`;

const PRICE_TAG_BASE = `// A price with its currency, and an optional strike-through list price.
// Rendering only: the amounts arrive already quoted, this component never computes.
import { formatPrice } from '../format';

export type PriceTagProps = {
  amount: number;
  currency: string;
  listPrice?: number;
  compact?: boolean;
};

export function PriceTag({ amount, currency, listPrice, compact }: PriceTagProps) {
  const onSale = listPrice !== undefined && listPrice > amount;
  return (
    <span className="price-tag">
      {onSale ? <s className="price-tag__list">{formatPrice(listPrice, currency)}</s> : null}
      <strong className="price-tag__amount">{formatPrice(amount, currency)}</strong>
      {compact ? null : <small className="price-tag__currency">{currency}</small>}
    </span>
  );
}

export function PriceTagSkeleton() {
  return <span className="price-tag price-tag--loading" aria-busy="true" />;
}
`;

const PRICE_TAG_HEAD = PRICE_TAG_BASE.replace(
  '  const onSale = listPrice !== undefined && listPrice > amount;',
  '  // A list price equal to the amount is not a sale.\n  const onSale = typeof listPrice === \'number\' && listPrice > amount;',
);

const README_BASE = '# Shop\n\nA pricing service (`packages/api`) and its storefront (`packages/web`).\n';
const README_HEAD = README_BASE + '\nQuotes take options: a discount code and a rounding mode.\n';

/** The committed tree of `main`. */
const BASE = {
  '.gitignore': 'node_modules\ndist\n',
  'package.json': J({ name: 'shop', private: true, workspaces: ['packages/*'] }),
  'README.md': README_BASE,
  'packages/api/package.json': J({ name: '@shop/api', version: '1.0.0' }),
  'packages/api/tsconfig.json': API_TSCONFIG,
  'packages/api/src/pricing/quote.ts': QUOTE_BASE,
  'packages/api/src/orders/checkout.ts': CHECKOUT_BASE,
  'packages/api/src/orders/invoice.ts': INVOICE,
  'packages/api/src/__tests__/quote.test.ts': QUOTE_TEST,
  'packages/web/package.json': J({ name: '@shop/web', version: '1.0.0' }),
  'packages/web/tsconfig.json': WEB_TSCONFIG,
  'packages/web/src/format.ts': FORMAT_BASE,
  'packages/web/src/components/PriceTag.tsx': PRICE_TAG_BASE,
};

/** What the branch commits on top: a path to its new text, or null to delete it. */
const CHANGE = {
  'README.md': README_HEAD,
  'packages/api/src/pricing/quote.ts': QUOTE_HEAD,
  'packages/api/src/pricing/rounding.ts': ROUNDING_HEAD,
  'packages/api/src/orders/checkout.ts': CHECKOUT_HEAD,
  'packages/web/src/format.ts': FORMAT_HEAD,
  'packages/web/src/components/PriceTag.tsx': PRICE_TAG_HEAD,
};

const BRANCH = 'feature/quote-options';

const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (text === null) { fs.rmSync(p, { force: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
};

function build(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'fixture']);
  git(['config', 'commit.gpgsign', 'false']);
  write(dir, BASE);
  git(['add', '-A']);
  git(['commit', '-qm', 'base: pricing service and storefront']);
  git(['checkout', '-qb', BRANCH]);
  write(dir, CHANGE);
  git(['add', '-A']);
  git(['commit', '-qm', 'feat(pricing): quote options with a discount code and a rounding mode']);
  // The TypeScript this project ships, where a real install would put it.
  const ts = path.dirname(require.resolve('typescript/package.json', { paths: [path.join(__dirname, '..')] }));
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.symlinkSync(ts, path.join(dir, 'node_modules', 'typescript'), 'junction');
}

let built = null;

/**
 * The fixture repository, built on first use of the process and reused across runs
 * with the same content.
 * @returns {string} Absolute path of the repository, with the feature branch checked out.
 */
function fixtureRepo() {
  if (built) return built;
  const hash = crypto.createHash('sha256').update(JSON.stringify([BASE, CHANGE, BRANCH, process.version])).digest('hex').slice(0, 12);
  // The repository sits in `repo/` and the marker beside it, so the marker is never an
  // untracked file inside the working tree.
  const home = path.join(fs.realpathSync(os.tmpdir()), 'impact-tree-fixture', hash);
  const ready = path.join(home, '.ready');
  if (!fs.existsSync(ready)) {
    // Build beside the final name, then rename: a half-built directory is never reused.
    const tmp = `${home}.${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    build(path.join(tmp, 'repo'));
    fs.writeFileSync(path.join(tmp, '.ready'), '');
    try { fs.renameSync(tmp, home); } catch (e) {
      // Another process won the race; its copy has the same content.
      if (!fs.existsSync(ready)) throw e;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  built = path.join(home, 'repo');
  return built;
}

module.exports = { fixtureRepo, BASE, CHANGE, BRANCH };
