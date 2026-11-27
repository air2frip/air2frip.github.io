// Viz2frip — reverse automatiquement la part de Malo après chaque paiement du site commun (Stripe Connect).
// Stripe appelle cette adresse à chaque paiement réussi (événement checkout.session.completed).
// Variables d'environnement à poser sur Vercel (par Romain, jamais dans le code) :
//   STRIPE_KEY              clé restreinte : Checkout Sessions (lecture/écriture), PaymentIntents (lecture), Charges (lecture),
//                           Balance transactions (lecture), Transfers (écriture)
//   STRIPE_WEBHOOK_SECRET   « Signing secret » du webhook (whsec_…)
//   MALO_ACCOUNT            compte Stripe connecté de Malo (acct_…)
// Règle des frais : les frais Stripe du paiement sont partagés au prorata des pièces de chacun ;
// la livraison payée par le client reste à Romain (c'est lui qui achète les bordereaux Sendcloud).
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
  if (!(partMalo > 0)) return send(res, 200, "aucune pièce de Malo");
  if (!process.env.MALO_ACCOUNT) return send(res, 500, "MALO_ACCOUNT manquant");
  try {
    const pi = await stripe(`payment_intents/${s.payment_intent}?expand[]=latest_charge.balance_transaction`, "GET");
    const ch = pi.latest_charge;
    const fee = (ch && ch.balance_transaction && ch.balance_transaction.fee) || 0;
    const feeMalo = Math.round(fee * partMalo / (partMalo + partRomain));
    const amount = partMalo - feeMalo;
    const t = await stripe("transfers", "POST", {
      amount, currency: "eur", destination: process.env.MALO_ACCOUNT,
      source_transaction: ch.id, transfer_group: m.transfer_group || pi.transfer_group,
      description: "Viz2frip — part de Malo " + (m.skus || ""),
      metadata: { session: s.id, skus: m.skus || "", part_malo: partMalo, frais_malo: feeMalo },
    }, "viz2frip-transfer-" + s.id);
    return send(res, 200, "part de Malo virée : " + t.id);
  } catch (e) {
    console.error(e);
    return send(res, 500, String(e.message || e).slice(0, 200)); // Stripe réessaiera plus tard
  }
};
module.exports.config = { api: { bodyParser: false } };
