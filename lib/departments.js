// Rule-based department label for a product, from its Shopify product type and name.
// Departments: clothing | accessories | fabric | home | other.
// Tags are deliberately not used: they are noisy ("fabric: cotton", "rakhi-special" on kurtas).
const RULES = [
  ['other',       /\b(gift ?card|rakhis?|incense|agarbatti|soaps?|candles?|hampers?|herbal tea|tea\b|toothbrush|comb\b|lotion|scrub|perfumes?|fragrance|attar|diary|diaries|notebook|stationery|sticker|voucher)/i],
  ['home',        /\b(cushions?|pillows?|bed ?sheets?|bedding|bed ?covers?|duvet|quilts?|dohar|blankets?|throw\b|towels?|napkins?|table ?(cloths?|runners?|linen)|curtains?|rugs?\b|dhurries?|tapestry|placemats?|coasters?|aprons?|home|decor|decoration|wall ?(art|hanging)|lighting|lamps?|lanterns?|magnets?|baskets?|drinkware|mugs?|furnishing|tableware|planters?)\b/i],
  ['fabric',      /\b(fabrics?|dress ?materials?|unstitched|unstitch|by the (metre|meter)|running material|yardage|suit pieces?)\b/i],
  ['accessories', /\b(bags?|tote|sling|clutch|potlis?|backpack|wallets?|purses?|pouch(es)?|handbags?|organi[sz]ers?|laptop|duffle|satchel|travel|cases?|belts?|jewel(le)?ry|jewelery|earrings?|ear ?chains?|chains?|jhumkas?|pendants?|naths?|nose ?(pins?|rings?)|maang ?tik(k)?as?|tikkas?|kadas?|brooch(es)?|payals?|haath ?phool|necklaces?|nacklaces?|chokers?|bangles?|bracelets?|rings?|anklets?|hair ?(clips?|bands?|ties?|accessories)|scrunchies?|masks?|caps?|hats?|socks?|sunglasses|eyewear|footwear|shoes?|sandals?|heels|flats|sliders|wedges|mules|juttis?|mojaris?|kolhapuris?|chappals?|slippers?|watch(es)?|keychains?|key ?rings?|card ?holders?|accessories|accessory)\b/i],
];

// Product types that name a garment: trust them as clothing even if the name mentions "fabric".
const CLOTHING_TYPE = /\b(kurtas?|kurtis?|sarees?|saris?|dress(es)?|tops?|shirts?|t-?shirts?|tees?|pants?|trousers?|palazzos?|pallazos?|skirts?|co-?ord|sets?|dupattas?|stoles?|shawls?|scarf|scarves|blouses?|jackets?|lehengas?|kaftans?|jumpsuits?|tunics?|salwars?|churidars?|shrugs?|capes?|bandis?|shorts|bottoms|nightwear|loungewear|innerwear|underwear|apparels?|clothing|suits?|anarkalis?|gowns?|coats?|vests?|waistcoats?|sherwanis?|bundis?)\b/i;

function classifyDepartment({ name = '', productType = '' }) {
  const type = productType.trim();
  // "Apparel & Accessories" and similar catch-all types say nothing; decide from the name instead.
  const typeIsGeneric = !type || /apparel|accessor.*&|&.*accessor/i.test(type) && CLOTHING_TYPE.test(type);
  if (!typeIsGeneric) {
    for (const [dept, re] of RULES) if (re.test(type)) return dept;
    if (CLOTHING_TYPE.test(type)) return 'clothing';
  }
  // In names, a garment word beats fabric/accessory words ("Kurta in Cotton Fabric", "Travel-Tunic") unless sold unstitched.
  if (/\b(unstitch(ed)?|dress ?materials?)\b/i.test(name)) return 'fabric';
  for (const [dept, re] of RULES) {
    if ((dept === 'fabric' || dept === 'accessories') && CLOTHING_TYPE.test(name)) continue;
    if (re.test(name)) return dept;
  }
  return 'clothing';
}

module.exports = { classifyDepartment, DEPARTMENTS: ['clothing', 'accessories', 'fabric', 'home', 'other'] };
