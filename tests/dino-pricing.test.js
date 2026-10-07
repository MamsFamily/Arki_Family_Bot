'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withVariantPrices } = require('../dinoPricing');
const { product } = require('../nexus-bridge/router');

const dino = () => ({
  name: 'Rex', priceDiamonds: 5000, priceStrawberries: 1500,
  variants: [{ label: 'X', priceDiamonds: 6000, priceStrawberries: 1800 },
    { label: 'R', priceDiamonds: 7000, priceStrawberries: 2100 }],
});

test('X is exactly base + 4000 diamonds and + 1200 strawberries', () => {
  const source = dino();
  const result = withVariantPrices(source);
  assert.equal(result.variants[0].priceDiamonds, 9000);
  assert.equal(result.variants[0].priceStrawberries, 2700);
  assert.equal(source.variants[0].priceDiamonds, 6000);
  assert.deepEqual(result.variants[1], source.variants[1]);
});

test('base edits update X; repeated calculations never accumulate surcharges', () => {
  const first = withVariantPrices(dino());
  assert.deepEqual(withVariantPrices(first), first);
  const result = withVariantPrices({ ...first, priceDiamonds: 10000, priceStrawberries: 2000 });
  assert.equal(result.variants[0].priceDiamonds, 14000);
  assert.equal(result.variants[0].priceStrawberries, 3200);
});

test('X matching is case insensitive; availability and visibility stay unchanged', () => {
  const result = withVariantPrices({ priceDiamonds: '3000', priceStrawberries: '900',
    variants: [{ label: ' x ', hidden: true, notAvailableShop: true }, { label: 'X-Rex', priceDiamonds: 15 }] });
  assert.deepEqual(result.variants[0], { label: ' x ', hidden: true, notAvailableShop: true, priceDiamonds: 7000, priceStrawberries: 2100 });
  assert.equal(result.variants[1].priceDiamonds, 15);
});

test('zero bases and dinos without variants work', () => {
  assert.deepEqual(withVariantPrices({ name: 'Rex' }), { name: 'Rex' });
  const result = withVariantPrices({ variants: [{ label: 'X' }] });
  assert.equal(result.variants[0].priceDiamonds, 4000);
  assert.equal(result.variants[0].priceStrawberries, 1200);
});

test('Lenexus fresh catalogue calculates the same price; packs and non-X unchanged', () => {
  const dto = product(dino(), 'dino');
  assert.deepEqual(dto.prices, [{ label: 'Standard', diamonds: 5000, strawberries: 1500 },
    { label: 'X', diamonds: 9000, strawberries: 2700 },
    { label: 'R', diamonds: 7000, strawberries: 2100 }]);
  assert.equal(product(dino(), 'pack').prices[1].diamonds, 6000);
});

test('catalogue reads, admin base edits and new dinos all derive X prices without a database migration', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  let saved;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../dinoManager'), 'utf8'), {
    __dirname: '/synthetic', module, console,
    require: name => {
      if (name === './pgStore') return { isPostgres: () => false };
      if (name === './dinoPricing') return { withVariantPrices };
      if (name === 'fs') return {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({ dinos: [{ ...dino(), id: 'rex' }] }),
        writeFileSync: (_path, value) => { saved = JSON.parse(value); },
      };
      return require(name);
    },
  });
  const manager = module.exports;
  await manager.initDinos();
  assert.equal(manager.getDino('rex').variants[0].priceDiamonds, 9000);
  await manager.updateDino('rex', { priceDiamonds: 20000, priceStrawberries: 100 });
  assert.equal(saved.dinos[0].variants[0].priceDiamonds, 24000);
  assert.equal(saved.dinos[0].variants[0].priceStrawberries, 1300);
  assert.equal(manager.getDino('rex').variants[1].priceDiamonds, 7000);
  const added = await manager.addDino(dino());
  assert.equal(manager.getDino(added.id).variants[0].priceStrawberries, 2700);
});
