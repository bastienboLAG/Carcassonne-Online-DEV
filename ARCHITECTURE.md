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
**Futures extensions prévues** (pas encore commencées, traitées une par une —
voir la section dédiée plus bas) : Maire, Chariot, Berger (+ jetons moutons),
Directeur, Grange, Pont, Forteresse, et une zone à 3 meeples empilés.

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
`gameState.extraState.prisoners`, provoquant l'affichage d'un prisonnier en
double — **uniquement côté invité**, car ces événements réseau ne sont émis
que lorsque `!isHost` (l'hôte applique directement sans passer par l'event
bus, donc jamais concerné par ce genre de doublon).

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

## ⚠️ `gameState.extraState` — conteneur générique pour l'état persistant des extensions

**Lire cette section avant de commencer toute nouvelle extension qui ajoute
un pion, une structure ou un compteur qui vit sur le plateau ou entre les
joueurs** (grange, pont, forteresse, jetons moutons, maire, chariot,
directeur, berger...).

### Pourquoi ce conteneur existe

`placedMeeples` (map `"x,y,position" → { type, color, playerId }`) est le bon
endroit pour un pion qui : (1) appartient à un joueur, (2) occupe une des 25
positions fixes d'une tuile, (3) suit le même cycle de vie qu'un meeple
classique (undo générique, snapshot générique, retour en réserve). Le
Bâtisseur et le Cochon en sont la preuve : ce sont des "meeples spéciaux" qui
vivent très bien dans `placedMeeples` (`MeepleUtils.getMeepleWeight` leur
donne juste un poids de 0 pour la majorité).

Mais certaines pièces ne correspondent pas à ce modèle :
- elles ne se posent pas sur une des 25 positions d'une tuile (une grange se
  pose à une intersection entre 4 tuiles, un pont se pose au centre avec une
  orientation horizontale/verticale) ;
- elles ne sont pas un pion de joueur mais un **compteur** qui s'accumule sur
  un emplacement (jetons moutons du berger) ;
- elles combinent une position ET un état propre qui n'est pas juste
  "occupé/libre" (une tour a une hauteur, un verrouillage, une couleur de
  garde — trois informations, pas une présence binaire).

Pour ces cas, `gameState.extraState` est le conteneur générique dans lequel
range toute nouvelle sous-structure de ce type :

```js
// modules/GameState.js — constructeur
this.extraState = {
    towers: {},      // Map "x,y" -> { height, lockedBy, lockMeepleType, lockMeepleColor, contributions }
    prisoners: {},   // Map playerId -> [{ type, ownerId }]
    // ✨ futures extensions : ajouter ici, ex.
    // sheep: {},        // Map "x,y" -> nombre de moutons (Berger)
    // barns: {},        // Map "x,y" -> { ownerId } (Grange, clé = intersection)
    // bridges: {},      // Map "x,y" -> { orientation } (Pont)
    // fortresses: {},   // Map zoneId -> { ... } (Forteresse)
};
```

### Ce que ce conteneur t'évite de faire à chaque extension

Parce que `extraState` est traité **génériquement** (sans connaître la liste
de ses sous-clés) aux trois endroits suivants, ajouter une nouvelle sous-clé
ne demande **aucune modification** de ces trois fichiers :

1. **`GameState.serialize()`/`deserialize()`** — sérialise/désérialise
   `this.extraState` en un seul bloc.
2. **`UndoManager.restoreExtraState(source)`** — boucle sur
   `Object.keys(this.gameState.extraState)` et restaure chaque sous-clé sans
   les nommer. Appelée depuis `restoreSnapshot()` (undo tuile/meeple/abbé) et
   `undoDragonMove()` (undo déplacement dragon), et côté invité dans
   `applyRemote()`.
3. **Sérialisation réseau (`GameSync.syncFullState`/`syncTurnEnd`, etc.)** —
   passe déjà par `gameState.serialize()`, donc rien à faire là non plus.

### Ce que tu dois quand même faire, à chaque extension

`extraState` ne fait que le transport générique — la **logique métier** de ta
nouvelle extension reste à écrire, comme pour la Tour :

- **Snapshot** : `UndoManager.saveTurnStart`/`saveAfterTilePlaced`/`saveDragonMove`
  copient déjà `this.gameState.extraState` en bloc (`this.deepCopy(...)`) —
  rien à ajouter ici non plus, sauf si ta nouvelle mécanique introduit un
  **nouveau point de sauvegarde** distinct des trois existants (ex: un
  snapshot dédié si le Berger a lui aussi une action en plusieurs étapes comme
  la Tour floor+capture).
- **Rendu visuel après restauration** : si ta pièce a un rendu DOM (comme
  `.tower-piece`/`.tower-lock-meeple`), écris une fonction du style
  `renderAllXxxFromState()` (voir `TowerUI.renderAllTowersFromState` comme
  modèle) qui efface puis redessine tout depuis `gameState.extraState.xxx`, et
  branche-la aux **trois mêmes points** que la Tour : `UndoManager.applyLocally`
  (déjà appelée en un seul point générique, `d.renderAllTowersFromState?.()`
  — ajoute simplement ton propre appel juste à côté, injecté de la même façon
  via `initVisualHandlers`), `ReconnectionManager.applyFullStateSync` (même
  pattern que le bloc `if (gameConfig.tileGroups?.tower) { d.renderAllTowersFromState?.(); }`).
- **Champs `_pending*` transitoires** (turn-scoped, jamais sérialisés, donc
  **volontairement PAS dans extraState**) : si ta mécanique a elle aussi une
  étape "en attente" dans le même tour (comme `_pendingTowerCapture`), ajoute
  ton propre champ `gameState._pendingXxx`, et n'oublie pas de le réinitialiser
  explicitement dans `UndoManager.restoreSnapshot()`/`applyRemote()`, exactement
  comme `_pendingTowerCapture`/`_pendingReciprocalCheck` le sont aujourd'hui —
  `extraState` ne les couvre pas automatiquement.
- **Différer une conséquence non-annulable** (comme l'échange automatique de
  prisonniers) : si une action de ta nouvelle mécanique déclenche un effet qui
  mute l'état d'un **autre** joueur (pas seulement le joueur actif), différer
  cet effet à la fin du tour (voir `TowerUI.checkPendingReciprocalExchange`,
  branché aux mêmes deux points que pour la Tour — `GameEventSetup._installEndTurn`
  et `GameSyncCallbacks.onTurnEndRequest`, juste après `undoManager.reset()`)
  plutôt que de le résoudre immédiatement, pour ne pas le rendre incohérent
  avec une éventuelle annulation de l'action qui l'a déclenché.

### Pièges spécifiques aux futures pièces déjà identifiés

- **Positions hors 5×5 (Grange, Pont)** : `placedMeeples`/`ZoneMerger` sont
  bâtis sur l'hypothèse d'une position 1-25 sur UNE tuile. Une grange
  (intersection de 4 tuiles) ou un pont (toujours au centre, horizontal ou
  vertical) ont besoin de leur propre schéma de clé — ne pas essayer de les
  forcer dans le format `"x,y,position"` existant. Le pont modifie en plus la
  **connectivité des bords** de la tuile (transforme un bord champ en route),
  ce qui touche potentiellement `Tile.getEdgeType`/`Board.canPlaceTile` et pas
  seulement l'affichage — probablement le chantier le plus structurant des
  extensions listées.
- **Compteur simple (jetons moutons)** : contrairement à la Tour (état riche :
  hauteur + verrouillage + couleur), un compteur de moutons est juste un
  nombre par position — `extraState.sheep["x,y"] = count`. Pas besoin d'un
  mécanisme de verrouillage/capture, mais il faudra définir ce qui se passe à
  l'undo d'une pose de mouton (même schéma que `_pendingTowerCapture` si le
  Berger a lui aussi une action en 2 temps).
- **Zone à 3 meeples empilés (pyramide)** : casse l'hypothèse centrale de
  `placedMeeples` qu'une clé `"x,y,position"` contient au plus **un** meeple —
  `getZoneMeeples`, `canPlace`, `Scoring` en dépendent tous. Ce n'est
  probablement PAS un candidat pour `extraState` (ce sont bien des meeples de
  joueurs, avec majorité/score classique) — plutôt une évolution du format de
  valeur dans `placedMeeples` (tableau au lieu d'un objet unique pour cette
  position) ou une position virtuelle dédiée par "étage" de la pyramide.
  Sujet à traiter avec attention avant de coder quoi que ce soit — poser la
  question de l'approche avant d'implémenter, comme convenu pour chaque
  nouvelle extension.
- **Maire/Chariot/Directeur** : a priori les plus simples de la liste — un
  meeple, une position fixe, un propriétaire, comme Bâtisseur/Cochon
  aujourd'hui. Vivent dans `placedMeeples` avec un nouveau `type`, PAS dans
  `extraState`.

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
| `GameState.js` | ~230 | État global : joueurs (dont `towerPieces` par joueur), `dragonPos`, `dragonPhase`, `fairyState`, `currentTilePlaced`, `destroyedTilesCount`, **`extraState`** (conteneur générique — voir section dédiée en tête de ce document — contenant aujourd'hui `towers` et `prisoners`), `_pendingTowerCapture`, `_pendingReciprocalCheck` (échange automatique différé à la fin du tour du capturant — voir plus bas), `_pendingPrisonerExchange` (choix en attente), `_freshCaptures` (captures du tour en cours pas encore validées, bloque temporairement leur rachat), `hasPrisonerBuybacks` (flag sérialisé) |
| `LobbyOptions.js` | 548 | Cases à cocher du lobby (extensions, presets, coches maîtres — dont "Tour" / `all-tower`, `tiles-tower`, `ext-tower`), `localStorage`, sync réseau |
| `MeepleConfig.js` | 134 | Tailles/configuration des meeples (`getMeepleSize`) |
| `MeepleUtils.js` | 21 | Utilitaires génériques meeples — poids pour calcul de majorité (Grand Meeple = 2, Bâtisseur/Cochon = 0, Normal/Abbé = 1) |
| `Tile.js` | 100 | Modèle d'une tuile : zones, rotation, traduction des edges selon rotation |

## `modules/core/` — Infrastructure bas niveau

| Fichier | Lignes | Rôle |
|---|---|---|
| `EventBus.js` | 117 | Bus d'événements interne (`on`/`off`/`emit`). **Singleton créé une fois dans `home.js`, jamais recréé** — voir la section "Piège récurrent" en tête de ce document avant d'y ajouter un `eventBus.on(...)` dans une fonction rappelée à chaque partie |
| `GameSync.js` | 700 | Sérialisation/synchronisation réseau hôte↔invités, y compris les messages `tower-floor-placed`, `tower-capture-executed`, `tower-lock-executed`, `prisoner-exchange-resolved`/`prisoner-exchange-pending` (échange automatique de prisonniers, avec le champ `freshlyCapturedType`) et `prisoner-buyback-executed` (rachat de prisonnier, hôte → tous). `syncFullState`/le message `turn-undo` transportent `gameState.serialize()`/`postUndoState`, qui incluent tous deux `extraState` sans logique dédiée dans ce fichier (transport générique, cf. section extraState) |
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
| `DragonRules.js` | ~400 | Règles extension Dragon (déplacement, cible Princesse, etc.). **✅ FIX** : `_eatMeeplesAt(x, y)` mange désormais aussi un garde verrouillant une tour présent sur la tuile visitée (lu dans `gameState.extraState.towers[x,y]`, absent de `placedMeeples`) — auparavant le dragon l'ignorait complètement. Le meeple est toujours rendu à la réserve du joueur (jamais capturé comme prisonnier Tour, cohérent avec le comportement du dragon sur un meeple classique), et la tour est déverrouillée dans la foulée. Traité avec la clé spéciale `tower-lock:x,y` (même convention que `TowerRules.getCaptureTargets`), résolue côté visuel par `DragonUI.executeDragonMoveHost` |
| `InnsRules.js` | 127 | Règles Auberges & Cathédrales |
| `TowerConfig.js` | 42 | Constantes extension Tour : `TOWER_PIECES_BY_PLAYER_COUNT`, `TOWER_CAPTURABLE_MEEPLES`, `TOWER_LOCK_MEEPLES` (réservé), `PRISONER_BUYBACK_COST`, helpers `getTowerPiecesForPlayerCount()` / `isTowerCapturable()` |
| `TowerRules.js` | ~230 | Règles extension Tour, lisant/mutant désormais `gameState.extraState.towers`/`gameState.extraState.prisoners` (anciennement `gameState.towers`/`gameState.prisoners` directement — voir section extraState). Détection des tuiles à zone `tower`, pose d'étage (`addFloor`), calcul de la portée de capture (`getCaptureTargets`), exécution de capture (`executeCapture`), verrouillage d'une tour (`lockTower` — **✅ FIX** : refuse désormais le verrouillage sur la tuile où se trouve actuellement le dragon, `gameState.dragonPos`, même principe d'exclusion que `DragonRules.getPortalTargets` pour le portail ; ne s'applique volontairement qu'au verrouillage, aucune règle ne restreint la simple pose d'un étage), et `checkReciprocalCapture` (détection de réciprocité pour l'échange automatique de prisonniers) |

## `modules/game/` — Logique de partie côté client

| Fichier | Lignes | Rôle |
|---|---|---|
| `DragonUI.js` | ~490 | Détection zones dragon/volcan/portail, affichage pion dragon/fée, curseurs de déplacement. **✅ FIX** : `executeDragonMoveHost` reconnaît désormais dans `eaten` les clés préfixées `tower-lock:x,y` (garde de tour mangé par `DragonRules._eatMeeplesAt`) et retire le bon élément visuel (`.tower-lock-meeple`) au lieu de chercher un `.meeple[data-key]` inexistant |
| `FinalScoresManager.js` | 292 | Calcul et affichage des scores de fin de partie |
| `GameEventSetup.js` | ~510 | Installe tous les listeners DOM du jeu. Point de fin de tour (`_installEndTurn`) : appelle désormais `d.checkPendingReciprocalExchange?.()` juste après `undoManager.reset()` (échange automatique de prisonniers différé — voir plus bas) ; `_installUndo` inclut `extraState` et `towerPieces` dans le `postUndoState` envoyé aux invités. Utilise déjà le pattern de garde contre la double installation (flag `_installed`) |
| `GameModuleInitializer.js` | ~185 | Instancie les modules UI de jeu, dont `TowerRules` si `tileGroups.tower && extensions.tower`. Relaie `renderAllTowersFromState` (via `d`) dans `undoManager.initVisualHandlers({...})`, pour que l'undo puisse redessiner l'état Tour après restauration |
| `GameStarter.js` | 200 | Démarrage de partie hôte/invité ; attribue `towerPieces` à chaque joueur actif selon `getTowerPiecesForPlayerCount()` ; appelle `initTowerUI()` en `postStartSetup()` |
| `GameSyncCallbacks.js` | ~490 | Callbacks réseau réactifs. `onTurnEndRequest` (hôte, pour un invité qui termine son tour) appelle `checkPendingReciprocalExchange()` juste après `undoManager.reset()` — même point que côté hôte-joueur dans `GameEventSetup`. `onUndoRequest` (hôte, pour un invité qui annule) inclut `extraState` et `towerPieces` dans le `postUndoState` envoyé. Relais des requêtes invité→hôte `tower-floor-request`/`tower-capture-request`/`tower-lock-request`/`prisoner-exchange-choice-request`/`prisoner-buyback-request` |
| `GameTimer.js` | 59 | Chronomètre de partie |
| `MeeplePlacement.js` | 253 | Logique de pose de meeple |
| `NavigationManager.js` | 161 | Zoom et déplacement (pan) sur le plateau |
| `ReconnectionManager.js` | ~680 | Pause/reprise de partie, resynchronisation complète. `applyFullStateSync` : **✅ FIX** — appelle désormais `d.renderAllTowersFromState?.()` (si `tileGroups.tower`) juste après le rendu Dragon/Fée. Auparavant, les tours et leurs gardes de verrouillage n'étaient **jamais** redessinés à la reconnexion (contrairement au Dragon/Fée, qui avaient déjà leur bloc dédié), alors que `gameState.extraState.towers` était déjà resynchronisé par `gameState.deserialize()` juste avant — un invité qui se reconnectait voyait un plateau sans aucune tour |
| `Scoring.js` | 380 | Calcul des points. `applyAndGetFinalScores` inclut `buybacks` dans les scores détaillés |
| `TilePlacement.js` | 283 | Logique de pose de tuile |
| `TowerUI.js` | ~950 | UI et orchestration de l'extension Tour, entièrement migrée vers `gameState.extraState.towers`/`gameState.extraState.prisoners` (voir section extraState en tête de document). Curseurs de pose d'étage/capture, sélecteurs de confirmation, pose d'étage/verrouillage/capture hôte. **✅ FIX** : `showTowerCursors`/`_openTowerFloorSelector` masquent désormais l'option de verrouillage sur la tuile où se trouve le dragon (cohérent avec `TowerRules.lockTower`). **✨ NOUVEAU** : `renderAllTowersFromState()` — (re)dessine l'intégralité des tours et gardes depuis `gameState.extraState.towers`, utilisée par `UndoManager.applyLocally` (un seul appel générique en tête de fonction, couvrant tous les types d'action annulée) et par `ReconnectionManager.applyFullStateSync`. **Échange automatique de prisonniers différé** : `executeTowerCaptureHost` ne déclenche plus `_checkAndHandleReciprocalExchange` immédiatement — elle note l'info dans `gameState._pendingReciprocalCheck`, consommée uniquement par la nouvelle fonction exportée `checkPendingReciprocalExchange()`, appelée en fin de tour du capturant (au même point que `undoManager.reset()`, dans `GameEventSetup._installEndTurn` et `GameSyncCallbacks.onTurnEndRequest`) — une fois la capture non annulable. Raison : résoudre l'échange avant ce verrouillage aurait pu créer un état incohérent si le capturant annulait ensuite sa capture. **✅ FIX texte modale** : `showPrisonerExchangeModal` décrit désormais les deux sens de l'échange (le meeple que X récupère chez Y, ET le retour automatique du meeple que X vient de capturer chez Y via `freshlyCapturedType`) — auparavant seul le premier sens était mentionné dans le texte affiché, bien que les deux sens étaient déjà appliqués en interne. **Rachat de prisonnier** : inchangé dans son fonctionnement, migré vers `extraState.prisoners` |
| `TurnManager.js` | 415 | Gestion du tour courant, tour bonus |
| `UndoManager.js` | ~700 | Annulation d'actions du tour en cours. **✨ ÉTENDU (Extension Tour)** : `saveTurnStart`/`saveAfterTilePlaced`/`saveDragonMove` copient désormais `gameState.extraState` (deep copy, générique) et `player.towerPieces` en plus des champs déjà existants. `restoreExtraState(source)` restaure `gameState.extraState` génériquement (boucle sur `Object.keys`, sans connaître les sous-clés — voir section extraState) ; appelée par `restoreSnapshot()` (undo tuile/meeple/abbé) et `undoDragonMove()` (undo déplacement dragon — nécessaire car le dragon peut désormais manger un garde de tour). `restoreSnapshot()` réinitialise aussi explicitement `gameState._pendingTowerCapture`/`_pendingReciprocalCheck` (turn-scoped, non couverts par `extraState`). `applyLocally()` appelle un seul `d.renderAllTowersFromState?.()` générique en tête de fonction (avant le `switch` sur le type d'action), qui redessine l'état Tour quel que soit le type d'annulation — plus simple et plus sûr que de traiter chaque branche séparément. `applyRemote()` (invités) fait le même travail de restauration `extraState`/`towerPieces`/`_pending*` avant de déléguer à `applyLocally()` |
| `UnplaceableTileManager.js` | 401 | Gestion des tuiles implaçables |
| `ZoneMerger.js` | 720 | Fusionne les zones entre tuiles adjacentes |
| `ZoneRegistry.js` | 201 | Registre central des zones fusionnées |
| `ZoomManager.js` | 204 | Gestion du niveau de zoom |

## `modules/ui/` — Composants d'affichage

| Fichier | Lignes | Rôle |
|---|---|---|
| `GameMenuUI.js` | 49 | Menu en jeu |
| `LobbyJoin.js` | 168 | Logique de connexion en tant qu'invité |
| `LobbyNavigator.js` | ~185 | Retour au lobby / lobby initial ; réinitialise `towerRules` au retour lobby |
| `LobbyUI.js` | 356 | Interface du lobby |
| `MeepleActionsUI.js` | ~660 | Actions meeples : rappel abbé, portail, éjection princesse, placement fée ; orchestre l'extension Tour via les imports de `TowerUI.js`. `initNetworkMeepleListeners(eventBus)` protégée par flag module-level (`_networkListenersInstalled`) contre la double installation — voir "Piège récurrent" |
| `MeepleCursorsUI.js` | 455 | Curseurs de placement de meeple ; exclut la zone `tower` (et `dragon`/`volcano`/`portal`) des positions de meeple classiques |
| `MeepleDisplayUI.js` | 91 | Affichage visuel des meeples posés |
| `MeepleSelectorUI.js` | 333 | Sélecteur de type de meeple |
| `ModalUI.js` | 528 | Utilitaires génériques de modales |
| `ScorePanelUI.js` | ~500 | Panneau des scores (desktop + mobile). Lit désormais `gameState.extraState.prisoners[player.id]` (anciennement `gameState.prisoners[player.id]` directement — seule référence à migrer dans ce fichier). Sélection de prisonniers (mécanisme générique `enablePrisonerSelection`/`setBuybackHandler`), inchangée par ailleurs |
| `SlotsUI.js` | 234 | Slots de placement de tuile |
| `TilePreviewUI.js` | 65 | Aperçu de la tuile en main |
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
`tower`, certaines combinées à des zones city/road/field/garden/abbey classiques.

Cas particuliers notables dans `Deck.js` :
- `startType === 'river'` : tuile source (`river-01`) et embouchure (`river-12`) fixes, tuiles intermédiaires mélangées.
- `testMode` : deck réduit, parfois un ordre forcé.
- Tuile normale (`unique`) : `base-04` toujours forcée en première position après mélange.

---

## Extension Tour — Résumé fonctionnel

- **Activation** : case à cocher `tiles-tower` (tuiles) + `ext-tower` (règle),
  regroupées sous la coche maître `all-tower`.
- **Stock de pièces** : chaque joueur actif reçoit un nombre de pièces de tour
  selon le nombre de joueurs (`TOWER_PIECES_BY_PLAYER_COUNT`), attribué dans
  `GameStarter._initGameState()`.
- **Pose d'étage** : sur n'importe quelle tuile à zone `tower` non
  verrouillée, consomme une pièce du stock du joueur, incrémente
  `gameState.extraState.towers[x,y].height`. Consomme la "phase meeple" du
  tour.
- **Capture** : après la pose d'un étage, calcule les meeples capturables sur
  la tuile de la tour et en ligne continue dans les 4 directions jusqu'à
  distance = hauteur. Auto-capture → retour réserve. Capture d'un adversaire
  → prisonnier (`gameState.extraState.prisoners`), sauf échange automatique
  différé (voir ci-dessous). Nettoyage des Bâtisseurs/Cochons orphelins
  identique au Dragon.
- **Verrouillage** : à partir de 1 étage, n'importe quel joueur peut verrouiller
  une tour avec un meeple normal ou grand meeple (ressource personnelle
  consommée), ce qui l'exclut des tuiles éligibles à un nouvel étage.
  **✅ FIX** : interdit sur la tuile où se trouve actuellement le dragon
  (`gameState.dragonPos`), pour éviter de piéger le dragon sur une tour
  devenue immuable — masqué côté UI (`showTowerCursors`/`_openTowerFloorSelector`)
  et refusé côté autorité hôte (`TowerRules.lockTower`).
- **Interaction Dragon ↔ garde de tour** : **✅ FIX** — un garde qui verrouille
  une tour (vivant dans `gameState.extraState.towers[x,y]`, absent de
  `placedMeeples`) est désormais mangé par le dragon comme n'importe quel
  meeple classique lorsque celui-ci visite la tuile (`DragonRules._eatMeeplesAt`),
  avec retour à la réserve du joueur et déverrouillage de la tour. Le
  déplacement dragon correspondant est annulable comme les autres
  (`UndoManager.saveDragonMove`/`undoDragonMove` incluent désormais
  `gameState.extraState`).
- **Échange automatique de prisonniers** : après chaque capture non-auto,
  vérification de réciprocité entre le capturant (X) et le propriétaire
  capturé (Y) : Y détient-il déjà un ou plusieurs prisonniers de X ?
  - **Aucun** → rien de plus.
  - **Un seul type** → résolution automatique : ce type revient à X, le
    meeple fraîchement capturé par X retourne toujours à Y
    (`freshlyCapturedType`). Modale informative, bouton "Fermer".
  - **Plusieurs types** → X doit choisir (modale "Choisir" → panel de Y en
    mode sélection, voile gris).
  - **✨ Différé à la fin du tour** : la vérification elle-même
    (`_checkAndHandleReciprocalExchange`) n'est plus appelée immédiatement
    après la capture, mais par `checkPendingReciprocalExchange()` au moment
    où le tour du capturant se termine (`undoManager.reset()` — même point
    dans `GameEventSetup._installEndTurn` et `GameSyncCallbacks.onTurnEndRequest`).
    Tant que la capture reste annulable, `gameState._pendingReciprocalCheck`
    ne fait que noter l'info nécessaire ; résoudre l'échange avant que la
    capture soit verrouillée aurait pu créer un état de prisonniers
    incohérent (des deux joueurs) en cas d'annulation ultérieure.
  - **✅ FIX texte de la modale** : décrit désormais les deux sens de
    l'échange dans la même phrase (`showPrisonerExchangeModal`).
  - Non annulable en tant que tel (l'échange n'a lieu qu'une fois la capture
    déjà verrouillée par la fin du tour) — mais la capture qui le précède l'est.
- **Rachat de prisonnier** : disponible à tout moment de la partie, coût fixe
  `PRISONER_BUYBACK_COST` (3 points), transaction directe acheteur → capturant.
  Désactivé tant qu'un échange automatique est en attente, et tant que la
  capture concernée est "fraîche" (`gameState._freshCaptures`, vidé à chaque
  `'turn-changed'`).
- **Undo** : ✨ pleinement pris en charge — pose d'étage, capture, verrouillage
  et déplacement dragon ayant mangé un garde sont tous annulables comme les
  autres actions du tour (granularité "tout-en-un" : annuler après une
  capture Tour annule aussi la pose d'étage qui l'a précédée dans le même
  tour, cohérent avec le reste du système d'undo — voir `UndoManager.js`).
  L'échange automatique de prisonniers et le rachat restent hors du système
  d'undo (le premier ne peut de toute façon plus survenir tant que l'action
  qui le déclenche est encore annulable ; le second n'est pas lié à un tour).
- **Réseau** : architecture réactive identique aux autres actions (invité →
  requête, hôte → applique et broadcast, y compris echo à l'émetteur).
- **Reconnexion** : ✅ FIX — les tours et gardes de verrouillage sont
  désormais correctement redessinés (`ReconnectionManager.applyFullStateSync`
  → `renderAllTowersFromState`), alors qu'ils ne l'étaient jamais auparavant.
- **Scoring** : pas de points directement liés à la Tour — le seul bénéfice
  est l'avantage stratégique de capturer/neutraliser des meeples adverses.

---

## Extensions à venir (non commencées) — points d'attention déjà identifiés

Cette liste vient du travail préparatoire fait pendant le développement de la
Tour ; **rien de ce qui suit n'est implémenté**, c'est un aide-mémoire pour
éviter de re-découvrir les mêmes questions à chaque nouvelle extension. Voir
aussi la section `gameState.extraState` en tête de ce document.

| Extension | Nature | Piège(s) à anticiper |
|---|---|---|
| Maire, Chariot, Directeur | Meeple classique (`placedMeeples`, nouveau `type`) | Probablement le plus simple des trois — suivre le pattern Bâtisseur/Cochon (poids de majorité dans `MeepleUtils.getMeepleWeight`, exclusion des zones qui ne s'appliquent pas) |
| Berger + jetons moutons | Meeple (berger) + compteur non-meeple (moutons) | Le berger va dans `placedMeeples` ; les moutons vont dans `gameState.extraState.sheep` (compteur par position, pas un pion de joueur) — même logique de séparation que garde de tour / hauteur de tour |
| Grange | Pion posé à une intersection entre 4 tuiles | Ne rentre pas dans le format de clé `"x,y,position"` — nouveau schéma de clé nécessaire dans `extraState`, réfléchir à la représentation avant de coder |
| Pont | Pièce au centre d'une tuile, horizontal/vertical, modifie la connectivité des bords | Touche potentiellement `Tile.getEdgeType`/`Board.canPlaceTile`, pas seulement l'affichage — probablement le chantier le plus structurant de la liste |
| Forteresse | Modificateur de score attaché à une ville | Probablement une extension de `Scoring.js`/`InnsRules.js` plutôt qu'un nouveau pion — à confirmer selon la règle exacte |
| Zone à 3 meeples empilés | Remet en cause l'hypothèse "1 clé = 0 ou 1 meeple" de `placedMeeples` | Sujet à traiter à part avec un plan dédié avant tout code — impacte `ZoneMerger.getZoneMeeples`, `MeeplePlacement.canPlace`, `Scoring.js` |

---

## Aide au diagnostic — quel(s) fichier(s) regarder selon le symptôme

| Symptôme | Fichiers probables |
|---|---|
| Case à cocher du lobby ne se comporte pas comme prévu | `modules/LobbyOptions.js` |
| Meeple ne peut/peut être posé à tort quelque part | `modules/ui/MeepleCursorsUI.js`, `modules/game/ZoneMerger.js`, `modules/game/ZoneRegistry.js`, `modules/rules/*Rules.js`, `modules/MeepleUtils.js` |
| Tuile peut être posée alors qu'elle ne devrait pas (ou inversement) | `modules/ui/SlotsUI.js`, `modules/Board.js`, `modules/game/TilePlacement.js` |
| Bug lié au chargement/mélange/composition du deck | `modules/Deck.js` |
| Bug spécifique Dragon/Fée/Princesse/Portail | `modules/game/DragonUI.js`, `modules/rules/DragonRules.js`, `modules/rules/DragonConfig.js`, `modules/game/GameSyncCallbacks.js` |
| Bug spécifique Tour (pose d'étage, capture, verrouillage, stock de pièces) | `modules/game/TowerUI.js`, `modules/rules/TowerRules.js`, `modules/rules/TowerConfig.js`, `modules/GameState.js` (`extraState.towers`/`extraState.prisoners`), `modules/game/GameSyncCallbacks.js`, `modules/ui/MeepleActionsUI.js` |
| Interaction Dragon / garde de tour (capture, blocage verrouillage) | `modules/rules/DragonRules.js` (`_eatMeeplesAt`), `modules/game/DragonUI.js` (`executeDragonMoveHost`), `modules/rules/TowerRules.js` (`lockTower`), `modules/game/TowerUI.js` (`showTowerCursors`/`_openTowerFloorSelector`) |
| Bug spécifique à l'échange automatique de prisonniers (y compris timing/annulation) | `modules/game/TowerUI.js` (`executeTowerCaptureHost`, `checkPendingReciprocalExchange`, `_checkAndHandleReciprocalExchange`, `applyPrisonerExchangeResolved`, `applyPrisonerExchangePending`), `modules/rules/TowerRules.js` (`checkReciprocalCapture`), `modules/ui/ScorePanelUI.js`, `modules/core/GameSync.js`/`modules/game/GameSyncCallbacks.js`, `modules/GameState.js` (`_pendingReciprocalCheck`) |
| Bug spécifique au rachat de prisonnier | `modules/game/TowerUI.js` (`setupPrisonerBuyback`, `executePrisonerBuybackHost`), `modules/rules/TowerConfig.js`, `modules/ui/ScorePanelUI.js`, `modules/game/Scoring.js`/`modules/game/FinalScoresManager.js` |
| Bug d'annulation (undo) qui touche l'extension Tour (étage/capture/verrouillage/dragon-mange-garde non restauré) | `modules/game/UndoManager.js` (`restoreExtraState`, `saveTurnStart`/`saveAfterTilePlaced`/`saveDragonMove`, `applyLocally`), `modules/game/TowerUI.js` (`renderAllTowersFromState`), `modules/game/GameModuleInitializer.js` (câblage de la dépendance) |
| Bug de reconnexion où un état d'extension (Tour ou future) n'apparaît pas chez l'invité reconnecté | `modules/game/ReconnectionManager.js` (`applyFullStateSync`) — vérifier qu'un rendu `renderAllXxxFromState()` est bien appelé pour cette extension, comme pour Dragon/Fée/Tour |
| Un événement réseau semble appliqué plusieurs fois (état dupliqué), surtout après un retour lobby + nouvelle partie, et seulement côté invité | Section "⚠️ Piège récurrent — `eventBus` singleton" en tête de ce document |
| Désynchronisation réseau hôte/invité | `modules/core/GameSync.js`, `modules/game/GameSyncCallbacks.js`, `home.js` |
| Déconnexion/reconnexion/pause | `modules/game/ReconnectionManager.js`, `modules/core/HeartbeatManager.js` |
| Score incorrect | `modules/game/Scoring.js`, `modules/game/ZoneMerger.js`, `modules/game/ZoneRegistry.js`, `modules/MeepleUtils.js` |
| Annulation d'action (undo) qui se comporte mal, hors extension Tour | `modules/game/UndoManager.js` |
| Je démarre une nouvelle extension avec un pion/compteur/structure persistant | Lire d'abord la section "⚠️ `gameState.extraState`" en tête de ce document, puis "Extensions à venir" pour les pièges déjà identifiés sur cette extension précise |
| Modale/texte d'interface à modifier | `index.html` (texte statique) ou le manager JS correspondant si dynamique |
