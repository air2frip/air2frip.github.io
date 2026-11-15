// air2frip — paiement du panier (fonction Vercel).
// GET /api/checkout?refs=A12,A64  →  redirige vers une page de paiement Stripe avec toutes les pièces.
// La clé secrète Stripe est dans la variable d'environnement STRIPE_KEY (jamais dans le code).
const SITE = "https://air2frip.github.io";
const DATA = "https://raw.githubusercontent.com/air2frip/air2frip.github.io/main/data.json";
const SHIPPING = [
  "shr_1Uc5SqQienttU2P8E1464e0c", // Retrait gratuit à Seraing
  "shr_1Uc5QUQienttU2P8JShhN1Sj", // Mondial Relay
  "shr_1Uc5RSQienttU2P8k8gpAqLR", // bpost domicile
];

function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
  }
  return out.join("&");
}
async function stripe(path, method, body) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: { Authorization: "Bearer " + process.env.STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? form(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error && j.error.message || "Stripe " + r.status);
  return j;
}
function go(res, url) { res.statusCode = 303; res.setHeader("Location", url); res.setHeader("Cache-Control", "no-store"); res.end(); }

module.exports = async (req, res) => {
  try {
    const u = new URL(req.url, "https://x");
    const refs = [...new Set((u.searchParams.get("refs") || "").split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]\d{1,4}$/.test(s)))].slice(0, 20);
    if (!refs.length) return go(res, SITE + "/#panier");
    const d = await (await fetch(DATA + "?t=" + Date.now(), { cache: "no-store" })).json();
    const byRef = Object.fromEntries(d.items.map(x => [x.r, x]));
    const items = [], gone = [];
    for (const r of refs) {
      const x = byRef[r];
      if (!x || x.st !== "dispo" || x.hist || !x.px || !x.pay) { gone.push(r); continue; }
      if (x.pid) { // pièce déjà payée via son lien individuel ?
        try { const pl = await stripe("payment_links/" + x.pid, "GET"); if (!pl.active) { gone.push(r); continue; } } catch (e) {}
      }
      items.push(x);
    }
    if (gone.length) return go(res, SITE + "/?indispo=" + gone.join(","));
    const cents = items.map(x => Math.round(x.px * 100));
    const total = cents.reduce((a, b) => a + b, 0);
    const lot = d.lot && d.lot.min > 1 && d.lot.pct > 0 ? d.lot : null;
    let discounts;
    if (lot && items.length >= lot.min) {
      const off = Math.round(total * lot.pct / 100);
      const c = await stripe("coupons", "POST", { amount_off: off, currency: "eur", duration: "once", max_redemptions: 1, name: `Remise lot −${lot.pct} %` });
      discounts = [{ coupon: c.id }];
    }
    const list = items.map(x => x.r).join(",");
    const s = await stripe("checkout/sessions", "POST", {
      mode: "payment", locale: "fr",
      line_items: items.map((x, i) => ({ quantity: 1, price_data: { currency: "eur", unit_amount: cents[i], product_data: {
        name: `${x.b} – ${x.n} · ${x.s}`, description: `Seconde main, ${(x.e || "").toLowerCase()} · réf. ${x.r}`,
        images: [SITE + "/" + x.p[0]], metadata: { ref: x.r } } } })),
      discounts,
      shipping_address_collection: { allowed_countries: ["BE", "FR", "NL", "LU"] },
      shipping_options: SHIPPING.map(id => ({ shipping_rate: id })),
      phone_number_collection: { enabled: "true" },
      metadata: { refs: list, source: "panier" },
      payment_intent_data: { description: "air2frip panier " + list, metadata: { refs: list, source: "panier" } },
      custom_text: {
        shipping_address: { message: "Retrait gratuit à Seraing : indique simplement ton adresse, je te contacte pour fixer le rendez-vous. Mondial Relay : je choisis le point relais le plus proche de ton adresse." },
        submit: { message: "Pièces uniques : dès ton paiement, elles sont réservées pour toi. Je te contacte dans les 24 h." },
      },
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: SITE + "/?merci=" + list,
      cancel_url: SITE + "/#panier",
    });
    return go(res, s.url);
  } catch (e) {
    console.error(e);
    return go(res, SITE + "/?paiement=erreur&detail=" + encodeURIComponent(String(process.env.STRIPE_KEY ? (e.message || e) : "STRIPE_KEY manquante").slice(0, 160)));
  }
};
