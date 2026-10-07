'use strict';

/** X prices are totals derived from the current base price, not a surcharge cart item. */
function withVariantPrices(dino) {
  if (!Array.isArray(dino.variants)) return dino;
  return {
    ...dino,
    variants: dino.variants.map(variant => {
      if (String(variant.label || '').trim().toUpperCase() !== 'X') return variant;
      return {
        ...variant,
        priceDiamonds: (Number(dino.priceDiamonds) || 0) + 4000,
        priceStrawberries: (Number(dino.priceStrawberries) || 0) + 1200,
      };
    }),
  };
}

module.exports = { withVariantPrices };
