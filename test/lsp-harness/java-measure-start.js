'use strict';
// J6 pass 4: one jdtls start on a repository, logging every import-end event (200 / 100) and
// `$/progress` begin/end with its time from ServiceReady, for `windowMs` after ready. Runs no
// checkout and nothing of the repository's. Usage: node java-measure-start.js <repo> <-data> [windowMs]
const { createJdtlsServices } = require('./jdtls-services');

async function main() {
  const [repo, dataDir, windowArg] = process.argv.slice(2);
  if (!repo || !dataDir) throw new Error('usage: java-measure-start.js <repo> <-data> [windowMs]');
  const windowMs = Number(windowArg || 120000);
  const t0 = Date.now();
  const server = createJdtlsServices({ repo, dataDir });
  const kill = setTimeout(() => server.client.proc.kill('SIGKILL'), windowMs + 8 * 60 * 1000);
  try {
    await server.start();
    console.log(`ready ${((server.readyAt() - t0) / 1000).toFixed(1)} s after spawn; quiet ${((Date.now() - server.readyAt()) / 1000).toFixed(1)} s after ready`);
    while (Date.now() - server.readyAt() < windowMs) await new Promise((r) => setTimeout(r, 500));
    const events = [
      ...server.importEvents.map((e) => ({ at: e.msFromReady, what: `event ${e.eventType}` })),
      ...server.progressEvents.map((e) => ({ at: e.msFromReady, what: `progress ${e.kind} ${e.title}` })),
    ].sort((a, b) => (a.at ?? -1e9) - (b.at ?? -1e9));
    for (const e of events) console.log(`${e.at === null ? 'before ready' : `${(e.at / 1000).toFixed(1)} s`.padStart(8)}  ${e.what}`);
    console.log(`status at ${windowMs / 1000} s: ${server.javaServerStatus.busyReason() || 'not busy'}`);
  } finally {
    clearTimeout(kill);
    await server.close().catch((e) => console.error(`closing jdtls: ${e.message}`));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
