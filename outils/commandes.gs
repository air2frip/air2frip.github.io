/**
 * air2frip · réception des commandes du catalogue
 *
 * Ce script tourne gratuitement dans ton Google Sheet (Extensions > Apps Script).
 * À chaque commande passée sur air2frip.github.io :
 *   1. il vérifie les pièces et recalcule le prix à partir de data.json
 *      (pièce vendue, déjà réservée ou pas encore en ligne = refusée) ;
 *   2. il ajoute une ligne dans l'onglet « Commandes » ;
 *   3. il t'envoie un e-mail avec tout le détail ;
 *   4. il envoie au client un récapitulatif avec les infos de virement.
 *
 * Le catalogue lit aussi la liste des pièces réservées (commandes en attente
 * de paiement depuis moins de 72 h, payées ou livrées) pour les afficher
 * « Réservée » et éviter qu'elles soient commandées deux fois.
 *
 * Statuts (colonne D, liste déroulante) : En attente de paiement, Payée,
 * Livrée, Annulée. Passe une commande en « Annulée » pour libérer ses pièces.
 */

const CATALOGUE_URL = "https://air2frip.github.io/";
const DATA_URL = CATALOGUE_URL + "data.json";
const SHEET = "Commandes";
const HOLD_HOURS = 72;
const TZ = "Europe/Brussels";
const ST_WAIT = "En attente de paiement", ST_PAID = "Payée", ST_DONE = "Livrée", ST_CANCEL = "Annulée";
const HEAD = ["Date", "N°", "Communication", "Statut", "Total à payer", "Remise", "Réfs", "Articles", "Réception",
  "Transporteur", "Prénom", "Nom", "Téléphone", "E-mail", "Adresse", "Code postal", "Ville", "Pays", "Message"];
const MODES = { livraison: "Livraison à domicile (offerte)", retrait: "Retrait", envoi: "Envoi par colis (frais à charge du client)" };

function doGet() {
  return json_({ ok: true, reserved: Array.from(reserved_(sheet_())) });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const o = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const c = clean_(o.client || {});
    const mode = MODES[o.mode] ? o.mode : "";
    const refs = Array.from(new Set((o.refs || []).map(String))).slice(0, 40);
    const need = ["prenom", "nom", "tel", "email"].concat(mode === "retrait" ? [] : ["rue", "cp", "ville"]);
    if (!refs.length || !mode || need.some(k => !c[k])) return json_({ ok: false, error: "Commande incomplète : vérifie tes coordonnées." });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) return json_({ ok: false, error: "Adresse e-mail invalide." });

    const data = JSON.parse(UrlFetchApp.fetch(DATA_URL + "?v=" + Date.now()).getContentText());
    const sh = sheet_();
    const res = reserved_(sh);
    const now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm");
    const items = refs.map(r => (data.items || []).find(x => x.r === r));
    const unavailable = refs.filter((r, i) => {
      const x = items[i];
      return !x || x.st === "vendu" || !x.px || res.has(r) || (x.pub && x.pub > now);
    });
    if (unavailable.length) {
      return json_({ ok: false, unavailable: unavailable,
        error: (unavailable.length > 1 ? "Ces pièces viennent" : "Cette pièce vient") + " de partir : " + unavailable.join(", ") + "." });
    }

    const q = quote_(items, data.lot);
    const ref = nextRef_();
    const pay = data.pay || {};
    const link = CATALOGUE_URL + "commande.html#" + [
      "n=" + encodeURIComponent(ref.n), "c=" + ref.digits, "t=" + q.total.toFixed(2),
      "r=" + encodeURIComponent(refs.join(",")), "m=" + mode, "p=" + encodeURIComponent(c.prenom)].join("&");
    const lines = items.map(x => x.r + " – " + x.b + " " + x.n + ", " + x.c + ", taille " + x.s + " – " + eur_(x.px));

    sh.appendRow([new Date(), ref.n, ref.comm, ST_WAIT, q.total, q.disc, refs.join(" "), lines.join("\n"), MODES[mode],
      c.transp, c.prenom, c.nom, "'" + c.tel, c.email, c.rue, "'" + c.cp, c.ville, c.pays, c.note]);

    const owner = Session.getEffectiveUser().getEmail();
    const recap = "<ul>" + lines.map(l => "<li>" + esc_(l) + "</li>").join("") + "</ul>" +
      (q.disc ? "<p>Sous-total : " + eur_(q.sub) + "<br>Remise lot : −" + eur_(q.disc) + "</p>" : "") +
      "<p><b>Total à payer : " + eur_(q.total) + "</b>" + (mode === "envoi" ? " + frais d'envoi" : "") + "</p>";
    const who = esc_(c.prenom + " " + c.nom) + "<br>" + esc_(c.tel) + "<br>" + esc_(c.email) +
      (c.rue ? "<br>" + esc_(c.rue + ", " + c.cp + " " + c.ville + ", " + c.pays) : "");

    if (owner) {
      MailApp.sendEmail({
        to: owner, replyTo: c.email, name: "Catalogue air2frip",
        subject: "🛍️ Commande " + ref.n + " · " + c.prenom + " " + c.nom + " · " + eur_(q.total),
        htmlBody: "<h2>Nouvelle commande " + esc_(ref.n) + "</h2>" + recap +
          "<p><b>Réception :</b> " + esc_(MODES[mode]) + (c.transp ? " (" + esc_(c.transp) + ")" : "") + "</p>" +
          "<p><b>Client</b><br>" + who + "</p>" + (c.note ? "<p><b>Message :</b> " + esc_(c.note) + "</p>" : "") +
          "<p><b>Communication du virement :</b> " + ref.comm + "</p>" +
          "<p>Quand le virement arrive, passe la commande en « Payée » dans le Google Sheet.</p>"
      });
    }

    const payBlock = mode === "envoi"
      ? "<p>📦 Je te confirme très vite les frais d'envoi selon le poids, puis tu pourras payer le total par virement.</p>"
      : "<p><b>Paiement par virement</b> (sans frais) :<br>Montant : <b>" + eur_(q.total) + "</b><br>IBAN : <b>" + esc_(pay.iban || "") +
        "</b><br>Bénéficiaire : " + esc_(pay.nom || "") + "<br>Communication : <b>" + ref.comm + "</b></p>" +
        "<p>Le plus simple : <a href=\"" + link + "\">ouvre ta page de paiement</a> et scanne le QR code avec l'appli de ta banque.</p>";
    MailApp.sendEmail({
      to: c.email, replyTo: owner || undefined, name: "air2frip",
      subject: "Ta commande air2frip " + ref.n,
      htmlBody: "<p>Salut " + esc_(c.prenom) + " !</p><p>Merci pour ta commande 💜 Voici le récapitulatif :</p>" + recap +
        "<p><b>Réception :</b> " + esc_(MODES[mode]) + "</p>" + payBlock +
        "<p>Les pièces sont réservées pour toi pendant " + HOLD_HOURS + " h. Si l'une d'elles est partie entre-temps, je te rembourse.</p>" +
        "<p>À très vite,<br>Romain · air2frip</p>"
    });

    return json_({ ok: true, n: ref.n, comm: ref.comm, digits: ref.digits, sub: q.sub, disc: q.disc, total: q.total, link: link });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: "La commande n'a pas pu être enregistrée. Réessaie dans un instant." });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/* ---------- outils ---------- */

function quote_(items, lot) {
  const sub = Math.round(items.reduce((a, x) => a + (x.px || 0), 0) * 100) / 100;
  const disc = lot && lot.min > 1 && lot.pct > 0 && items.length >= lot.min ? Math.round(sub * lot.pct) / 100 : 0;
  return { sub: sub, disc: disc, total: Math.round((sub - disc) * 100) / 100 };
}

// Communication structurée belge : AAMMJJ + n° du jour (4 chiffres) + contrôle modulo 97.
function structured_(day, seq) {
  const base = day + String(seq).padStart(4, "0");
  const chk = Number(base) % 97 || 97;
  const d = base + String(chk).padStart(2, "0");
  return { digits: d, comm: "+++" + d.slice(0, 3) + "/" + d.slice(3, 7) + "/" + d.slice(7) + "+++" };
}

function nextRef_() {
  const props = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(new Date(), TZ, "yyMMdd");
  const seq = Number(props.getProperty("seq_" + day) || 0) + 1;
  props.setProperty("seq_" + day, String(seq));
  const s = structured_(day, seq);
  return { n: "A2F-" + day + "-" + String(seq).padStart(2, "0"), comm: s.comm, digits: s.digits };
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) sh = ss.insertSheet(SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEAD);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEAD.length).setFontWeight("bold");
    sh.getRange(2, 4, 1000, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList([ST_WAIT, ST_PAID, ST_DONE, ST_CANCEL], true).build());
  }
  return sh;
}

function reserved_(sh) {
  const out = new Set();
  const n = sh.getLastRow() - 1;
  if (n < 1) return out;
  const now = Date.now();
  sh.getRange(2, 1, n, 7).getValues().forEach(r => {
    const st = r[3], age = (now - new Date(r[0]).getTime()) / 36e5;
    if (st === ST_PAID || st === ST_DONE || (st === ST_WAIT && age < HOLD_HOURS)) {
      String(r[6]).split(/[\s,]+/).filter(Boolean).forEach(x => out.add(x));
    }
  });
  return out;
}

function clean_(c) {
  const o = {};
  ["prenom", "nom", "tel", "email", "rue", "cp", "ville", "pays", "note", "transp"].forEach(k => {
    o[k] = String(c[k] == null ? "" : c[k]).trim().slice(0, 300);
  });
  if (!o.pays) o.pays = "Belgique";
  return o;
}

function eur_(v) { return (Math.round(v * 100) / 100).toFixed(2).replace(".", ",").replace(",00", "") + " €"; }
function esc_(s) { return String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch])); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// À lancer une fois depuis l'éditeur (bouton ▶ Exécuter) pour donner les autorisations et créer l'onglet.
function installer() {
  sheet_();
  UrlFetchApp.fetch(DATA_URL);
  Logger.log("OK : onglet « " + SHEET + " » prêt, e-mails envoyés depuis " + Session.getEffectiveUser().getEmail());
}
