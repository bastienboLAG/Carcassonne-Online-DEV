# Architecture — Carcassonne Online REFIXED (multijoueur P2P)

> Document généré à partir d'un accès réel au dépôt GitHub
> (`bastienboLAG/Carcassonne-Online-REFIXED`, branche `main`).
> Nombre de lignes indiqué à titre de repère de taille/complexité.

## Vue d'ensemble

Jeu de plateau **Carcassonne** en HTML/CSS/JS vanilla (pas de framework),
multijoueur peer-to-peer. L'hôte fait autorité sur l'état du jeu (placement,
scoring, pioche) et synchronise les invités via `GameSync`.

Extensions optionnelles : Abbé, Grand Meeple, Auberges & Cathédrales,
Marchands & Bâtisseurs (+ Cochon), Dragon/Princesse/Portail/Fée, Tour, Rivière.

Point d'entrée : **`home.js`** (1463 lignes) — orchestre tous les modules,
gère le lobby, les event listeners globaux, et les callbacks passés aux managers.

---

## ⚠️ Piège récurrent — `eventBus` singleton et redémarrage de partie

`eventBus` (`modules/core/EventBus.js`) est instancié **une seule fois** au
chargement de `home.js` (`const eventBus = new EventBus();`) et **n'est
jamais recréé**, y compris lors d'un retour au lobby (`LobbyNavigator.returnToLobby()`)
suivi d'une nouvelle partie. À l'inverse, la plupart des modules de jeu
(`gameState`, `zoneMerger`, `undoManager`, `TowerUI`/`DragonUI`/`MeepleActionsUI`
via leur `_deps` interne, etc.) sont recréés ou réinjectés à chaque démarrage
de partie (`GameStarter.postStartSetup()`, appelé par `startHost()` et
`startGuest()`).

**Conséquence** : toute fonction qui fait `eventBus.on(...)` et qui est
elle-même appelée depuis `postStartSetup()` (donc à chaque partie, y compris
après un retour lobby) **accumule un nouvel écouteur à chaque itération** si
elle n'a pas de garde contre la ré-installation. Le nombre d'écouteurs actifs
pour cet événement grandit alors de +1 par partie, et chaque réception du
message réseau correspondant déclenche le traitement **autant de fois** qu'il
y a d'écouteurs — typiquement une mutation d'état dupliquée (ex: une entrée
poussée plusieurs fois dans un tableau).

**Bug concret déjà rencontré** (corrigé) : `MeepleActionsUI.initNetworkMeepleListeners(eventBus)`
enregistrait `network-tower-capture-executed`, `network-tower-floor-placed`,
`network-tower-lock-executed`, `network-princess-ejected` et
`network-portal-meeple-placed` sans garde. Après un retour lobby + nouvelle
partie, une capture Tour poussait deux fois la même entrée dans
`gameState.prisoners`, provoquant l'affichage d'un prisonnier en double —
**uniquement côté invité**, car ces événements réseau ne sont émis que
lorsque `!isHost` (l'hôte applique directement sans passer par l'event bus,
donc jamais concerné par ce genre de doublon).

**Pattern de correction adopté** (voir `MeepleActionsUI.js`) : un flag booléen
module-level (`_networkListenersInstalled`), vérifié en tête de fonction, qui
empêche toute ré-installation après la première partie :

```js
let _networkListenersInstalled = false;

export function initNetworkMeepleListeners(eventBus) {
    if (_networkListenersInstalled) return;
    _networkListenersInstalled = true;
    eventBus.on('mon-evenement', (data) => { /* lit _deps dynamiquement */ });
}
```

Ce pattern est sûr tant que les callbacks lisent leurs dépendances (`_deps`,
`gameState`, etc.) **dynamiquement au moment de l'appel** plutôt que de les
capturer dans la closure à l'installation — c'est déjà le cas partout dans ce
projet (`_deps` est une variable module-level réassignée à chaque partie via
`initMeepleActionsUI()`/`initTowerUI()`/`initDragonUI()`), donc une seule
installation de l'écouteur suffit pour toute la durée de vie de l'app.
`GameEventSetup.install()` utilise déjà ce même pattern (flag `_installed`)
pour les listeners DOM du jeu — s'en inspirer pour toute nouvelle extension.

**À vérifier avant d'ajouter une nouvelle extension** : toute fonction
`initXxxListeners(eventBus)` (ou équivalent) appelée depuis
`GameStarter.postStartSetup()` ou depuis un point réinvoqué à chaque partie
doit soit être protégée par un flag de ce type, soit être appelée une seule
fois au chargement du module (hors du cycle de vie d'une partie) si aucune
dépendance par-partie n'y est nécessaire.

---

## Racine

| Fichier | Lignes | Rôle |
|---|---|---|
| `index.html` | 494 | Structure DOM complète (lobby, plateau, modales, badge dragon, sélecteurs, section extension Tour, modale + voile gris d'échange automatique de prisonniers, modale de confirmation de rachat de prisonnier) |
| `style.css` | 1569 | Tous les styles |
| `home.js` | 1463 | Chef d'orchestre : état global, listeners `eventBus` (singleton — voir section "Piège récurrent" ci-dessus), init lobby, `startGame`/`startGameForInvite` |
| `version.js` | — | Constante `APP_VERSION` |

---

## `modules/` (racine du dossier modules)

| Fichier | Lignes | Rôle |
|---|---|---|
| `Board.js` | 121 | Modèle du plateau : `placedTiles`, `isFree`, `canPlaceTile` (check géométrique, ne connaît pas les règles spéciales type "dragon sans volcan") |
| `Deck.js` | 217 | Chargement des tuiles (`loadAllTiles`, fetch parallèle par groupe depuis `data/{Groupe}/{id}.json`, y compris `data/Tower/` si `tileGroups.tower`), mélange, pioche, `reshuffleDragonTile()` |
| `GameState.js` | 221 | État global : joueurs (dont `towerPieces` par joueur), `dragonPos`, `dragonPhase`, `fairyState`, `currentTilePlaced`, `destroyedTilesCount`, `towers` (Map "x,y" → { height, lockedBy, contributions }), `prisoners` (Map playerId → [{ type, ownerId }]), `_pendingTowerCapture`, `_pendingPrisonerExchange` (échange automatique en attente d'un choix), `_freshCaptures` (captures du tour en cours pas encore validées, bloque temporairement leur rachat), `hasPrisonerBuybacks` (flag sérialisé, vrai dès qu'un rachat de prisonnier a eu lieu, utilisé pour l'affichage conditionnel de la colonne "Rachats" en fin de partie) |
| `LobbyOptions.js` | 548 | Cases à cocher du lobby (extensions, presets, coches maîtres — dont "Tour" / `all-tower`, `tiles-tower`, `ext-tower`), `localStorage`, sync réseau |
| `MeepleConfig.js` | 134 | Tailles/configuration des meeples (`getMeepleSize`) |
| `MeepleUtils.js` | 21 | Utilitaires génériques meeples — poids pour calcul de majorité (Grand Meeple = 2, Bâtisseur/Cochon = 0, Normal/Abbé = 1) |
| `Tile.js` | 100 | Modèle d'une tuile : zones, rotation, traduction des edges selon rotation |

## `modules/core/` — Infrastructure bas niveau

| Fichier | Lignes | Rôle |
|---|---|---|
| `EventBus.js` | 117 | Bus d'événements interne (`on`/`off`/`emit`). **Singleton créé une fois dans `home.js`, jamais recréé** — voir la section "Piège récurrent" en tête de ce document avant d'y ajouter un `eventBus.on(...)` dans une fonction rappelée à chaque partie |
| `GameSync.js` | 700 | Sérialisation/synchronisation réseau hôte↔invités, y compris les messages `tower-floor-placed`, `tower-capture-executed`, `tower-lock-executed`, `prisoner-exchange-resolved`/`prisoner-exchange-pending` (échange automatique de prisonniers, avec le champ `freshlyCapturedType` — ✅ FIX, voir plus bas) et `prisoner-buyback-executed` (rachat de prisonnier, hôte → tous) |
| `HeartbeatManager.js` | 63 | Détection de déconnexion (ping/pong) |
| `Multiplayer.js` | 247 | Connexion P2P, broadcast, sendTo |
| `RuleRegistry.js` | 165 | Active/désactive les règles d'extension |

## `modules/rules/` — Règles de score/placement par extension

| Fichier | Lignes | Rôle |
|---|---|---|
| `AbbeRules.js` | 86 | Règles de l'Abbé (placement, rappel, comptage points) |
| `BaseRules.js` | 74 | Règles de base (villes, routes, champs) |
| `BuilderRules.js` | 313 | Règles Bâtisseur / Cochon / Marchands |
| `DragonConfig.js` | 42 | Constantes extension Dragon : `DRAGON_EDIBLE_MEEPLES`, `FAIRY_ATTACHABLE_MEEPLES` |
| `DragonRules.js` | 390 | Règles extension Dragon (déplacement, cible Princesse, etc.) |
| `InnsRules.js` | 127 | Règles Auberges & Cathédrales |
| `TowerConfig.js` | 42 | Constantes extension Tour : `TOWER_PIECES_BY_PLAYER_COUNT` (stock de pièces selon le nombre de joueurs), `TOWER_CAPTURABLE_MEEPLES`, `TOWER_LOCK_MEEPLES` (réservé), `PRISONER_BUYBACK_COST` (coût fixe du rachat de prisonnier, 3 points), helpers `getTowerPiecesForPlayerCount()` / `isTowerCapturable()` |
| `TowerRules.js` | ~200 | Règles extension Tour : détection des tuiles à zone `tower`, pose d'étage (`addFloor`, décrémente le stock du joueur), calcul de la portée de capture en ligne continue dans les 4 directions (`getCaptureTargets`), exécution de capture (`executeCapture` — retour réserve si auto-capture, sinon prisonnier), verrouillage d'une tour (`lockTower`, consomme un meeple normal/grand meeple du joueur), et `checkReciprocalCapture(capturingPlayerId, capturedOwnerId)` — lecture seule, détecte si une capture crée une situation d'échange automatique de prisonniers (voir plus bas) |

## `modules/game/` — Logique de partie côté client

| Fichier | Lignes | Rôle |
|---|---|---|
| `DragonUI.js` | 480 | Détection zones dragon/volcan/portail, affichage pion dragon/fée, curseurs de déplacement |
| `FinalScoresManager.js` | 292 | Calcul et affichage des scores de fin de partie |
| `GameEventSetup.js` | 499 | Installe tous les listeners DOM du jeu (boutons, modales implaçable, menu) ; relaie `clearTowerCursors` au nettoyage de fin de tour. Utilise déjà le pattern de garde contre la double installation (flag `_installed`) — modèle à suivre pour toute nouvelle fonction d'installation d'écouteurs rappelée à chaque partie (voir "Piège récurrent" en tête de ce document) |
| `GameModuleInitializer.js` | 175 | Instancie les modules UI de jeu, dont `TowerRules` si `tileGroups.tower && extensions.tower` |
| `GameStarter.js` | 200 | Démarrage de partie hôte/invité ; attribue `towerPieces` à chaque joueur actif (hors spectateurs) selon `getTowerPiecesForPlayerCount()` si l'extension Tour est active ; appelle `initTowerUI()` en `postStartSetup()`. **`postStartSetup()` s'exécute à chaque partie (y compris après un retour lobby)** — toute fonction qu'il appelle et qui enregistre des écouteurs `eventBus` doit être protégée contre la ré-installation (voir "Piège récurrent" en tête de ce document) |
| `GameSyncCallbacks.js` | ~480 | Callbacks réseau réactifs : tirage tuile hôte (`hostDrawAndSend`, check dragon-sans-volcan), tuile détruite/implaçable, rappel abbé, tour bonus ; relais des requêtes invité→hôte `tower-floor-request`, `tower-capture-request`, `tower-lock-request` vers `executeAddFloorHost`/`executeTowerCaptureHost`/`executeLockHost` de `TowerUI.js` ; relais de `prisoner-exchange-choice-request` (invité → hôte) vers `executePrisonerChoiceHost`, et branchement des callbacks `gs.onPrisonerExchangeResolved`/`gs.onPrisonerExchangePending` (hôte → invités) vers `applyPrisonerExchangeResolved`/`applyPrisonerExchangePending`, en transmettant désormais `data.freshlyCapturedType` (✅ FIX, voir plus bas) ; relais de `prisoner-buyback-request` (invité → hôte, disponible à tout moment, pas lié au tour) vers `executePrisonerBuybackHost`, et branchement de `gs.onPrisonerBuybackExecuted` vers `applyPrisonerBuybackExecuted` |
| `GameTimer.js` | 59 | Chronomètre de partie |
| `MeeplePlacement.js` | 253 | Logique de pose de meeple |
| `NavigationManager.js` | 161 | Zoom et déplacement (pan) sur le plateau |
| `ReconnectionManager.js` | 674 | Pause/reprise de partie, resynchronisation complète |
| `Scoring.js` | 380 | Calcul des points (fermeture de zones, fin de partie). `applyAndGetFinalScores` inclut `buybacks` (net des rachats de prisonnier, positif ou négatif) dans les scores détaillés retournés — n'inclut toujours pas de scoring dédié pour la capture Tour elle-même (gain immédiat de meeples adverses, pas de points de zone) |
| `TilePlacement.js` | 283 | Logique de pose de tuile |
| `TowerUI.js` | ~830 | UI et orchestration de l'extension Tour : curseurs de pose d'étage (`showTowerCursors`) et de capture (`showTowerCaptureCursors`), sélecteurs de confirmation, pose d'étage hôte (`executeAddFloorHost`/`applyFloorPlaced`), verrouillage hôte (`executeLockHost`/`applyLockExecuted`), capture hôte (`executeTowerCaptureHost`/`applyCaptureExecuted` — mutation identique hôte/invités pour garder `gameState.prisoners` cohérent partout). **✅ FIX** : `applyCaptureExecuted` inclut désormais le même nettoyage des Bâtisseurs/Cochons orphelins que `DragonUI.executeDragonMoveHost` (si le meeple capturé était le dernier meeple "porteur" de son propriétaire dans une zone contenant aussi un Bâtisseur/Cochon de ce même propriétaire, celui-ci est rendu automatiquement) — absent jusqu'ici, seul le Dragon avait ce nettoyage. Rendu visuel de la hauteur de tour et du meeple de verrouillage (`renderTowerHeight`, `renderTowerLockMeeple`). **Échange automatique de prisonniers** : `executeTowerCaptureHost` appelle `_checkAndHandleReciprocalExchange` après chaque capture non-auto, en lui passant désormais le type du meeple fraîchement capturé (`freshlyCapturedType`) ; résolution immédiate (`applyPrisonerExchangeResolved`, un seul type de meeple réciproque possible) ou mise en attente d'un choix (`applyPrisonerExchangePending`, plusieurs types possibles — c'est toujours le joueur qui vient de capturer qui choisit, jamais l'adversaire, car il ne peut y avoir qu'une capture par tour) ; **✅ FIX** : `applyPrisonerExchangeResolved` complète désormais l'échange dans les deux sens — elle rendait déjà à X (le capturant) le meeple qu'il avait perdu, mais ne renvoyait jamais à Y (l'adversaire) le meeple que X venait tout juste de capturer via la tour, alors que ce comportement était documenté en commentaire sans jamais être implémenté (bug rapporté : "l'un des prisonniers est échangé et l'autre reste dans le panel du joueur qui a capturé") ; `executePrisonerChoiceHost` valide et applique le choix reçu du joueur concerné (propage aussi `freshlyCapturedType` via `gameState._pendingPrisonerExchange`) ; affichage de la modale (`showPrisonerExchangeModal`, bouton "Choisir" ou "Fermer" selon le rôle du joueur local) et ouverture du panel adverse en mode sélection (`_openPrisonerSelectionUI`, délègue à `ScorePanelUI.enablePrisonerSelection`/`forceOpenPlayerPanel`). **Rachat de prisonnier** : `setupPrisonerBuyback()` (appelé une fois à l'initialisation) enregistre un gestionnaire PERMANENT auprès de `ScorePanelUI.setBuybackHandler`, actif sur tous les panels en continu (contrairement à la sélection d'échange, ciblée et temporaire) ; disponible à tout moment de la partie, pour n'importe quel joueur qui clique sur son propre prisonnier détenu par un adversaire (≥ 3 points requis) ; se désactive automatiquement tant que `gameState._pendingPrisonerExchange` existe pour éviter tout conflit avec l'échange automatique ; `executePrisonerBuybackHost`/`applyPrisonerBuybackExecuted` transfèrent 3 points de l'acheteur vers le capturant (vraie transaction, pas une dépense neutre), posent `gameState.hasPrisonerBuybacks = true`, et informent tous les joueurs via un toast générique |
| `TurnManager.js` | 415 | Gestion du tour courant, tour bonus |
| `UndoManager.js` | 649 | Annulation d'actions du tour en cours — la pose d'étage/capture/verrouillage tour consomme la "phase meeple" (`markMeeplePlaced(x, y, -1, null)`) mais n'a pas de undo dédié ; l'échange automatique de prisonniers et le rachat de prisonnier ne sont pas non plus annulables pour l'instant (même limitation, à traiter dans une passe future dédiée à l'undo de l'extension Tour — le rachat n'étant de toute façon pas lié au tour en cours, il devra probablement rester hors du système d'undo classique) |
| `UnplaceableTileManager.js` | 401 | Gestion des tuiles implaçables (badge, modale, `handleConfirm`, `showUnplaceableBadgeDragon`) |
| `ZoneMerger.js` | 720 | Fusionne les zones entre tuiles adjacentes, calcule les meeples présents dans une zone fusionnée — fichier le plus volumineux du projet, cœur des bugs de placement de meeple. Chaque zone (y compris `garden`/`abbey`) est enregistrée dans le registre dès la pose de tuile (`createZone`) — `findMergedZoneForPosition` retourne donc presque toujours une zone existante. Les zones de type `tower` (comme `dragon`/`volcano`/`portal`) sont exclues des positions de meeple classiques (cf. `MeepleCursorsUI.js`) |
| `ZoneRegistry.js` | 201 | Registre central des zones fusionnées (persistant, mis à jour incrémentalement, historique des villes fermées pour le scoring des champs) |
| `ZoomManager.js` | 204 | Gestion du niveau de zoom |

## `modules/ui/` — Composants d'affichage

| Fichier | Lignes | Rôle |
|---|---|---|
| `GameMenuUI.js` | 49 | Menu en jeu |
| `LobbyJoin.js` | 168 | Logique de connexion en tant qu'invité |
| `LobbyNavigator.js` | ~185 | Retour au lobby / lobby initial ; réinitialise `towerRules` au retour lobby ; masque également la modale `#prisoner-exchange-modal`, le voile `#prisoner-selection-overlay` et retire la classe `body.prisoner-selection-mode` au retour lobby (échange automatique de prisonniers). La modale `#prisoner-buyback-modal` (rachat) n'a pas besoin du même traitement — elle n'a pas d'overlay/classe body persistante associée. **Ne touche pas** à `eventBus` (singleton conservé d'une partie à l'autre — voir "Piège récurrent" en tête de ce document) |
| `LobbyUI.js` | 356 | Interface du lobby (liste joueurs, kick, menu) |
| `MeepleActionsUI.js` | ~660 | Actions meeples : rappel abbé, portail, éjection princesse, placement fée ; orchestre aussi l'extension Tour via les imports de `TowerUI.js` (`showTowerCursors`, `showPendingTowerCaptureIfAny`, application des events réseau `network-tower-floor-placed`/`network-tower-capture-executed`/`network-tower-lock-executed`). **✅ FIX** : `initNetworkMeepleListeners(eventBus)` — appelée à chaque partie depuis `GameStarter.postStartSetup()` — est désormais protégée par un flag module-level (`_networkListenersInstalled`) empêchant toute ré-installation après la première partie. Sans cette garde, chaque retour lobby + nouvelle partie ajoutait un écouteur supplémentaire sur `network-tower-capture-executed` (et les équivalents Princesse/Portail), causant un traitement en double côté invité uniquement (bug rapporté : prisonnier affiché en double après un retour lobby) — voir la section "Piège récurrent" en tête de ce document pour le détail du mécanisme et le pattern de correction |
| `MeepleCursorsUI.js` | 455 | Curseurs de placement de meeple sur une tuile posée (filtre par type de zone + ressources dispo + occupation de zone fusionnée) ; exclut la zone `tower` des positions de meeple classiques pour laisser place au curseur dédié de `TowerUI.js` |
| `MeepleDisplayUI.js` | 91 | Affichage visuel des meeples posés |
| `MeepleSelectorUI.js` | 333 | Sélecteur de type de meeple (rappel abbé + fée, etc.) |
| `ModalUI.js` | 528 | Utilitaires génériques de modales ; règles affichées incluent la section Tour si activée |
| `ScorePanelUI.js` | ~500 | Panneau des scores (desktop + mobile) : affiche le stock de pièces de tour restant (`towerPieces`) et la ligne "prisonniers" (meeples capturés, affichés avec la couleur de leur propriétaire d'origine et un motif de grille) si `extensions.tower`. **✅ FIX** : un paysan capturé (`Farmer`/`Large-Farmer`) est désormais affiché avec le sprite `Normal`/`Large` dans la ligne prisonniers — un paysan en prison rejoint le même pool générique `player.meeples`/`hasLargeMeeple` qu'un meeple normal, le sprite `Farmer` (dessiné couché, posture "dans le champ") était donc trompeur une fois affiché comme prisonnier ; `entry.type` (donnée réelle utilisée par le rachat et l'échange automatique) reste inchangé, seul le sprite affiché change. **✅ FIX** : chaque prisonnier stoppe désormais systématiquement la propagation du clic (`stopPropagation`), même s'il n'est pas sélectionnable — évite qu'un clic sur un prisonnier non rachetable ne remonte jusqu'au toggle d'ouverture/fermeture de la carte joueur. **Sélection de prisonniers (mécanisme générique)** : `enablePrisonerSelection({ playerId, isSelectable, onSelect })`/`disablePrisonerSelection()` rendent cliquables les entrées de `.prison-row` d'un panel donné (ciblé, temporaire) selon un prédicat fourni par l'appelant — utilisé par l'échange automatique de prisonniers (`TowerUI.js`). `setBuybackHandler({ isSelectable, onSelect })` enregistre un second gestionnaire PERMANENT, actif sur TOUS les panels en continu (contrairement au précédent) — utilisé par le rachat de prisonnier. Au rendu, la session d'échange ciblée est toujours prioritaire sur le gestionnaire de rachat permanent pour un même prisonnier (les deux ne se chevauchent jamais en pratique car le rachat se désactive lui-même tant qu'un échange est en attente). `forceOpenPlayerPanel(playerId)` force l'ouverture (desktop + mobile) d'un panel donné |
| `SlotsUI.js` | 234 | Slots de placement de tuile (pointillés dorés). Écoute `tile-drawn`/`tile-placed`/`turn-changed`/`tile-rotated`. Flag `isBlocked` pour forcer le lecture-seule |
| `TilePreviewUI.js` | 65 | Aperçu de la tuile en main (recto/verso) |
| `TurnUI.js` | 293 | Affichage tour courant, boutons mobile, messages/toasts |

---

## Données (`data/`)

```
data/
├── Abbot/             01.json … 08.json   (8 tuiles)
├── Base/               01.json … 24.json   (24 tuiles)
├── Dragon/            01.json … 29.json   (29 tuiles)
├── Inns_Cathedrals/   01.json … 18.json   (18 tuiles)
├── River/             01.json … 12.json   (12 tuiles — source et embouchure fixes, milieu mélangé)
├── Tower/             01.json … 17.json   (18 tuiles au total — la tuile 11 a quantity: 2)
├── Traders_Builders/  01.json … 24.json   (24 tuiles)
└── Presets/           01.json, 02.json... (presets de configuration de partie, pas des tuiles)
```

Chargement effectué par `modules/Deck.js` → `loadAllTiles()`, via
`fetch('./data/{Groupe}/{id}.json')`, en parallèle par groupe. Chaque tuile a
un `id` unique reconstruit en `{extension}-{id}` (ex. `base-04`, `dragon-22`,
`tower-11`). Le groupe `Tower` (`data/Tower/01..17.json`) est chargé si
`tileGroups.tower` est actif ; chaque tuile Tower contient une zone de type
`tower` (voir `TowerRules.tileHasTowerZone`), certaines combinées à des zones
city/road/field/garden/abbey classiques.

Cas particuliers notables dans `Deck.js` :
- `startType === 'river'` : tuile source (`river-01`) et embouchure (`river-12`) fixes, tuiles intermédiaires mélangées.
- `testMode` : deck réduit, parfois un ordre forcé (séquence rivière figée, ou deck custom `['base-04', 'dragon-22', ...]`).
- Tuile normale (`unique`) : `base-04` toujours forcée en première position après mélange.

---

## Extension Tour — Résumé fonctionnel

- **Activation** : case à cocher `tiles-tower` (tuiles) + `ext-tower` (règle),
  regroupées sous la coche maître `all-tower` dans `LobbyOptions.js` et
  `index.html`. `ext-tower` est désactivée/grisée tant que `tiles-tower` n'est
  pas cochée (cf. `_updateTowerAvailability()`).
- **Stock de pièces** : chaque joueur actif reçoit un nombre de pièces de tour
  selon le nombre de joueurs (`TOWER_PIECES_BY_PLAYER_COUNT` dans
  `TowerConfig.js`), attribué dans `GameStarter._initGameState()`.
- **Pose d'étage** : sur n'importe quelle tuile à zone `tower` non verrouillée,
  consomme une pièce du stock du joueur, incrémente la hauteur de la tour
  (`GameState.towers[x,y].height`). Consomme la "phase meeple" du tour (comme
  poser un meeple classique).
- **Capture** : après la pose d'un étage, calcule les meeples capturables
  (types dans `TOWER_CAPTURABLE_MEEPLES` — pas de bâtisseur/cochon) sur la
  tuile de la tour et en ligne continue dans les 4 directions jusqu'à une
  distance égale à la hauteur de la tour (une case vide interrompt la ligne).
  Auto-capture → retour du meeple à la réserve du joueur. Capture d'un
  adversaire → le meeple devient un "prisonnier" (`GameState.prisoners`,
  affiché dans `ScorePanelUI`), sauf échange automatique immédiat (voir
  ci-dessous). **✅ FIX** : si le meeple capturé était le dernier meeple
  "porteur" (normal/grand meeple) de son propriétaire dans une zone contenant
  aussi un Bâtisseur ou un Cochon de ce même propriétaire, celui-ci est
  désormais automatiquement rendu à la réserve (`applyCaptureExecuted`,
  même algorithme que `DragonUI.executeDragonMoveHost`) — auparavant il
  restait bloqué sur le plateau indéfiniment.
- **Échange automatique de prisonniers** : après chaque capture
  d'un meeple adverse (non-auto-capture), l'hôte vérifie la réciprocité entre
  le joueur qui vient de capturer (X) et le propriétaire du meeple capturé (Y)
  via `TowerRules.checkReciprocalCapture(X, Y)` : Y détient-il déjà, parmi ses
  prisonniers, un ou plusieurs meeples appartenant à X ?
  - **Aucun** → capture normale, rien de plus.
  - **Un seul type distinct** → résolution immédiate et automatique sans
    ambiguïté : ce type revient à X, le meeple fraîchement capturé par X
    retourne toujours à Y (✅ FIX — voir ci-dessous). Modale informative pour
    tous, bouton "Fermer".
  - **Plusieurs types distincts** → X doit choisir lequel récupérer. Comme il
    ne peut y avoir qu'une seule capture par tour de jeu, c'est structurellement
    toujours X (le joueur actif) qui, le cas échéant, doit choisir — jamais Y.
    X voit une modale avec bouton "Choisir" qui ouvre automatiquement le panel
    de score de Y en mode sélection (voile gris + prisonniers de X chez Y
    rendus cliquables, cf. `ScorePanelUI.enablePrisonerSelection` /
    `forceOpenPlayerPanel`) ; les autres joueurs voient une simple modale
    informative avec bouton "Fermer".
  - **✅ FIX — retour dans les deux sens** : le retour du meeple fraîchement
    capturé par X vers Y était documenté en commentaire mais jamais implémenté :
    `applyPrisonerExchangeResolved` ne rendait que le meeple de X (`chosenType`),
    jamais celui que X venait de prendre à Y. Le type du meeple fraîchement
    capturé (`freshlyCapturedType`) est désormais propagé depuis la capture
    (`executeTowerCaptureHost`) jusqu'à la résolution — y compris à travers un
    choix différé (`gameState._pendingPrisonerExchange`) et la synchronisation
    réseau (`GameSync.syncPrisonerExchangeResolved`/`syncPrisonerExchangePending`,
    champ `freshlyCapturedType`) — pour que `applyPrisonerExchangeResolved`
    puisse retirer cette entrée des prisonniers de X et la rendre à la réserve
    de Y.
  - Le tour se retrouve naturellement bloqué tant que la modale ou le voile
    gris de sélection sont affichés (recouvrement plein écran), sans logique
    de blocage dédiée dans `GameEventSetup`/`TurnUI`.
  - Réseau : `prisoner-exchange-pending`/`prisoner-exchange-resolved`
    (hôte → tous, broadcast) et `prisoner-exchange-choice-request`
    (invité → hôte, intercepté directement dans
    `GameSyncCallbacks._attachHostCallbacks`, même pattern que les autres
    requêtes `tower-*-request`).
  - Non annulable pour l'instant (même limitation que le reste de l'extension
    Tour, cf. `UndoManager.js`).
- **Rachat de prisonnier** : disponible à tout moment de la partie
  (indépendamment du tour en cours), pour n'importe quel joueur qui ouvre le
  panel de score d'un adversaire détenant un de ses prisonniers. Coût fixe
  `PRISONER_BUYBACK_COST` (3 points, `TowerConfig.js`) : c'est une vraie
  transaction — les points sont retirés à l'acheteur et **versés au joueur qui
  détient le prisonnier** (le capturant), pas à une réserve neutre.
  - Un prisonnier n'est cliquable (`.prisoner-selectable`) que s'il appartient
    au joueur local (`entry.ownerId === multiplayer.playerId`) et que celui-ci
    a au moins 3 points ; sinon rien ne se passe au clic (pas de tooltip,
    et le clic ne remonte plus vers le toggle de la carte — ✅ FIX).
  - Une modale de confirmation (`#prisoner-buyback-modal`, boutons
    Confirmer/Annuler) précède toute transaction, vu l'enjeu de perdre des
    points par erreur.
  - Désactivé automatiquement tant qu'un échange automatique de prisonniers
    est en attente de résolution (`gameState._pendingPrisonerExchange`), pour
    éviter tout conflit de mutation sur les mêmes prisonniers entre les deux
    mécanismes (fenêtre entre l'annonce de l'échange et le choix du joueur
    concerné).
  - **Garde-fou temporaire (tour en cours)** : comme l'annulation
    n'est pas encore adaptée à l'extension Tour (`UndoManager.restoreSnapshot`
    ne touche ni `gameState.towers` ni `gameState.prisoners`), une capture
    effectuée pendant le tour EN COURS du détenteur reste temporairement non
    rachetable tant que ce tour n'est pas terminé — sinon un rachat suivi
    d'une future annulation de la capture dupliquerait le meeple. Suivi via
    `gameState._freshCaptures` (liste transitoire `[{ holderId, ownerId,
    type }]`, alimentée dans `TowerUI.applyCaptureExecuted`), vidée
    intégralement à chaque `'turn-changed'` (home.js) — n'affecte donc jamais
    les prisonniers de tours précédents, seulement la capture la plus
    récente tant qu'elle n'est pas validée par le passage du tour.
  - Un toast générique informe tous les joueurs de la transaction
    (`🔓 [Acheteur] a racheté un [type] auprès de [Détenteur] (-3 points).`).
  - Réseau : `prisoner-buyback-request` (invité → hôte, intercepté dans
    `GameSyncCallbacks._attachHostCallbacks`, disponible à tout moment donc
    pas conditionné à `getCurrentPlayer()`) / `prisoner-buyback-executed`
    (hôte → tous, broadcast y compris echo à l'acheteur).
  - Score détaillé : `player.scoreDetail.buybacks` (peut être négatif pour
    l'acheteur, positif pour le vendeur), remonté dans `Scoring.js` et affiché
    en fin de partie dans une colonne "Rachats" **uniquement si**
    `gameState.hasPrisonerBuybacks` est vrai (au moins un rachat a eu lieu
    durant la partie) — cf. `FinalScoresManager.js`.
  - Non annulable (n'est de toute façon pas lié au tour en cours, donc hors du
    système d'undo classique par nature).
- **Verrouillage** : à partir du moment où une tour a au moins 1 étage,
  n'importe quel joueur peut la verrouiller avec un meeple normal ou un grand
  meeple (ressource personnelle consommée), ce qui la rend non modifiable
  (`isLocked`) et l'exclut des tuiles éligibles à un nouvel étage.
- **Réseau** : architecture réactive identique aux autres actions (invité
  envoie une requête `tower-floor-request`/`tower-capture-request`/
  `tower-lock-request` à l'hôte qui seul possède l'état de vérité, l'hôte
  applique et broadcast `tower-floor-placed`/`tower-capture-executed`/
  `tower-lock-executed` à tous, y compris echo à l'émetteur). Les callbacks
  réseau côté invités (`network-tower-*`) sont enregistrés une seule fois pour
  toute la durée de vie de l'app (voir "Piège récurrent" en tête de ce
  document) — vigilance requise pour toute nouvelle extension suivant ce même
  pattern hôte-autoritaire/invité-réactif.
- **Scoring** : pas de points directement liés à la Tour dans `Scoring.js` —
  le seul bénéfice est l'avantage stratégique de capturer/neutraliser des
  meeples adverses. Pas de scoring de fin de partie spécifique pour les
  prisonniers ou les tours inachevées.

---

## Aide au diagnostic — quel(s) fichier(s) regarder selon le symptôme

| Symptôme | Fichiers probables |
|---|---|
| Case à cocher du lobby ne se comporte pas comme prévu | `modules/LobbyOptions.js` |
| Meeple ne peut/peut être posé à tort quelque part | `modules/ui/MeepleCursorsUI.js`, `modules/game/ZoneMerger.js`, `modules/game/ZoneRegistry.js`, `modules/rules/*Rules.js`, `modules/MeepleUtils.js` |
| Tuile peut être posée alors qu'elle ne devrait pas (ou inversement) | `modules/ui/SlotsUI.js`, `modules/Board.js`, `modules/game/TilePlacement.js` |
| Bug lié au chargement/mélange/composition du deck | `modules/Deck.js` |
| Bug spécifique Dragon/Fée/Princesse/Portail | `modules/game/DragonUI.js`, `modules/rules/DragonRules.js`, `modules/rules/DragonConfig.js`, `modules/game/GameSyncCallbacks.js` |
| Bug spécifique Tour (pose d'étage, capture, verrouillage, stock de pièces) | `modules/game/TowerUI.js`, `modules/rules/TowerRules.js`, `modules/rules/TowerConfig.js`, `modules/GameState.js` (towers/prisoners), `modules/game/GameSyncCallbacks.js` (requêtes réseau), `modules/ui/MeepleActionsUI.js` (orchestration curseurs) |
| Bug spécifique à l'échange automatique de prisonniers | `modules/game/TowerUI.js` (`_checkAndHandleReciprocalExchange`, `applyPrisonerExchangeResolved`, `applyPrisonerExchangePending`, `executePrisonerChoiceHost`), `modules/rules/TowerRules.js` (`checkReciprocalCapture`), `modules/ui/ScorePanelUI.js` (`enablePrisonerSelection`/`forceOpenPlayerPanel`), `modules/core/GameSync.js` et `modules/game/GameSyncCallbacks.js` (messages réseau, champ `freshlyCapturedType`), `index.html`/`style.css` (modale `#prisoner-exchange-modal`, voile `#prisoner-selection-overlay`) |
| Bug spécifique au rachat de prisonnier | `modules/game/TowerUI.js` (`setupPrisonerBuyback`, `executePrisonerBuybackHost`, `applyPrisonerBuybackExecuted`), `modules/rules/TowerConfig.js` (`PRISONER_BUYBACK_COST`), `modules/ui/ScorePanelUI.js` (`setBuybackHandler`), `modules/core/GameSync.js`/`modules/game/GameSyncCallbacks.js` (messages `prisoner-buyback-request`/`prisoner-buyback-executed`), `modules/game/Scoring.js`/`modules/game/FinalScoresManager.js` (colonne "Rachats"), `index.html` (modale `#prisoner-buyback-modal`) |
| Un événement réseau semble appliqué plusieurs fois (état dupliqué), surtout après un retour lobby + nouvelle partie, et seulement côté invité | Section "⚠️ Piège récurrent — `eventBus` singleton" en tête de ce document. Chercher une fonction `initXxxListeners(eventBus)` appelée depuis `GameStarter.postStartSetup()` (ou un point équivalent réinvoqué à chaque partie) et vérifier qu'elle est protégée contre la ré-installation (cf. pattern dans `MeepleActionsUI.js`/`GameEventSetup.js`) |
| Désynchronisation réseau hôte/invité | `modules/core/GameSync.js`, `modules/game/GameSyncCallbacks.js`, `home.js` |
| Déconnexion/reconnexion/pause | `modules/game/ReconnectionManager.js`, `modules/core/HeartbeatManager.js` |
| Score incorrect | `modules/game/Scoring.js`, `modules/game/ZoneMerger.js`, `modules/game/ZoneRegistry.js`, `modules/MeepleUtils.js` |
| Annulation d'action (undo) qui se comporte mal | `modules/game/UndoManager.js` |
| Modale/texte d'interface à modifier | `index.html` (texte statique) ou le manager JS correspondant si dynamique |
