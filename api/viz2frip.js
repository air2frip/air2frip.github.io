// Viz2frip — paiement du panier du site commun (fonction Vercel, compte Stripe de Romain).
// GET /api/viz2frip?ids=10890799221,RA155  →  page de paiement Stripe avec toutes les pièces (Malo et Romain mélangés).
// Un seul paiement pour le client ; la part de chacun est notée dans le paiement (part_malo / part_romain, en centimes).
// La part de Malo lui est ensuite virée automatiquement par api/viz2frip-webhook.js (Stripe Connect).
// Tant que le compte de Malo (MALO_ACCOUNT) ne peut pas recevoir de virements, ses pièces ne se paient pas en ligne.
// La clé secrète Stripe est dans la variable d'environnement STRIPE_KEY (jamais dans le code).
const SITE = process.env.VIZ2FRIP_SITE || "https://viz2frip.be";
const PRODUCTS = SITE + "/products.js";
const AIR2FRIP_DATA = "https://raw.githubusercontent.com/air2frip/air2frip.github.io/main/data.json";
const SHIPPING = [
  { shipping_rate_data: { display_name: "Retrait gratuit à Liège", type: "fixed_amount", fixed_amount: { amount: 0, currency: "eur" } } },
  { shipping_rate: "shr_1Uc5SqQienttU2P8E1464e0c" }, // Retrait gratuit à Seraing
  { shipping_rate: "shr_1Uc5QUQienttU2P8JShhN1Sj" }, // Mondial Relay point relais
  { shipping_rate: "shr_1Uc5RSQienttU2P8k8gpAqLR" }, // bpost domicile
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

async function products() {
  const t = await (await fetch(PRODUCTS + "?t=" + Date.now(), { cache: "no-store" })).text();
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  return JSON.parse(t.slice(a, b + 1));
}

module.exports = async (req, res) => {
  try {
    const u = new URL(req.url, "https://x");
    const ids = [...new Set((u.searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(s => /^[A-Za-z0-9_-]{2,30}$/.test(s)))].slice(0, 20);
    if (!ids.length) return go(res, SITE + "/#panier");
    const P = await products();
    const byId = Object.fromEntries(P.map(p => [String(p.id), p]));
    // Pièces de Romain : on revérifie aussi son catalogue air2frip (une pièce vendue là-bas ne se vend pas ici).
    let a2f = {};
    if (ids.some(id => byId[id] && byId[id].seller === "romain")) {
      const d = await (await fetch(AIR2FRIP_DATA + "?t=" + Date.now(), { cache: "no-store" })).json();
      a2f = Object.fromEntries(d.items.map(x => [x.r, x]));
    }
    const items = [], gone = [];
    for (const id of ids) {
      const p = byId[id];
      if (!p || p.available === false || !(p.price > 0) || !["malo", "romain"].includes(p.seller)) { gone.push(id); continue; }
      if (p.seller === "romain") {
        const x = a2f[String(p.sku || "").replace(/^R/, "A")];
        if (!x || x.st !== "dispo") { gone.push(id); continue; }
      }
      items.push(p);
    }
    if (gone.length) return go(res, SITE + "/?indispo=" + gone.join(","));
    const cents = items.map(p => Math.round(p.price * 100));
    const part = { malo: 0, romain: 0 };
    items.forEach((p, i) => { part[p.seller] += cents[i]; });
    // Pièces de Malo : paiement en ligne seulement si son compte Stripe peut recevoir les virements.
    // Sinon l'argent resterait chez Romain, qui devrait le reverser à la main : on refuse plutôt.
    if (part.malo > 0) {
      if (!process.env.MALO_ACCOUNT) throw new Error("compte Stripe de Malo pas encore relié");
      const acc = await stripe("accounts/" + encodeURIComponent(process.env.MALO_ACCOUNT), "GET");
      if (!acc.capabilities || acc.capabilities.transfers !== "active") throw new Error("compte Stripe de Malo pas encore activé");
    }
    const list = items.map(p => p.id).join(","), skus = items.map(p => p.sku).join(",");
    const group = "viz2frip-" + Date.now().toString(36);
    const meta = { source: "viz2frip", ids: list.slice(0, 480), skus: skus.slice(0, 480), part_malo: part.malo, part_romain: part.romain, transfer_group: group };
    const s = await stripe("checkout/sessions", "POST", {
      mode: "payment", locale: "fr",
      line_items: items.map((p, i) => ({ quantity: 1, price_data: { currency: "eur", unit_amount: cents[i], product_data: {
        name: `${p.brand} – ${p.category} · ${p.size}`.slice(0, 120),
        description: `Seconde main, ${(p.condition || "").toLowerCase()} · réf. ${p.sku}`,
        images: p.cover ? [SITE + "/" + p.cover] : undefined, metadata: { id: String(p.id), sku: p.sku, seller: p.seller } } } })),
      shipping_address_collection: { allowed_countries: ["BE", "FR", "NL", "LU"] },
      shipping_options: SHIPPING,
      phone_number_collection: { enabled: "true" },
      metadata: meta,
      payment_intent_data: { description: "Viz2frip " + skus.slice(0, 200), transfer_group: group, metadata: meta },
      custom_text: {
        shipping_address: { message: "Retrait gratuit à Liège ou à Seraing : indique simplement ton adresse, on te contacte pour fixer le rendez-vous. Mondial Relay : on choisit le point relais le plus proche de ton adresse." },
        submit: { message: "Pièces uniques : dès ton paiement, elles sont réservées pour toi. On te contacte dans les 24 h." },
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
