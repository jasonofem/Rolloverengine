/**
 * store-worker.mjs — a second process over one store.json.
 *
 * Forked by the "persistence & storage" suite. The whole point is that it
 * imports lib/store.js ONCE and keeps using it, because the bug this guards was
 * a long-lived process holding a stale snapshot: it would write back everything
 * another process had deleted. A fresh import would prove nothing.
 *
 * Protocol: reads the run list, reports it, waits for a 'changed' message from
 * the parent (which has rewritten the file behind our back), reads again and
 * reports. If the cache is not invalidated by mtime, the second count is wrong.
 */
process.env.RE_DATA_DIR = process.env.RE_DATA_DIR; // inherited from the parent

const store = await import('../../lib/store.js');

const count = async () => (await store.listRuns(50)).map((r) => r.id);

process.send({ phase: 'first', ids: await count() });

process.on('message', async (m) => {
  if (m === 'changed') {
    process.send({ phase: 'second', ids: await count() });
  }
  if (m === 'write') {
    // Now write from this process, as the CLI would, and report what survived.
    await store.saveRun({
      id: 'from-worker',
      status: 'active',
      createdAt: Date.now(),
      config: { currency: 'NGN', days: 7, targetOdds: 2, stake: 500 },
      startBalance: 500,
      balance: 500,
      currentDay: 1,
      stats: { won: 0 },
      days: [],
    });
    process.send({ phase: 'wrote', ids: await count() });
  }
  if (m === 'exit') process.exit(0);
});
