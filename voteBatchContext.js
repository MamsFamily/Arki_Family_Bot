const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const context = new AsyncLocalStorage();

function runVoteRewardBatch(callback) {
  if (context.getStore()) return callback();
  return context.run({ id: randomUUID(), startedAt: new Date().toISOString() }, callback);
}

module.exports = { runVoteRewardBatch, getVoteRewardBatch: () => context.getStore() };
