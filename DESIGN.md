# Règles de design du catalogue air2frip

À relire avant toute modification visuelle du catalogue (index.html). Elles viennent de trois skills de design : Emil Kowalski (animations), Impeccable (qualité) et Taste (catalogue de produits).

## Identité (on garde)
- Fond crème `#f5f4f0`, texte `#0e0d14`, accent violet `#5b50e8`.
- Titres en Fredoka, texte courant en Inter.
- Les photos des pièces mènent la page. Pas d'effets décoratifs à la place des photos.
- Le « portant » des dernières arrivées est le moment signature de la page. On le garde.

## Mouvement
- Courbes : `--ease-out: cubic-bezier(.23,1,.32,1)` pour ce qui entre ou réagit, `--ease-io` pour ce qui se déplace, `--ease-drawer` pour le panneau des filtres. Jamais `ease-in`.
- Durées : 120 à 160 ms pour un clic, 150 à 250 ms pour les petits éléments, 300 à 400 ms pour les fenêtres et les panneaux.
- Tout ce qui se touche s'enfonce au clic : `scale(.97)`, `.92` pour le cœur.
- Les effets de survol vont dans `@media (hover:hover) and (pointer:fine)`, pour qu'ils ne restent pas collés au doigt sur téléphone.
- Au survol, une fiche monte de 2 px et sa photo zoome de 1,03 au maximum.
- Les fiches ne s'animent pas en apparaissant au défilement : elles sont visibles tout de suite.
- Le haut de page s'anime une seule fois au chargement, en 0,6 s au total.
- Aucune animation en boucle sur un badge.
- On n'anime que `transform` et `opacity`, jamais `transition: all`.
- Avec « réduire les animations » activé, tout est immobile et rien ne reste caché.

## Finitions
- Pas de texte en dégradé : l'accent passe par la couleur.
- Des icônes dessinées en SVG dans l'interface. Les émojis restent dans les textes.
- Sélection de texte, curseur de saisie et contour de focus aux couleurs de la marque.
- Chiffres à chasse fixe sur les prix et les compteurs.
- Titres équilibrés (`text-wrap: balance`).
- Plus d'espace au-dessus d'un titre qu'en dessous.
- Zones cliquables d'au moins 44 px sur téléphone.
- Une fiche a un contour en ombre douce plutôt qu'une bordure pleine.

## Vérifier avant de mettre en ligne
1. Faire des captures à 390 px (téléphone) et 1440 px (ordinateur).
2. La page doit s'ouvrir en haut (`scrollY = 0`).
3. Tester un clic sur une catégorie, l'ouverture d'une pièce, les filtres et la recherche.
4. Aucune erreur dans la console.
