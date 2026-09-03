# Calibration du barème — 3 septembre 2026

## Ce qui a été mesuré

Les poids et les seuils du moteur de décision avaient été posés à la main.
Tant qu'ils ne sont pas confrontés à des résultats réels, ce sont des opinions
présentées comme des chiffres. Ce document consigne la première confrontation.

```bash
npm run backtest                       # univers par défaut, 70 sociétés
npm run backtest -- --tickers=AAPL,MSFT --out=resultat.json
```

## Méthode

Pour chaque publication passée, on reconstruit les faits **tels qu'ils étaient
connus avant la séance de réaction**, on calcule le score qu'aurait rendu le
moteur, puis on mesure ce que le titre a réellement fait.

Le point de coupure suit l'horaire de publication, connu grâce aux dépôts 8-K
horodatés de la SEC : une société qui publie après clôture laisse connaître la
séance du jour, une société qui publie avant ouverture ne laisse que la veille.
Un test automatisé vérifie cette absence de fuite d'information — multiplier
par dix toutes les séances postérieures à la réaction ne doit changer aucun
score (`test/backtest.test.js`).

**Périmètre.** Deux facteurs seulement sont reconstituables : les réactions
passées (poids 15 à l'époque) et la configuration technique (poids 12), soit
27 des 100 points de pondération. Le mouvement implicite, les révisions
d'estimations, le consensus, l'actualité, les positions vendeuses et
l'actionnariat n'ont pas d'historique gratuit — on ne peut pas savoir ce que
le marché des options pricait en 2023. **Aucune conclusion de ce document ne
vaut pour ces facteurs-là.**

## Résultat

| Mesure | Valeur |
| --- | --- |
| Publications exploitables | 1 223 |
| Sociétés | 70 |
| Profondeur | 5 ans |
| Réaction moyenne | +0,005 % |
| Réaction médiane | −0,071 % |
| Écart-type des réactions | 6,70 points |
| Taux de hausse | 49,2 % |
| Corrélation de Pearson (score / réaction) | −0,036 |
| Corrélation de Spearman | −0,066 |
| Écart tranche haute − tranche basse | −1,18 point (erreur standard 0,60 ; t = −1,98) |

Par tranche de score, de la plus basse à la plus haute :

| Tranche | n | Score | Réaction moyenne | Taux de hausse |
| --- | --- | --- | --- | --- |
| 1 | 244 | −71 … −22 | +0,57 % | 55 % |
| 2 | 244 | −22 … 1 | +0,18 % | 49 % |
| 3 | 244 | 1 … 17 | −0,12 % | 48 % |
| 4 | 244 | 17 … 33 | +0,01 % | 50 % |
| 5 | 247 | 34 … 76 | −0,61 % | 44 % |

## Lecture

**Les facteurs directionnels testés ne prédisent pas le sens de la réaction.**
Pire, la relation est légèrement inverse et à peu près monotone : les scores
les plus élevés sont associés aux réactions les moins bonnes. Le t de −1,98
frôle le seuil de significativité, du mauvais côté.

Ce n'est pas surprenant. Le facteur « tendance et technique » récompense un
titre au-dessus de ses moyennes mobiles et en hausse sur trois mois. Or un
titre qui arrive en fanfare sur sa publication arrive avec des attentes déjà
hautes — le mécanisme que le facteur `momentum` pénalisait déjà partiellement
par sa pénalité de parcours, mais pas assez.

La réaction moyenne est nulle et le taux de hausse de 49,2 %. Une position
ouverte trois séances avant et tenue jusqu'à la réaction rapporte +0,42 % en
moyenne, soit à peu près la dérive du marché sur quatre séances : aucun gain
attribuable au pari sur l'événement.

## Ce qui en a été fait

Le poids des deux facteurs réfutés a été **réduit, pas inversé** :

| Facteur | Avant | Après |
| --- | --- | --- |
| Mouvement implicite vs historique | 18 | **26** |
| Réactions passées | 15 | **8** |
| Tendance et technique | 12 | **7** |
| Tonalité de l'actualité | 10 | **8** |
| Liquidité et taille | 4 | **10** |

Inverser aurait été tentant : la relation observée est négative, parier à
l'envers aurait « amélioré » le backtest. Ce serait du surapprentissage sur un
échantillon unique, couvrant un seul régime de marché. Un résultat en
échantillon ne justifie pas de parier dans l'autre sens ; il justifie de moins
s'y fier.

Le poids libéré va aux facteurs qui **mesurent** — le mouvement implicite
compare ce que le marché des options price au comportement historique du
titre, la liquidité chiffre un risque de dérapage — plutôt qu'à ceux qui
prétendent deviner une direction.

## Limites

- **Échantillon unique et in-sample.** Aucune validation hors échantillon.
- **Cinq ans, un seul régime.** La période couverte est dominée par un marché
  haussier ; rien ne dit que la relation tient ailleurs.
- **Grandes capitalisations liquides.** L'univers n'est pas représentatif du
  marché coté dans son ensemble.
- **73 % du barème n'est pas testé**, faute d'historique. Le facteur le plus
  lourd aujourd'hui — le mouvement implicite — n'a pas été validé ; il est
  simplement mieux fondé, parce qu'il mesure un prix observable au lieu
  d'extrapoler une tendance.

## Prochaine étape

Le seul moyen d'obtenir un historique de volatilité implicite sans l'acheter
est de l'archiver au fil de l'eau. Un cache persistant qui conserve chaque
analyse constituerait, mois après mois, le jeu de données point-in-time
nécessaire pour tester le facteur qui pèse le plus lourd.
