const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
const start = source.indexOf("  cron.schedule('0 0 1 * *'");
const end = source.indexOf('\n});', start);
assert.ok(start >= 0 && end > start, 'Monthly scheduling block must exist');
const startup = source.slice(start, end);

for (const marker of [null, '2026-09', '2026-10']) {
  test(`startup never catches up votes, including with publication marker ${marker}`, async () => {
    let publications = 0;
    let scheduled;
    let reads = 0;
    let timers = 0;
    const run = new Function('cron', 'autoPublishVotes', 'pgStore', 'getPreviousVotePeriod',
      'MINIMUM_VOTE_REWARD_PERIOD', 'setTimeout', 'console',
      `return (async () => { ${startup} })();`);
    const boot = () => run(
      { schedule: (expression, callback, options) => { scheduled = { expression, callback, options }; } },
      () => { publications++; },
      { getData: async () => { reads++; return marker; } },
      () => ({ key: '2026-11' }),
      '2026-11',
      () => { timers++; },
      { log() {}, warn() {} },
    );
    await boot();
    await boot();
    assert.equal(publications, 0, 'Repeated restarts must not distribute rewards');
    assert.equal(reads, 0, 'Missing historical markers must not trigger startup decisions');
    assert.equal(timers, 0, 'No delayed catch-up may be scheduled');
    assert.equal(scheduled.expression, '0 0 1 * *');
    assert.equal(scheduled.options.timezone, 'Europe/Paris');
    await scheduled.callback();
    assert.equal(publications, 1, 'The normal monthly schedule must remain operational');
  });
}
