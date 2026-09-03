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
npm test            # 54 tests, sans accès réseau
```

Aucune dépendance à installer : le projet tourne sur Node 20+ et n'utilise que
la bibliothèque standard. `PORT` et `HOST` sont configurables par variable
d'environnement.

## Ce que le site collecte

| Source | Données | Rôle dans l'analyse |
| --- | --- | --- |
| API Nasdaq | cotation, historique, surprises passées, estimations et révisions, consensus, short interest, actionnariat, calendrier | socle de l'analyse |
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
| Mouvement implicite vs historique | 18 |
| Réactions passées aux résultats | 15 |
| Historique des surprises | 12 |
| Révisions d'estimations | 12 |
| Tendance et technique | 12 |
| Tonalité de l'actualité | 10 |
| Consensus analystes | 7 |
| Positions vendeuses | 6 |
| Actionnariat institutionnel | 4 |
| Liquidité et taille | 4 |

Le score global est la moyenne pondérée par `poids × confiance`, ramenée à la
couverture réellement obtenue. **Une source absente réduit la confiance du
verdict, elle ne pénalise pas le titre** — c'est la différence entre « mauvais
dossier » et « dossier incomplet ».

Par-dessus le score, des garde-fous peuvent dégrader le verdict quel que soit
le total : absence de date de publication, échéance trop lointaine, mouvement
implicite extrême, titre illiquide, couverture de données insuffisante.

Verdicts possibles : **Entrer**, **Entrer avec prudence**, **Rester à
l'écart**, **Éviter**, **Données insuffisantes**.

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

Les sources donnent la *date* de publication, pas l'heure. Une société qui
publie après clôture réagit le lendemain, une société qui publie avant
ouverture réagit le jour même. Se tromper de séance inverse le signe de la
réaction et corrompt tout le facteur.

Une règle naïve — « retenir la séance qui a le plus bougé » — se trompe une
fois sur deux : sur AAPL, deux des quatre derniers trimestres ont vu la séance
de publication bouger davantage que la séance de réaction.

On identifie donc le **schéma de publication de la société** avant de mesurer
quoi que ce soit. Un trimestre où une séance bouge deux fois plus que l'autre
et dépasse 1,5 % désigne sans ambiguïté le moment de publication ; ces
trimestres nets votent, la majorité l'emporte, et le schéma retenu s'applique
uniformément — y compris aux trimestres trop calmes pour trancher seuls.

### En prime : recouper la date par le marché des options

La volatilité implicite d'une échéance qui englobe des résultats est
mécaniquement plus élevée que celle de l'échéance précédente. Le plus gros
saut de volatilité de la structure par terme encadre donc la publication.
Quand la date retenue tombe hors de cette fenêtre, l'interface le signale et
le verdict est plafonné : c'est le signe d'une date extrapolée fausse.

## Limites assumées

- **Le calendrier n'est pas toujours confirmé.** Quand le fournisseur ne donne
  pas de date, elle est extrapolée (ancrage sur le même trimestre fiscal un an
  plus tôt). L'interface distingue toujours date confirmée, annoncée et
  extrapolée.
- **Quatre trimestres d'historique**, pas davantage : la référence historique
  est statistiquement mince, et l'interface le dit quand elle l'est trop.
- **Actions américaines uniquement** (périmètre des sources).
- **Données différées**, jamais temps réel.
- **La tonalité repose sur un lexique**, pas sur un modèle de langue : chaque
  score est justifié par les termes relevés, précisément pour qu'on puisse le
  contester.
- Aucun facteur ne prédit le contenu d'une publication. Le seul élément
  réellement actionnable est le **dimensionnement** : un ordre stop ne protège
  pas d'un décalage à l'ouverture, il s'exécute après.

## API

```
GET /api/analyze?ticker=AAPL   → rapport complet (JSON)
GET /api/health                → état du service et du cache
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
  sources/              nasdaq.js, cboe.js, news.js
  analysis/             indicateurs, réactions aux résultats, tonalité, verdict
public/                 interface (HTML/CSS/JS, sans framework)
test/                   54 tests unitaires, sans accès réseau
```

Le client HTTP apporte timeout, réessais avec backoff, plafond de requêtes
simultanées, cache TTL avec déduplication des requêtes en vol, et un
disjoncteur qui écarte quelques minutes une source en panne plutôt que de
consommer tout le budget de temps en réessais.
