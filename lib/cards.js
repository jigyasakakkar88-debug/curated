// Algolia record → the product shape the feed's card() and modal use (plus brandId/gender for evals).
const NEW_DAYS = 7;

function toCard(r) {
  const published = r.publishedAt ? new Date(r.publishedAt).getTime() : 0;
  return {
    id: r.objectID, brandId: r.brandId, brandName: r.brandName, name: r.name,
    productUrl: r.productUrl, brandUrl: (r.productUrl || '').split('/products/')[0],
    image: r.image, price: r.price, comparePrice: r.comparePrice || null, discountPct: r.discountPct || 0,
    isSale: (r.discountPct || 0) >= 10, isNew: published > Date.now() - NEW_DAYS * 864e5,
    category: r.productType || 'Clothing', tags: (r.tags || []).slice(0, 5),
    availableSizes: r.sizesAvailable || [], publishedAt: r.publishedAt,
    department: r.department, gender: r.gender,
  };
}

async function loadCards(client, index, ids) {
  if (!ids.length) return [];
  const { results } = await client.getObjects({ requests: ids.map(id => ({ indexName: index, objectID: id })) });
  return results.filter(Boolean).map(toCard);
}

module.exports = { toCard, loadCards };
