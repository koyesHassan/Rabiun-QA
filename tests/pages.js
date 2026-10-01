// Central list of pages under test. Update here when the catalogue changes.
// Test names are built from `name`, and the dashboard's per-check history is
// keyed on test names, so keep a name stable even if the product is retitled.
module.exports.PRODUCT_PAGES = [
  {
    name: 'Jeans (Selvedge Denim)',
    path: '/products/rabiun-heavyweight-selvedge-denim-forest-green-yellow-overdye',
    expectPriceContains: '150', // £150.00 as of 2026-09-27 — update if price changes
  },
  {
    name: 'Hat (Green & Leopard)',
    path: '/products/rabiun-double-brim-painters-hat-green-and-leopard',
    expectPriceContains: '70', // £70.00 as of 2026-09-27
  },
  {
    name: 'Hat (Black & Zebra)',
    path: '/products/double-brim-painters-hat-black-and-zebra-print',
    expectPriceContains: '70', // £70.00 as of 2026-09-27
  },
];

module.exports.OTHER_PAGES = [
  { name: 'Homepage', path: '/' },
  // No meta description as of 2026-09-27. tests/audit.spec.js reports it as
  // an advisory; drop this flag once one is set in Shopify admin.
  { name: 'Shop all', path: '/collections/all', metaDescriptionOptional: true },
  { name: 'Checkout entry (cart)', path: '/cart' },
  { name: 'FAQ / Contact', path: '/pages/contact' },
];

// Known redirects worth checking daily. Add an entry every time a redirect bug
// gets found and fixed, so it's caught automatically if it regresses:
// { name: '...', from: '/products/old-slug', expectPathContains: '/products/new-slug' }
module.exports.REDIRECT_CHECKS = [];
