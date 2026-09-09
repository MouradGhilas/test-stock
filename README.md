# Suivre ses positions copiées depuis X

Outil de suivi pour qui réplique à la main des signaux de trading publiés sur
X. On colle le post, l'outil en extrait les niveaux, et suit ensuite toutes les
lignes ensemble : ce qu'elles valent, ce qu'elles risquent, et ce qui réclame
une décision.

> **Ce n'est pas un conseil en investissement, et pas non plus un courtier.**
> L'outil ne passe aucun ordre et ne parle à aucun compte : il reflète ce que
> vous y saisissez. Copier les positions d'un inconnu revient à lui confier
> votre capital sans connaître ni sa taille de compte, ni ses sorties réelles,
> ni les signaux qu'il n'a pas publiés.

## Démarrer

```bash
npm start           # http://localhost:3000
npm test            # 90 tests, sans accès réseau
```

Aucune dépendance à installer : le projet tourne sur Node 20+ et n'utilise que
la bibliothèque standard. `PORT` et `HOST` sont configurables par variable
d'environnement, `TRADES_DIR` pour l'emplacement du portefeuille.

## Le problème

Un signal isolé se gère de tête. Dix signaux suivis en parallèle, non : plus
personne ne sait ce qu'il risque au total, quelles lignes ont dérivé loin du
post qui les a déclenchées, ni lesquelles ont déjà touché leur stop. C'est le
seul objet de cet outil.

## Coller le post plutôt que ressaisir

Les signaux n'ont aucun format commun. `server/portfolio/signal.js` lit les
formes courantes, dans les deux langues :

```
$NVDA long entry 178.50 SL 172 TP1 185 TP2 192
BUY $AAPL @ 232,10 — stop 227, objectif 245
LONG $MSFT 415-420 | Stop: 405 | Targets: 440, 455, 470
Short TSLA below 400 | sl -3% | tp +6%
```

Il en tire le ticker, le sens, l'entrée (fourchette ramenée à son milieu, bornes
conservées), le stop, les objectifs, la taille annoncée et le compte auteur —
repris du lien du post quand il y en a un. Les stops et objectifs donnés en
pourcentage sont convertis en prix selon le sens de la position.

Deux règles de conduite : **chaque champ porte son origine** (lu dans le signal,
déduit, absent) et **rien n'est corrigé en silence**. Un stop au-dessus de
l'entrée pour un achat est affiché tel quel, avec un avertissement ; un ticker
deviné faute de cashtag est signalé comme deviné. La saisie reste modifiable
avant validation, et un formulaire manuel existe pour les posts illisibles.

## Quand le post ne chiffre rien

C'est le cas le plus fréquent, et le plus mal servi par un formulaire :

> `$TE` : je suis bullish les gars sur celui-ci ! J'avais tracé un falling wedge
> mais je peux aussi le tracer en bull flag. […] Regardez le TP final, arrêtez de
> faire les rats sur le prix d'entrée

Aucun niveau n'y figure : ils sont **dans le graphique**. Le lecteur en tire ce
qu'il peut -- le ticker, le sens, le compte auteur -- et dit franchement que
l'entrée, le stop et les objectifs sont absents. Deux mécanismes prennent le
relais :

- **La capture s'attache à la position.** Un `Ctrl+V` n'importe où sur la page,
  un glisser-déposer ou le sélecteur de fichier envoient l'image ; elle
  s'affiche en vignette dans le formulaire, puis derrière une pastille `📎` sur
  la ligne. C'est la seule trace de ce qui a été promis, et celle qu'on relira
  pour savoir si la thèse tient encore.

  Un clic l'ouvre dans une visionneuse qui **zoome et se déplace** : une capture
  TradingView fait deux fois la largeur d'un écran, ajustée elle devient
  illisible. Molette pour zoomer sous le curseur, glisser pour déplacer,
  double-clic ou touche `1` pour la taille réelle, `0` pour réajuster, et un
  bouton qui ouvre l'image seule dans un onglet.
- **L'entrée peut être reprise du marché.** « Arrêtez de faire les rats sur le
  prix d'entrée » veut dire : entrez maintenant. Le bouton *prix du marché*
  interroge la cotation du ticker saisi et remplit le champ.

- **Le stop vient de votre règle de sortie.** Réglez-la une fois en haut de page
  (« sortie à -5 % ») : dès qu'une entrée est connue, le stop est calculé et
  affiché, marqué comme venant de la règle et non du signal. Il reste modifiable,
  et un stop donné par le post n'est jamais remplacé. Pour les lignes déjà
  enregistrées sans stop, le bouton *Stop à -5 %* le pose sur toute une
  sélection. Une règle de conduite ne vaut que ce que vaut la discipline de s'y
  tenir, et sur un titre volatil elle se déclenchera souvent -- mais une ligne
  sans stop a une perte maximale inconnue, celle-ci ne l'a plus.

Les captures vivent dans `data/images/`, jamais ailleurs. Le type est déduit des
octets d'en-tête et non de ce qu'annonce le navigateur : un fichier déguisé en
image est refusé à l'envoi, et le serveur ne resservira jamais autre chose
qu'une image. Une capture envoyée puis abandonnée est balayée au démarrage
suivant, passé un jour.

## Combien de titres acheter

Deux questions distinctes, que l'écran ne confond pas :

**Combien risquer.** La taille qui met en jeu le pourcentage de capital choisi
si le stop est touché. C'est la seule qui protège le compte : 1 % de 10 000 $
avec un stop à 5 % de l'entrée, cela fait 400 titres à 5 $, pas un de plus.

**À partir de combien ça vaut la peine.** En dessous d'une certaine taille, les
frais d'aller-retour prennent une part absurde du gain visé — un gain de 12 $
amputé de 4 $ de frais n'est pas un trade, c'est un virement au courtier.
Renseignez vos frais par ordre (fixes et proportionnels) et le formulaire
affiche, pendant la saisie :

- le **prix mort** : celui qu'il faut dépasser pour gagner un centime, frais
  compris ;
- la **taille minimale** en dessous de laquelle les frais prennent plus du
  cinquième du gain visé ;
- le **résultat net** au premier objectif et au stop.

Aucune de ces tailles ne rend un trade gagnant : la taille ne change pas la
probabilité d'avoir raison, seulement la somme en jeu. Ce que le calcul dit,
c'est à partir de quand les frais cessent de manger le résultat.

## Le chiffre que l'écran met au centre

Pas le P&L du jour : **ce que coûterait la journée où tous les stops sautent**.
C'est la somme des pertes au stop de chaque ligne, ramenée au capital. Les
positions sans stop en sont exclues — non parce qu'elles ne risquent rien, mais
parce que leur perte n'a pas de borne calculable ; elles sont comptées à part,
sous leur propre alerte.

Le reste suit : exposition, latent, réalisé, multiples de R, distance au stop et
au prochain objectif, concentration par titre et par compte suivi. Les alertes
sont des seuils explicites (`server/config.js`, section `portfolio`), pas des
prédictions : stop franchi, objectif atteint, gain suffisant pour sécuriser le
stop, ligne trop lourde, entrée manquée, publication de résultats imminente sur
une ligne ouverte.

Le multiple de R se mesure contre le **stop d'origine**, conservé même quand le
stop courant est déplacé : sans cela, remonter ses stops suffirait à gonfler
tous les R du portefeuille.

## Agir sur plusieurs lignes à la fois

Sélection multiple (dont « celles en alerte »), puis une décision appliquée à
tout le lot : clôturer au dernier prix connu, remonter les stops à l'équilibre,
poser le stop de sortie sur les lignes qui n'en ont pas, poser un stop suiveur,
prendre au marché les signaux restés en veille, ou supprimer. Chaque ligne est acceptée ou refusée **individuellement**, avec sa
raison — solder huit lignes sur dix en disant lesquelles ont résisté vaut mieux
que tout annuler parce qu'une cotation manquait. Un stop suiveur ne recule
jamais : il ne se déplace que du côté qui réduit le risque.

Trois états pour une ligne : **en veille** (signal noté, position pas encore
prise), **ouverte**, **soldée**. Une veille se compare en continu au prix du
jour : si le titre a déjà parcouru la moitié du trajet, l'outil le dit et
recalcule le rapport gain/risque tel qu'il serait en entrant maintenant.

## Quel compte vous fait gagner de l'argent

La vraie question du copy trading, et celle où l'outil se retient de conclure.
Le bilan par compte affiche R moyen, taux de réussite et réalisé, mais le
verdict reste « échantillon trop court » sous dix trades soldés, et
« indécidable » tant que la moyenne n'est pas distinguable de zéro (test de
Student sur les R). Un compte à +0,4 R sur six trades très dispersés n'a rien
prouvé.

## Données

Une seule source externe : l'API publique de nasdaq.com, pour la cotation des
titres suivis et la date de leur prochaine publication de résultats — l'échéance
qu'un trade de swing ne devrait pas traverser sans le savoir. Cotations
différées, actions américaines uniquement.

Le client HTTP apporte timeout, réessais avec backoff, plafond de requêtes
simultanées, cache TTL avec déduplication des requêtes en vol, et un disjoncteur
qui écarte quelques minutes une source en panne. Une cotation manquante ne fait
jamais échouer l'écran : la ligne concernée s'affiche sans valorisation, et le
dit.

Vos positions vivent dans `data/trades.json`, un document réécrit d'un bloc à
chaque changement : fichier temporaire puis `rename` atomique, écritures
sérialisées pour que deux requêtes simultanées ne s'écrasent pas. Le répertoire
`data/` est ignoré par git — rien ne part ailleurs.

## API

```
GET    /api/trades                       → tableau de bord : positions valorisées,
                                           risque agrégé, alertes, bilan par compte
POST   /api/trades/parse                 → lecture d'un signal collé (sans rien enregistrer)
POST   /api/trades                       → création d'une position
PATCH  /api/trades/<id>                  → modification (stop, objectifs, clôture…)
DELETE /api/trades/<id>                  → suppression
POST   /api/trades/batch                 → action groupée : close, protect, breakeven, trail,
                                           take, delete
GET    /api/trades/earnings              → publications à venir sur les lignes ouvertes
GET    /api/trades/quote?ticker=TE       → cotation d'un titre pas encore suivi
GET    /api/trades/plan?entry=&stop=&…   → taille au risque, prix mort, seuil de rentabilité
POST   /api/images                       → envoi d'une capture (corps binaire, image/*)
GET    /api/images/<id>                  → la capture, servie avec son vrai type
PATCH  /api/settings                     → capital et risque par position
GET    /api/health                       → état du service et du cache
```

Toute mutation répond avec le tableau de bord recalculé : l'interface n'a jamais
à recoller elle-même l'état d'après, y compris après une action groupée
partiellement appliquée. Les routes qui écrivent exigent un `Content-Type`
JSON et refusent une origine étrangère — l'outil tourne sans authentification
sur une machine personnelle, et une page ouverte dans le même navigateur ne doit
pas pouvoir solder vos positions.

## Structure

```
server/
  index.js              serveur HTTP, fichiers statiques
  config.js             seuils de risque, TTL de cache
  core/                 cache TTL, client HTTP instrumenté, parsing, statistiques,
                        réponses JSON, limitation de débit
  sources/nasdaq.js     cotations et dates de publication
  portfolio/
    signal.js           lecture d'un post collé depuis X
    trade.js            modèle d'une position et sa validation
    positions.js        P&L, multiples de R, risque, alertes, bilan par compte
    images.js           captures d'écran : validation par octets, stockage, purge
    store.js            persistance atomique de data/trades.json
    service.js          assemblage du tableau de bord
    routes.js           API et actions groupées
public/                 interface (HTML/CSS/JS, sans framework)
test/                   90 tests unitaires, sans accès réseau
```

## Limites assumées

- **Aucune liaison avec un courtier.** Une position soldée dans l'outil ne l'est
  pas sur votre compte, et inversement.
- **La lecture d'un signal est une aide, pas une autorité.** Un post ambigu, un
  fil en plusieurs messages, des niveaux tracés uniquement sur un graphique :
  rien de tout cela n'est lu correctement. Ce que l'outil n'a pas trouvé, il le
  dit ; ce qu'il a deviné, il le marque comme deviné. **Aucune lecture
  automatique des captures** n'est faite : l'image est conservée telle quelle,
  les niveaux restent à saisir à la main.
- **Données différées**, jamais temps réel, et actions américaines seulement.
- **Un stop n'est pas une protection absolue** : il s'exécute après un décalage
  à l'ouverture, pas avant. Le seul levier réellement maîtrisé est la taille de
  la position, que l'outil calcule à partir de votre capital et du risque que
  vous acceptez par ligne.
- **Le bilan par compte ne devient lisible qu'après plusieurs dizaines de trades
  soldés.** Avant, il ne mesure que la chance — et l'outil refuse de trancher.
