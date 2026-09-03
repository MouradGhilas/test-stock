# Faut-il entrer avant les résultats ?

Site d'analyse pré-résultats. On saisit un ticker, le serveur interroge une
dizaine de sources publiques, reconstruit le dossier du titre et rend un
verdict argumenté, facteur par facteur, sur l'opportunité d'ouvrir une
position **avant** la publication trimestrielle.

> **Ce n'est pas un conseil en investissement.** L'outil agrège des données
> publiques et applique un barème explicite ; il ne prédit pas le résultat
> d'une publication. Acheter avant des résultats revient à parier sur un
> événement dont l'issue n'est pas connaissable à l'avance.

## Démarrer

```bash
npm start           # http://localhost:3000
npm test            # 104 tests, sans accès réseau
npm run backtest    # rejoue le barème sur les publications passées
```

Aucune dépendance à installer : le projet tourne sur Node 20+ et n'utilise que
la bibliothèque standard. `PORT` et `HOST` sont configurables par variable
d'environnement.

## Deux façons d'entrer

Le site s'ouvre sur **le calendrier des publications à venir** : les sociétés
de plus de 2 milliards de dollars qui publient dans les cinq prochains jours
ouvrés, groupées par jour, avec l'horaire annoncé et le consensus attendu. Un
clic lance l'analyse. C'est l'usage réel — la question de départ est rarement
« que vaut telle action », plutôt « qui publie cette semaine, et lequel de ces
dossiers mérite qu'on s'y arrête ».

La recherche par ticker reste disponible pour un titre précis.

## Ce que le site collecte

| Source | Données | Rôle dans l'analyse |
| --- | --- | --- |
| API Nasdaq | cotation, 5 ans d'historique, surprises passées, estimations et révisions, consensus, short interest, actionnariat, calendrier | socle de l'analyse |
| SEC EDGAR | dépôts 8-K « item 2.02 », horodatés à la seconde | dates et **horaires** de publication, sur cinq ans |
| CBOE (cotations différées) | chaîne d'options complète avec volatilités implicites | mouvement implicite, détection de la fenêtre de publication |
| Google News / Bing News / Seeking Alpha | titres de presse récents | tonalité de l'actualité |

Les trois agrégateurs d'actualités sont interrogés en cascade : aucun n'est
fiable en continu, le premier qui rapporte assez de titres l'emporte.

Chaque appel est journalisé (URL, statut, latence, taille, cache) et affiché
dans le panneau « Sources scrapées » : la collecte est auditable.

## Comment le verdict est construit

Dix facteurs, chacun noté de -100 à +100, avec un poids et une confiance :

| Facteur | Poids |
| --- | --- |
| Mouvement implicite vs historique | 26 |
| Historique des surprises | 12 |
| Révisions d'estimations | 12 |
| Liquidité et taille | 10 |
| Réactions passées aux résultats | 8 |
| Tonalité de l'actualité | 8 |
| Tendance et technique | 7 |
| Consensus analystes | 7 |
| Positions vendeuses | 6 |
| Actionnariat institutionnel | 4 |

Ces poids ne sont pas arbitraires : ils ont été révisés après la calibration
décrite plus bas.

Le score global est la moyenne pondérée par `poids × confiance`, ramenée à la
couverture réellement obtenue. **Une source absente réduit la confiance du
verdict, elle ne pénalise pas le titre** — c'est la différence entre « mauvais
dossier » et « dossier incomplet ».

Par-dessus le score, des garde-fous peuvent dégrader le verdict quel que soit
le total : absence de date de publication, échéance trop lointaine, mouvement
implicite extrême, titre illiquide, couverture de données insuffisante.

Verdicts possibles : **Entrer**, **Entrer avec prudence**, **Rester à
l'écart**, **Éviter**, **Données insuffisantes**.

## « Est-ce déjà dans le prix ? »

Question distincte de celle du verdict, et affichée séparément. Un excellent
dossier entièrement anticipé reste un mauvais point d'entrée, et cette
information ne se lit nulle part dans un score de qualité.

Sept signaux, notés de 0 à 100 :

| Signal | Ce qu'il mesure | Poids |
| --- | --- | --- |
| Parcours avant publication | l'avance du titre en écarts-types de **ses propres** parcours pré-résultats passés | 25 |
| Afflux de volume | volume des cinq dernières séances rapporté au régime habituel | 20 |
| Tension de la volatilité | volatilité implicite à 30 jours contre volatilité réalisée sur 30 séances | 20 |
| Montée du mouvement implicite | pente du mouvement implicite depuis les observations archivées | 15 |
| Marge vers l'objectif analystes | ce qu'il reste de potentiel avant l'objectif moyen à un an | 15 |
| Attentes déjà relevées | révisions d'estimations des quatre dernières semaines | 10 |
| Positionnement optionnel | rapport put/call des positions ouvertes sur l'échéance | 10 |

Le parcours se juge par rapport aux habitudes du titre, pas à un seuil
arbitraire : certaines valeurs dérivent systématiquement avant publication, ce
n'est pas ça qu'on cherche.

**Ce que ça ne fait pas.** Rien ici ne devine l'intention d'un teneur de marché
ni ne détecte une manipulation. Ces acteurs voient le carnet d'ordres en temps
réel ; le site travaille avec des options différées et des bougies
quotidiennes. Prétendre les devancer serait mentir. Ce qui est mesurable, ce
sont les **traces publiques** d'un positionnement en cours de constitution —
elles ne disent pas qui se positionne, mais elles disent si on est encore tôt.

### Le journal d'observations

Aucune source gratuite ne donne l'historique de volatilité implicite : on ne
peut pas savoir ce que le marché des options pricait il y a trois semaines,
sauf à l'avoir noté soi-même. Chaque analyse archive donc son observation dans
`data/snapshots/<TICKER>.jsonl` (une ligne JSON par consultation, hors dépôt
Git).

Les premières analyses d'un titre ne diront rien ; les suivantes montreront la
pente — *« le mouvement implicite est passé de 6 % à 11 % en douze jours : le
marché renchérit l'événement, il ne le découvre pas maintenant »*. C'est aussi
le jeu de données point-in-time qui manquerait pour backtester un jour le
facteur le plus lourd du barème.

## Deux points de méthode qui font la différence

### Isoler le mouvement propre aux résultats

Le straddle « à la monnaie » mesure le mouvement attendu jusqu'à l'échéance —
événement *et* volatilité ordinaire mélangés. Si la première échéance après la
publication tombe trois semaines plus tard, on surestime largement l'impact du
résultat : sur AAPL, le straddle brut donnait 10,0 % là où le mouvement lié aux
résultats est de 4,9 %.

On isole donc l'événement par différence de variance entre une échéance qui
précède la publication (volatilité ordinaire seule) et une échéance qui la
suit :

```
V_événement = T_post × (σ_post² − σ_pre²)
mouvement   = √V_événement
```

À défaut de deux échéances exploitables, on retombe sur le straddle brut, et
la méthode employée est indiquée dans l'interface.

### Identifier la bonne séance de réaction

Une société qui publie après clôture réagit le lendemain, une société qui
publie avant ouverture réagit le jour même. Se tromper de séance inverse le
signe de la réaction et corrompt tout le facteur.

Les fournisseurs de marché donnent la *date* de publication, pas l'heure. Mais
une société américaine annonce ses résultats par un formulaire **8-K portant
l'item 2.02**, et la SEC horodate chaque dépôt à la seconde. L'horaire est donc
un fait établi, pas une déduction — et EDGAR remonte à 1994 là où les
fournisseurs exposent quatre trimestres.

Concrètement, pour AAPL : **20 réactions mesurées sur cinq ans au lieu de 4**,
toutes avec horaire officiel. L'amplitude médiane passe de 1,85 % à 2,87 %, et
le ratio implicite/historique de 2,5× à 1,72× — la conclusion du facteur le
plus lourd change.

Quand l'horaire manque malgré tout, on ne devine pas séance par séance : on
identifie le **schéma de publication de la société**. Un trimestre où une
séance bouge deux fois plus que l'autre et dépasse 1,5 % désigne sans
ambiguïté le moment de publication ; ces trimestres nets votent, la majorité
l'emporte, et le schéma retenu s'applique uniformément. Une règle naïve —
« retenir la séance qui a le plus bougé » — se trompait sur deux des quatre
derniers trimestres d'AAPL.

### En prime : recouper la date par le marché des options

La volatilité implicite d'une échéance qui englobe des résultats est
mécaniquement plus élevée que celle de l'échéance précédente. Le plus gros
saut de volatilité de la structure par terme encadre donc la publication.
Quand la date retenue tombe hors de cette fenêtre, l'interface le signale et
le verdict est plafonné : c'est le signe d'une date extrapolée fausse.

## Ce que le barème vaut, mesuré

`npm run backtest` rejoue les publications passées : pour chacune, il
reconstruit les faits **tels qu'ils étaient connus avant la séance de
réaction**, calcule le score qu'aurait rendu le moteur, et le confronte à ce
que le titre a réellement fait. Un test automatisé vérifie l'absence de fuite
d'information — multiplier par dix toutes les séances postérieures à la
réaction ne doit changer aucun score.

Résultat sur **1 223 publications, 70 sociétés, 5 ans** :

| Mesure | Valeur |
| --- | --- |
| Réaction moyenne | +0,005 % |
| Taux de hausse | 49,2 % |
| Corrélation de Spearman (score / réaction) | −0,066 |
| Écart tranche haute − tranche basse | −1,18 point (t = −1,98) |

**Les facteurs directionnels testés ne prédisent pas le sens de la réaction**,
et la relation est même légèrement inverse. Leur poids a été réduit — pas
inversé : parier à l'envers sur la foi d'un échantillon unique couvrant un
seul régime de marché serait du surapprentissage.

Seuls deux facteurs sur dix sont testables (27 des 100 points de pondération) :
les autres n'ont pas d'historique gratuit — on ne peut pas savoir ce que le
marché des options pricait en 2023. Le détail, la méthode et les limites sont
dans [`docs/backtest.md`](docs/backtest.md).

## Limites assumées

- **Le calendrier n'est pas toujours confirmé.** Quand le fournisseur ne donne
  pas de date, elle est extrapolée (ancrage sur le même trimestre fiscal un an
  plus tôt). L'interface distingue toujours date confirmée, annoncée et
  extrapolée.
- **Le calendrier ne couvre que les jours ouvrés à venir**, et une société
  peut décaler sa date après l'avoir annoncée.
- **Cinq ans d'historique**, soit une vingtaine de publications par société.
  C'est assez pour que les mesures d'amplitude tiennent, pas pour trancher une
  question de direction. L'interface signale les titres où l'échantillon
  descend sous huit observations.
- **Actions américaines uniquement** (périmètre des sources).
- **Données différées**, jamais temps réel.
- **La tonalité repose sur un lexique**, pas sur un modèle de langue : chaque
  score est justifié par les termes relevés, précisément pour qu'on puisse le
  contester.
- Aucun facteur ne prédit le contenu d'une publication, et le backtest le
  confirme pour ceux qui pouvaient être testés. Le seul élément réellement
  actionnable est le **dimensionnement** : un ordre stop ne protège pas d'un
  décalage à l'ouverture, il s'exécute après.

## API

```
GET /api/calendar?days=5&minCap=2e9   → publications à venir, groupées par jour
GET /api/analyze?ticker=AAPL          → rapport complet (JSON)
GET /api/health                       → état du service et du cache
```

Le rapport contient l'identité du titre, les données de marché, l'événement,
les options, l'historique des réactions, les indicateurs, les actualités
notées, la série de cours, la décision détaillée et le journal des sources.

## Structure

```
server/
  index.js              serveur HTTP, routes, fichiers statiques
  analyze.js            orchestrateur : collecte → faits → verdict
  config.js             poids, seuils, TTL de cache, garde-fous
  core/                 cache TTL, client HTTP instrumenté, parsing, statistiques
  backtest.js           rejeu des publications passées, sans fuite d'information
  core/store.js         journal d'observations, pour la pente du mouvement implicite
  sources/              nasdaq.js, edgar.js, cboe.js, news.js
  analysis/             indicateurs, réactions, tonalité, anticipation, verdict
public/                 interface (HTML/CSS/JS, sans framework)
scripts/backtest.js     lanceur du backtest sur un univers de tickers
docs/backtest.md        résultat de la calibration et sa méthode
test/                   104 tests unitaires, sans accès réseau
```

Le client HTTP apporte timeout, réessais avec backoff, plafond de requêtes
simultanées, cache TTL avec déduplication des requêtes en vol, et un
disjoncteur qui écarte quelques minutes une source en panne plutôt que de
consommer tout le budget de temps en réessais.
