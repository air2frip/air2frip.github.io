// Viz2frip — reverse automatiquement la part de Malo après chaque paiement du site commun (Stripe Connect).
// Stripe appelle cette adresse à chaque paiement réussi (événement checkout.session.completed).
// Variables d'environnement à poser sur Vercel (par Romain, jamais dans le code) :
//   STRIPE_KEY              clé restreinte : Checkout Sessions (lecture/écriture), PaymentIntents (lecture), Charges (lecture),
//                           Balance transactions (lecture), Transfers (écriture)
//   STRIPE_WEBHOOK_SECRET   « Signing secret » du webhook (whsec_…)
//   MALO_ACCOUNT            compte Stripe connecté de Malo (acct_…)
//   SENDCLOUD_ROMAIN_KEY / SENDCLOUD_ROMAIN_SECRET / SENDCLOUD_ROMAIN_INTEGRATION   clés API Sendcloud de Romain + id de l'intégration
//   SENDCLOUD_MALO_KEY   / SENDCLOUD_MALO_SECRET   / SENDCLOUD_MALO_INTEGRATION     idem pour le compte Sendcloud de Malo
//   VIZ2FRIP_MIXTE          qui expédie un panier mélangé : "romain" (par défaut) ou "malo"
// Après chaque paiement, la commande est envoyée dans le Sendcloud de celui qui expédie (pas pour un retrait en main propre).
// Les étiquettes ne sont jamais créées ici : chacun les fait dans Sendcloud.
// Livraison (payée par l'acheteur) : elle revient à celui qui paie l'envoi.
//   panier 100 % Malo → toute la livraison à Malo ; 100 % Romain → à Romain ; panier mélangé → moitié chacun.
// Frais Stripe du paiement : partagés au prorata de ce que chacun reçoit (pièces + livraison).
const crypto = require("crypto");

function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
  }
  return out.join("&");
}
async function stripe(path, method, body, idem) {
  const headers = { Authorization: "Bearer " + process.env.STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" };
  if (idem) headers["Idempotency-Key"] = idem;
  const r = await fetch("https://api.stripe.com/v1/" + path, { method, headers, body: body ? form(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error && j.error.message || "Stripe " + r.status);
  return j;
}
function rawBody(req) {
  return new Promise((ok, ko) => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); req.on("error", ko); });
}
function verify(raw, header, secret) {
  const parts = Object.fromEntries(String(header || "").split(",").map(x => x.split("=")));
  const t = parts.t, v1 = String(header || "").split(",").filter(x => x.startsWith("v1=")).map(x => x.slice(3));
  if (!t || !v1.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const exp = crypto.createHmac("sha256", secret).update(t + "." + raw.toString("utf8")).digest("hex");
  return v1.some(s => s.length === exp.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp)));
}
function send(res, code, msg) { res.statusCode = code; res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.end(msg); }

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, "POST seulement");
  const raw = await rawBody(req);
  if (!process.env.STRIPE_WEBHOOK_SECRET || !verify(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET))
    return send(res, 400, "signature invalide");
  const ev = JSON.parse(raw.toString("utf8"));
  if (ev.type !== "checkout.session.completed") return send(res, 200, "ignoré");
  const s = ev.data.object;
  const m = s.metadata || {};
  if (m.source !== "viz2frip" || s.payment_status !== "paid") return send(res, 200, "pas un paiement viz2frip");
  const partMalo = Number(m.part_malo || 0), partRomain = Number(m.part_romain || 0);
  const errors = [], done = [];
  if (partMalo > 0) {
    try { done.push("part de Malo virée : " + await transferMalo(s, m, partMalo, partRomain)); }
    catch (e) { console.error(e); errors.push("virement Malo : " + (e.message || e)); }
  }
  try { done.push(await toSendcloud(s, m, partMalo, partRomain)); }
  catch (e) { console.error(e); errors.push("Sendcloud : " + (e.message || e)); }
  // En cas d'erreur, Stripe renvoie l'événement plus tard : virement et commande Sendcloud ne se créent pas deux fois.
  return send(res, errors.length ? 500 : 200, [...done, ...errors].join(" | ").slice(0, 300));
};

async function transferMalo(s, m, partMalo, partRomain) {
  if (!process.env.MALO_ACCOUNT) throw new Error("MALO_ACCOUNT manquant");
  const pi = await stripe(`payment_intents/${s.payment_intent}?expand[]=latest_charge.balance_transaction`, "GET");
  const ch = pi.latest_charge;
  const fee = (ch && ch.balance_transaction && ch.balance_transaction.fee) || 0;
  const ship = shipping(s);
  const shipMalo = partRomain > 0 ? Math.floor(ship / 2) : ship;
  const total = partMalo + partRomain + ship;
  const feeMalo = Math.round(fee * (partMalo + shipMalo) / total);
  const amount = partMalo + shipMalo - feeMalo;
  const t = await stripe("transfers", "POST", {
    amount, currency: "eur", destination: process.env.MALO_ACCOUNT,
    source_transaction: ch.id, transfer_group: m.transfer_group || pi.transfer_group,
    description: "Viz2frip — part de Malo " + (m.skus || ""),
    metadata: { session: s.id, skus: m.skus || "", part_malo: partMalo, livraison_malo: shipMalo, frais_malo: feeMalo },
  }, "viz2frip-transfer-" + s.id);
  return t.id;
}
function shipping(s) {
  return (s.shipping_cost && s.shipping_cost.amount_total) || (s.total_details && s.total_details.amount_shipping) || 0;
}

async function toSendcloud(s, m, partMalo, partRomain) {
  const rateId = s.shipping_cost && s.shipping_cost.shipping_rate;
  const rate = rateId ? await stripe("shipping_rates/" + rateId, "GET") : null;
  const carrier = (rate && rate.metadata && rate.metadata.carrier) || "";
  if (!carrier || carrier.startsWith("retrait")) return "retrait en main propre : pas de Sendcloud";
  const who = partMalo > 0 && partRomain > 0 ? (process.env.VIZ2FRIP_MIXTE === "malo" ? "malo" : "romain") : (partMalo > 0 ? "malo" : "romain");
  const W = who.toUpperCase();
  const key = process.env[`SENDCLOUD_${W}_KEY`], secret = process.env[`SENDCLOUD_${W}_SECRET`], integ = Number(process.env[`SENDCLOUD_${W}_INTEGRATION`]);
  if (!key || !secret || !integ) throw new Error(`clés Sendcloud de ${who} manquantes`);
  const items = await stripe(`checkout/sessions/${s.id}/line_items?limit=50&expand[]=data.price.product`, "GET");
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
  const a = ship.address || {}, c = s.customer_details || {};
  const eur = cents => ({ value: Math.round(cents) / 100, currency: "EUR" });
  const order = [{
    order_id: s.id, order_number: "VIZ-" + s.id.slice(-8).toUpperCase(),
    order_details: {
      integration: { id: integ },
      status: { code: "paid", message: "Payé en ligne (Stripe)" },
      order_created_at: new Date((s.created || Date.now() / 1000) * 1000).toISOString(),
      notes: `Viz2frip — ${rate.display_name}. Pièces : ${m.skus || ""}` + (partMalo > 0 && partRomain > 0 ? " (panier mélangé Malo + Romain)" : ""),
      tags: ["viz2frip", carrier],
      order_items: items.data.map(li => {
        const pr = li.price && li.price.product || {}, md = pr.metadata || {};
        return { name: pr.name || li.description, quantity: li.quantity || 1, sku: md.sku, product_id: md.id,
          unit_price: eur(li.price.unit_amount), total_price: eur(li.amount_total), properties: { vendeur: md.seller || "" } };
      }),
    },
    payment_details: { status: { code: "paid" }, total_price: eur(s.amount_total), subtotal_price: eur(s.amount_subtotal),
      estimated_shipping_price: eur(shipping(s)) },
    customer_details: { name: ship.name || c.name || "Client", email: c.email, phone_number: c.phone },
    shipping_address: { name: ship.name || c.name || "Client", address_line_1: a.line1, address_line_2: a.line2 || undefined,
      postal_code: a.postal_code, city: a.city, country_code: a.country || "BE", email: c.email, phone_number: c.phone },
    shipping_details: { delivery_indicator: rate.display_name, is_local_pickup: false },
  }];
  const r = await fetch("https://panel.sendcloud.sc/api/v3/orders", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(key + ":" + secret).toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });
  if (!r.ok) throw new Error("Sendcloud " + r.status + " " + (await r.text()).slice(0, 150));
  return `commande envoyée dans le Sendcloud de ${who}`;
}
module.exports.config = { api: { bodyParser: false } };
