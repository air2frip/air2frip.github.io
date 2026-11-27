#!/usr/bin/env python3
"""Synchronise les pièces de Romain (catalogue air2frip, data.json) vers le site commun Viz2frip (products.js).

Utilisation :
  python3 viz2frip_sync.py <dépôt air2frip.github.io> <dépôt viz2frip> [--vendus id1,id2] [--dry-run] [--force]

Règles (décisions de Romain, 27/11/2026) :
- Une pièce « dispo » du catalogue (A123) = une pièce « RA123 » (sku R123, seller romain) sur Viz2frip, au même prix (px).
- Nouvelle pièce : fiche créée + photo de couverture img/RA123.jpg + toutes les photos empilées dans img/packs/RA123.webp.
- Pièce vendue au catalogue (st « vendu ») ou retirée du catalogue → "available": false sur Viz2frip (jamais supprimée).
- Une pièce "available": false ne repasse JAMAIS disponible.
- Prix (px) ou lien de paiement (pay) changés au catalogue → mis à jour sur Viz2frip.
- Photos complétées au catalogue (plus de photos dans « pa » que sur Viz2frip) → couverture et photos empilées refaites.
- Pièces de Malo (seller "malo") : JAMAIS modifiées, sauf --vendus (pièce payée en ligne sur Viz2frip) → "available": false.
- Garde-fous : data.json illisible ou trop court, ou plus de 15 pièces à retirer d'un coup → ARRÊT, rien n'est écrit (sauf --force).
Sortie : un résumé JSON sur la dernière ligne ({"ajoutees": [...], "vendues": [...], ...}).
"""
import json, os, sys, shutil, datetime, zoneinfo
from PIL import Image

CAT = {"Doudounes": "Doudoune", "Pulls": "Pull", "Sweats": "Sweat", "Gilets & cardigans": "Gilet", "Vestes": "Veste",
       "Chemises": "Chemise", "Casquettes": "Casquette", "Autres": "Autre"}
HEADER = '/* Articles de Malo (Vinted malo0005, seller "malo") et de Romain (air2frip, seller "romain"). « cover » : photo de couverture retouchée (vide = 1re photo). */'
MAX_RETRAITS = 15


def load_products(path):
    s = open(path, encoding="utf-8").read()
    a, b = s.index("["), s.rindex("]")
    return s[:s.index("window.PRODUCTS")].rstrip("\n"), json.loads(s[a:b + 1])


def dump_products(path, header, items):
    with open(path, "w", encoding="utf-8") as f:
        f.write((header or HEADER) + "\nwindow.PRODUCTS = " + json.dumps(items, ensure_ascii=False) + ";\n")


def visible(x, now):
    pub = x.get("pub")
    if not pub:
        return True
    try:
        t = datetime.datetime.strptime(pub, "%Y-%m-%d %H:%M")
    except ValueError:
        t = datetime.datetime.strptime(pub[:10], "%Y-%m-%d")
    return now >= t.replace(tzinfo=zoneinfo.ZoneInfo("Europe/Brussels"))


def make_images(a2f, viz, x, rid, cover=True):
    photos = [p for p in (x.get("pa") or x.get("p") or []) if os.path.exists(os.path.join(a2f, p))]
    if not photos:
        raise RuntimeError(f"{x['r']} : aucune photo trouvée dans le catalogue")
    # Couverture : 1re photo, JPEG
    if cover or not os.path.exists(os.path.join(viz, "img", rid + ".jpg")):
        cov = Image.open(os.path.join(a2f, photos[0])).convert("RGB")
        cov.save(os.path.join(viz, "img", rid + ".jpg"), "JPEG", quality=86, optimize=True)
    # Pack : toutes les photos empilées, 600 px de large
    ims, heights = [], []
    for p in photos:
        im = Image.open(os.path.join(a2f, p)).convert("RGB")
        h = round(im.height * 600 / im.width)
        ims.append(im.resize((600, h), Image.LANCZOS)); heights.append(h)
    pack = Image.new("RGB", (600, sum(heights)), "white")
    y = 0
    for im in ims:
        pack.paste(im, (0, y)); y += im.height
    os.makedirs(os.path.join(viz, "img", "packs"), exist_ok=True)
    pack.save(os.path.join(viz, "img", "packs", rid + ".webp"), "WEBP", quality=80, method=6)
    return heights


def fiche(x, rid, heights):
    title = x["n"] + (" · " + x["c"] if x.get("c") else "")
    return {"id": rid, "sku": "R" + x["r"][1:], "seller": "romain", "title": title, "brand": x.get("b", ""),
            "size": x.get("s", ""), "gender": x.get("g") or "Mixte", "condition": x.get("e", ""),
            "price": float(x["px"]), "category": CAT.get(x.get("k"), "Autre"), "cover": f"img/{rid}.jpg",
            "photos": [], "retouched": False,
            "vinted": f"https://www.vinted.be/items/{x['id']}" if x.get("id") else "",
            "desc": x.get("desc") or x.get("d") or "", "available": True,
            "pack": f"img/packs/{rid}.webp", "packX": 0, "packW": 600, "packH": heights,
            "stripe": x.get("pay") or ""}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    dry, force = "--dry-run" in flags, "--force" in flags
    vendus = []
    if "--vendus" in sys.argv:
        vendus = [v.strip() for v in sys.argv[sys.argv.index("--vendus") + 1].split(",") if v.strip()]
        args = [a for a in args if a != sys.argv[sys.argv.index("--vendus") + 1]]
    a2f, viz = args[0], args[1]
    now = datetime.datetime.now(zoneinfo.ZoneInfo("Europe/Brussels"))

    data = json.load(open(os.path.join(a2f, "data.json"), encoding="utf-8"))
    items = data.get("items") or []
    if len(items) < 50:
        print(json.dumps({"arret": f"data.json ne contient que {len(items)} pièces : rien n'est modifié"}, ensure_ascii=False)); sys.exit(2)
    A = {x["r"]: x for x in items if x.get("r")}
    header, P = load_products(os.path.join(viz, "products.js"))
    byid = {p["id"]: p for p in P}
    rep = {"ajoutees": [], "vendues": [], "prix": [], "liens": [], "photos": [], "vendues_site": [], "anomalies": [], "arret": None}

    # 1) Ventes payées sur Viz2frip (pièces de Romain ou de Malo)
    for v in vendus:
        p = byid.get(v) or next((q for q in P if q.get("sku") == v), None)
        if not p:
            rep["anomalies"].append(f"vente site : pièce {v} introuvable"); continue
        if p.get("available", True):
            p["available"] = False; rep["vendues_site"].append(f"{p['id']} ({p['sku']}, {p['seller']})")

    # 2) Pièces de Romain déjà sur Viz2frip : vendues / prix / lien
    retraits = []
    for p in P:
        if p.get("seller") != "romain":
            continue
        x = A.get("A" + p["sku"][1:])
        if not p.get("available", True):
            if x and x.get("st") == "dispo":
                rep["anomalies"].append(f"{p['id']} indisponible sur Viz2frip mais dispo au catalogue (laissée indisponible)")
            continue
        if not x or x.get("st") != "dispo":
            retraits.append(p); continue
        if x.get("px") is not None and abs(float(x["px"]) - float(p["price"])) > 0.001:
            rep["prix"].append(f"{p['id']} {p['price']} → {float(x['px'])}"); p["price"] = float(x["px"])
        if (x.get("pay") or "") and x.get("pay") != p.get("stripe"):
            rep["liens"].append(p["id"]); p["stripe"] = x["pay"]
        # Photos complétées au catalogue après coup (champ « pa » plus long) → pack refait
        nb = len([q for q in (x.get("pa") or []) if os.path.exists(os.path.join(a2f, q))])
        if nb > len(p.get("packH") or []):
            try:
                heights = [0] * nb if dry else make_images(a2f, viz, x, p["id"], cover=False)
                p.update({"pack": f"img/packs/{p['id']}.webp", "packX": 0, "packW": 600, "packH": heights})
                rep["photos"].append(f"{p['id']} {nb} photos")
            except Exception as e:
                rep["anomalies"].append(str(e))
    if len(retraits) > MAX_RETRAITS and not force:
        rep["arret"] = f"{len(retraits)} pièces à retirer d'un coup (> {MAX_RETRAITS}) : vérifie data.json ; rien n'est modifié"
        print(json.dumps(rep, ensure_ascii=False)); sys.exit(2)
    for p in retraits:
        p["available"] = False
        x = A.get("A" + p["sku"][1:])
        rep["vendues"].append(f"{p['id']} ({'vendue ' + (x.get('sv') or '') if x else 'retirée du catalogue'})".replace(" )", ")"))

    # 3) Nouvelles pièces du catalogue
    have = {p["sku"] for p in P if p.get("seller") == "romain"}
    nouvelles = [x for x in items if x.get("st") == "dispo" and x.get("r") and ("R" + x["r"][1:]) not in have and visible(x, now)]
    nouvelles.sort(key=lambda x: int(x["r"][1:]))
    neufs = []
    for x in nouvelles:
        rid = "R" + x["r"]
        if x.get("px") in (None, 0):
            rep["anomalies"].append(f"{x['r']} sans prix : pas ajoutée"); continue
        try:
            heights = [0] if dry else make_images(a2f, viz, x, rid)
        except Exception as e:
            rep["anomalies"].append(str(e)); continue
        neufs.append(fiche(x, rid, heights)); rep["ajoutees"].append(f"{rid} {x['n']} · {x.get('px')} €")
    # Les plus récentes en tête du site (la plus grande référence d'abord)
    P = list(reversed(neufs)) + P

    changed = any(rep[k] for k in ("ajoutees", "vendues", "prix", "liens", "photos", "vendues_site"))
    if changed and not dry:
        dump_products(os.path.join(viz, "products.js"), header, P)
    rep["ecrit"] = bool(changed and not dry)
    rep["romain_dispo"] = sum(1 for p in P if p.get("seller") == "romain" and p.get("available", True))
    print(json.dumps(rep, ensure_ascii=False))


if __name__ == "__main__":
    main()
