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

## ⚠️ Changement d'hôte en cours de partie (`HostMigration`)

> **Lot 1 livré : partie en cours.** Le lobby (hôte qui quitte le salon) est prévu au lot 2 —
> tant qu'il n'est pas fait, le comportement lobby reste l'ancien (salon fermé).

### Principe

- L'ID PeerJS d'un joueur = son code à 6 chiffres. L'hôte l'a toujours eu ; **les invités aussi
  désormais** (`Multiplayer._openGuestPeer`, réessai si collision). L'id d'un invité promu
  devient donc directement le **nouveau code de partie**. On ne tente **jamais** de récupérer
  l'ancien code (un seul numéro à la fois, aucune course avec le serveur PeerJS).
- **Snapshot** : à chaque `GameSync.syncTurnEnd` (la tuile suivante est déjà piochée), l'hôte
  diffuse `host-snapshot` = paquet identique à `full-state-sync` (construit par
  `GameSync.buildFullStateMessage`, arguments via `ReconnectionManager.collectFullStateArgs`)
  + `hostId` + `candidates` (successeurs possibles, dans l'ordre de `gameState.players`,
  hors spectateurs/déconnectés/exclus). Les invités gardent le dernier en mémoire.
- **Détection** (invité) : fermeture de la connexion hôte (`Multiplayer.onHostDisconnected`,
  uniquement pour `hostPeerId`), erreur réseau PeerJS, ou heartbeat muet (le heartbeat
  invité était un no-op en partie, corrigé). Tout passe par `ReconnectionManager._notifyHostLost`
  → `HostMigration.onHostLost`. Sans snapshot (début de partie) : ancien comportement
  (`startAutoReconnect`).
- **Élection déterministe, sans communication** : chaque invité parcourt `[hostId, ...candidates]` ;
  pour chaque cible il tente de la rejoindre pendant `HOST_GRACE_MS` (même peer, même id réseau,
  `Multiplayer.reconnectTo`) ; quand il arrive à **son propre id** dans la liste, il se promeut.
  Un succès exige aussi la confirmation `game-in-progress` de la cible (sinon canal ouvert vers
  un pair qui n'écoute pas encore). Fenêtre totale pour le k-ième successeur : (k+1) × grâce.
- **Promotion** (`HostMigration._promote`, bloc synchrone) : adapte le snapshot (ancien hôte
  marqué `disconnected`+`kicked`, son tour sauté si c'était lui — la tuile déjà piochée passe
  au joueur suivant), `isHost=true` partout (`home.js`, `gameSync.isHost`, `turnManager.isHost`,
  `Multiplayer.prepareHostTakeover`), `applyFullStateSync(snapshot)`, puis réinstalle ce qu'un
  hôte doit avoir : `attachGameSyncCallbacks()` (callbacks hôte, dont tous les handlers
  invité→hôte d'`_attachHostCallbacks`), `initInGameNetworkHandler` (heartbeat hôte, `player-info`),
  menu, et **en dernier** `Multiplayer.startAccepting()`. Snapshot de rattrapage 5 s plus tard.
- **Ancien hôte isolé** (option B) : si c'est l'hôte qui perd internet, il le détecte
  (`window 'offline'`, ou `ReconnectionManager._isHostIsolated()` dans `handleDisconnect` : appareil
  hors ligne / peer déconnecté de la signalisation) au lieu de croire que ses invités sont partis →
  `HostMigration.onSelfIsolated()` : overlay « Connexion perdue », aucun joueur marqué déconnecté,
  pas de « Partie en pause », reconnexion à la signalisation sous le **même id**
  (`Multiplayer.ensurePeerReady`, et `_installHostKeepAlive` qui relance `peer.reconnect()` tant que
  le peer hôte est déconnecté). Deux issues :
  1. il retrouve internet **avant** la fin du délai de grâce des invités → ils le rejoignent
     (CAS 5), la partie continue chez lui (seule une connexion **nouvelle** compte : les anciennes,
     mortes mais encore marquées ouvertes, sont ignorées — `_staleConns`) ;
  2. sinon le **nouvel hôte** sonde l'ancien id toutes les 3 s (`_probeOldHost`, 15 min max, via
     `Multiplayer.notifyPeer`, connexion brute non enregistrée) et lui envoie `host-moved` +
     nouveau code. L'ancien hôte (`HostMigration.onHostMoved`, `GameSync.onHostMoved`) abandonne la
     connexion de notification (sinon son `return-to-lobby` atteindrait le nouvel hôte), quitte
     son rôle (`returnToInitialLobby`) et rejoint automatiquement (`home.js` `_rejoinAsGuest` :
     code saisi + `window._isAutoReconnecting = true` + `_doJoin`) → CAS 3 (même pseudo, joueur
     `kicked`) → `full-state-sync`. S'il reste introuvable 90 s après le retour du réseau : lobby avec message.
  **Isolement détecté aussi APRÈS une courte coupure** : `Multiplayer.lastSelfOutageAt` (événements
  offline/online, signalisation PeerJS perdue/rétablie) ouvre une fenêtre de 45 s pendant laquelle
  `_isHostIsolated()` reste vrai — le heartbeat (timeout 30 s) peut en effet « timeout » les invités
  *à cause de la coupure de l'hôte*, juste après le retour du réseau. L'isolement se termine dès
  qu'un invité est réellement joignable (`_guestAlive` : connexion nouvelle, ou ancienne connexion
  ayant de nouveau reçu un pong depuis le début de l'isolement — une ancienne connexion morte mais
  encore « ouverte » ne compte pas). 15 s plus tard, `_scheduleSweep` signale déconnectés (`onPlayerLeft(id, true)`,
  `force` = sans ré-évaluer l'isolement) les invités qui n'ont pas redonné signe de vie.
  Un invité **hors ligne** n'élit personne : `_waitOnline` attend le retour du réseau, puis lance
  l'élection (auparavant : reconnexion automatique en boucle).
- **Retour des autres invités** : ils gardent leur id réseau → le nouvel hôte les traite en
  **CAS 5** de `initInGameNetworkHandler` (même id : réactivation + `sendFullStateTo`, sans remap).
  L'ancien hôte, s'il revient avec le même pseudo et le **nouveau code**, passe par le CAS 3.
- **État restauré = début du tour en cours** (le dernier snapshot). Tout ce qui s'est passé
  depuis (tuile posée, meeple, etc.) est perdu ; l'annulation du tour repart de zéro.

### Constantes / tests

- `HOST_GRACE_MS` (`HostMigration.js`) : **5000 en phase de test, à passer à 20000 ensuite.**
- `PROBE_INTERVAL_MS` (3 s) / `PROBE_MAX_MS` (15 min) : sondage de l'ancien hôte par le nouvel hôte ;
  `ISOLATION_RESTORED_WAIT_MS` (90 s) : attente maximale de l'ancien hôte après le retour du réseau.
- L'affichage du code (menu en jeu, lobby) est rafraîchi par `home.js` `_refreshGameCodeDisplays()`
  à chaque `setGameCode` de `HostMigration` (promotion et reconnexion à un nouvel hôte).
- Logs horodatés préfixés `[MIGRATION]` (récupérables via le bouton 📥) pour mesurer les délais réels.

### Limites connues

- Après une promotion, le **retour lobby du nouvel hôte** n'est pas géré (le handler lobby hôte
  `_hostLobbyHandler` est défini dans le clic « Créer une partie » de `home.js`) — lot 2.
- **Rôle spectateur à la reconnexion** : `LobbyJoin` envoie désormais `isSpectator` selon la couleur
  du joueur (`'spectator'`) lors d'une reconnexion automatique. Auparavant toujours `false` : un
  spectateur retiré de `gameState` par l'hôte (timeout) revenait comme NOUVEAU JOUEUR → « Partie
  complète » → refus, et la modale de reconnexion restait affichée.
- **`rejoin-rejected` en partie** : `GameSync` intercepte ce message (il fait partie de
  `_isGameMessage`) avant le handler lobby ; `home.js` branche `gameSync.onRejoinRejected` (retire
  l'overlay de reconnexion, retour au lobby avec le motif).
- **État « déconnecté » propagé à tous** : `buildPlayersForBroadcast()` joint `disconnected` (lu dans
  `gameState`) à chaque joueur de `players-update`, et le handler invité de `ReconnectionManager`
  l'applique (y compris pour le remettre à `false`). Sans cela, avec le CAS 5 (même id, donc pas de
  changement d'id pour signaler le retour), les invités reconnectés avant un autre joueur le
  voyaient « déconnecté » indéfiniment (leur `full-state-sync` le décrivait ainsi, et rien ne
  corrigeait ce drapeau ensuite).
- **Délai de détection dominé par le heartbeat** : mesuré en test réel (coupure internet de
  l'hôte), la fermeture du canal WebRTC n'est pas détectée ; c'est le heartbeat (`HeartbeatManager`,
  timeout 30 s) qui déclenche la procédure, soit ≈ 30 s + `HOST_GRACE_MS` avant que le nouvel hôte
  soit opérationnel. Réduire `_TIMEOUT` (partagé avec le lobby) raccourcirait ce délai.
- Un ancien hôte dont la **page est fermée/rechargée** n'est pas joignable par le sondage : il
  doit saisir lui-même le nouveau code (même pseudo → CAS 3).
- **Horloges** : les logs de l'ancien et du nouvel hôte proviennent de deux appareils dont les
  horloges peuvent différer de plusieurs dizaines de secondes (≈ 29 s constatées mobile/PC) — les
  rapprocher par un événement commun (ex. un placement de meeple) avant de les comparer.
- Une phase dragon en cours n'est pas snapshotée (seuls les `syncTurnEnd` le sont) : restauration
  à la fin du dernier tour complet.
- Si l'id réseau d'un successeur change à la promotion (id déjà pris, très rare), les autres
  invités le cherchent sous l'ancien id.
- `extraState.towers.lockedBy`, `prisoners`, `fairyState.ownerId` référençant l'ancien hôte
  restent pointés vers lui (joueur `kicked`) tant qu'il ne revient pas (CAS 3 remappe alors
  prisonniers/échange en attente, comme pour toute reconnexion).
- Pas de persistance : si **tous** les joueurs quittent, la partie est perdue.

### Check-list à chaque nouvelle extension

1. **État transitoire à faire survivre** : le snapshot = paquet de reconnexion. Tout champ
   ajouté au full-state (`GameSync.buildFullStateMessage`, `ReconnectionManager.collectFullStateArgs`/
   `applyFullStateSync`) est automatiquement couvert **à la fois** par la reconnexion et par le
   changement d'hôte. Ce qui est dans `gameState.serialize()` (dont `extraState`) l'est déjà.
2. **Handlers lobby invité au bas de la chaîne réseau** : un invité promu hôte conserve
   `LobbyJoin.lobbyHandler` (via `GameSync.originalHandler`) sous ses handlers hôte. Tout message
   que ce handler traite doit être inoffensif pour un hôte (voir la garde `isHost` sur
   `game-in-progress`, et celle sur `welcome` en partie), et seul l'hôte courant doit envoyer
   `game-in-progress` (`ReconnectionManager`, `onPlayerJoined`).
3. **Nouveau message invité → hôte** : à gérer dans `GameSyncCallbacks._attachHostCallbacks` (ou le
   `switch` de `GameSync`) — repris sans travail en plus, car la promotion rappelle `attachGameSyncCallbacks()`.
4. **Variables « hôte » vivant dans `home.js` hors `gameState`** (comme `currentTileForPlayer`) :
   si l'hôte en dépend, les réaffecter dans `HostMigration._promote`.
5. **Id de joueur mémorisé hors de `players`** : les invités gardent leur id ; seul l'id de
   l'ancien hôte « disparaît » (joueur `kicked`). Vérifier qu'aucun traitement n'attend que cet id soit actif.
6. **Tout nouveau `Multiplayer.onXxx` ou `peer.on(...)`** doit rester cohérent avec `isHost` qui peut
   passer à `true` en cours de vie du peer (voir la garde `!this.isHost` dans `joinGame`).

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
  `extraState` ne les couvre pas automatiquement. Le même principe s'applique
  à un compteur "une fois par tour" qui n'est pas turn-scoped au sens d'une
  capture en attente, mais qui doit néanmoins être remis à zéro précisément —
  voir `gameState._turnBuybackUsed` (rachat de prisonnier) ci-dessous et dans
  la section Tour : reset conditionné à un événement précis (ici, l'entrée
  dans un véritable nouveau tour), pas seulement à `'turn-changed'` en général.
  Si ta mécanique bloque le jeu tant qu'un choix n'est pas fait (comme
  l'échange automatique de prisonniers ci-dessous), pense aussi aux angles
  morts réseau à couvrir explicitement : vraie déconnexion/exclusion du joueur
  qui doit choisir (résolution automatique, avant toute mutation de
  `gameState.players`), reload de page de ce même joueur (l'état `_pending*`
  n'est pas sérialisé, donc perdu localement — à retransmettre explicitement
  via `syncFullState` et à restaurer après `applyFullStateSync`), et
  reconnexion du même joueur avec un nouveau `playerId` réseau (remap de
  toutes les références à l'ancien id dans cet état `_pending*`, au même point
  que le remap déjà fait pour `placedMeeples[].playerId`).
- **Différer une conséquence non-annulable** (comme l'échange automatique de
  prisonniers) : si une action de ta nouvelle mécanique déclenche un effet qui
  mute l'état d'un **autre** joueur (pas seulement le joueur actif), différer
  cet effet à la fin du tour (voir `TowerUI.checkPendingReciprocalExchange`,
  branché aux mêmes deux points que pour la Tour — `GameEventSetup._installEndTurn`
  et `GameSyncCallbacks.onTurnEndRequest`, juste après `undoManager.reset()`)
  plutôt que de le résoudre immédiatement, pour ne pas le rendre incohérent
  avec une éventuelle annulation de l'action qui l'a déclenché. **Attention** :
  si cet effet différé peut lui-même nécessiter un choix du joueur (donc
  bloquer le jeu au-delà de la simple différence — voir le point suivant),
  le tour SUIVANT démarre déjà avant que ce choix soit fait, puisque la
  vérification n'a lieu qu'après `undoManager.reset()`, qui précède la suite
  de la fin de tour (changement de joueur, pioche). Voir "Blocage tant qu'un
  choix n'est pas fait" ci-dessous.
- **Blocage tant qu'un choix n'est pas fait** : si l'effet différé ci-dessus
  peut demander un choix au joueur concerné (plusieurs issues possibles), ce
  choix doit bloquer la suite du jeu pour tout le monde jusqu'à sa résolution
  — sinon le tour suivant démarre pendant que l'état reste incohérent (cf.
  l'échange automatique de prisonniers, section Tour ci-dessous, qui a
  d'abord été livré sans ce blocage). Pattern adopté : la modale/l'UI de
  choix devient **non fermable** pour tout le monde sauf le joueur concerné
  tant que le choix n'est pas fait (aucun bouton "Fermer" affiché), combiné à
  trois résolutions explicites pour ne jamais bloquer indéfiniment : (1) une
  vraie déconnexion/exclusion du joueur concerné doit résoudre le choix
  automatiquement selon une règle par défaut raisonnable (ex: l'entrée la
  plus ancienne) ; (2) un reload de page de ce joueur doit restaurer puis
  réafficher l'état de choix, cet état étant transitoire donc non couvert par
  `gameState.serialize()`/`deserialize()` ; (3) une reconnexion de ce même
  joueur avec un nouveau `playerId` réseau doit remapper les références à
  l'ancien id dans cet état, sans quoi il ne se reconnaîtrait plus comme "le
  joueur qui doit choisir" après reconnexion. Voir l'implémentation complète
  dans la section Tour ci-dessous (`resolvePendingPrisonerExchangeForPlayer`,
  `restorePendingPrisonerExchangeUI`, `remapPendingPrisonerExchangeAndPrisoners`)
  comme modèle direct pour toute mécanique similaire.
- **Interaction avec un pion générique existant (fée, dragon...)** : si un
  pion générique (la fée, par exemple) doit pouvoir cibler ta nouvelle pièce
  d'`extraState`, il faut lui donner une clé identifiable distincte du format
  `"x,y,position"` de `placedMeeples` (voir la convention `"tower-lock:x,y"`
  ci-dessous pour le garde de tour) et mettre à jour **chaque** endroit qui
  traite une clé de pion générique en supposant implicitement le format
  classique — l'exercice fait pour la fée et la Tour (détaillé dans la
  section "Interaction Dragon ↔ garde de tour" plus bas) est un bon modèle
  de la liste des points à parcourir.
- **Sélection dans un panel joueur pendant une action bloquante** (comme le
  choix d'un prisonnier à récupérer) : si ta mécanique a elle aussi besoin de
  faire choisir un joueur parmi des entrées affichées dans le panel d'un
  autre joueur, réutilise `ScorePanelUI.enablePrisonerSelection()` /
  `forceOpenPlayerPanel()` (voir "Sélection de prisonniers" dans le tableau
  `modules/ui/` plus bas) plutôt que d'inventer un nouveau mécanisme — le
  masquage/mise en avant des panels (voile assombri, panel cible entièrement
  visible sous calque sombre sauf prisonniers sélectionnables, panel du choisisseur assombri
  localement sur desktop, autres panels masqués) est déjà générique et ne
  demande aucune modification pour une nouvelle ligne de contenu dans le
  panel (cf. règles CSS `.prisoner-selection-target`/`.prisoner-selection-chooser`/
  `.prisoner-selection-hidden` dans `style.css`).

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
| `index.html` | 494 | Structure DOM complète (lobby, plateau, modales, badge dragon, sélecteurs, section extension Tour, modale + voile gris d'échange automatique de prisonniers, modale de confirmation de rachat de prisonnier). Le voile de sélection de prisonnier (`#prisoner-selection-overlay`) est à `rgba(0,0,0,0.9)` (assombri, anciennement 0.7) |
| `style.css` | ~1620 | Tous les styles, dont le masquage/mise en avant des panels pendant une sélection de prisonnier (`.prisoner-selection-target`/`.prisoner-selection-chooser`/`.prisoner-selection-hidden`, voir plus bas) |
| `home.js` | ~1540 | **✨ Changement d'hôte** : instancie `HostMigration` (`_getHostMigration`), l'`install()` dans `attachGameSyncCallbacks`, le `reset()` dans `destroyGameModules`, route `onHostLost` vers `ReconnectionManager`, et expose `_buildInGameNetworkDeps()` (deps in-game extraites de `_makeStarter` pour être réutilisées par la promotion). Chef d'orchestre : état global, listeners `eventBus` (singleton — voir section "Piège récurrent" ci-dessus), init lobby, `startGame`/`startGameForInvite`. Le handler `network-dragon-state-update` retire désormais aussi le pion `.tower-lock-meeple` d'un garde de tour mangé par le dragon (auparavant seul l'hôte le faisait — cf. section "Interaction Dragon ↔ garde de tour"), et re-synchronise le rendu visuel de la fée depuis `gameState.fairyState` reçu de l'hôte. Le listener `'turn-changed'` réinitialise désormais aussi `gameState._turnBuybackUsed` (rachat de prisonnier — une seule rançon par tour), mais uniquement lorsque le tour qui commence n'est PAS un tour bonus (`turnManager.isBonusTurn === false`). Injecte désormais trois nouvelles dépendances liées au blocage de l'échange automatique de prisonniers (voir section Tour) : `resolvePendingPrisonerExchange` (vers `ReconnectionManager`), `restorePendingPrisonerExchangeUI` (vers `ReconnectionManager.initStateHandlers`), `remapPendingPrisonerExchange` (vers `ReconnectionManager.initInGameNetworkHandler`) |
| `version.js` | — | Constante `APP_VERSION` |

---

## `modules/` (racine du dossier modules)

| Fichier | Lignes | Rôle |
|---|---|---|
| `Board.js` | 121 | Modèle du plateau : `placedTiles`, `isFree`, `canPlaceTile` (check géométrique, ne connaît pas les règles spéciales type "dragon sans volcan") |
| `Deck.js` | 217 | Chargement des tuiles (`loadAllTiles`, fetch parallèle par groupe depuis `data/{Groupe}/{id}.json`, y compris `data/Tower/` si `tileGroups.tower`), mélange, pioche, `reshuffleDragonTile()` |
| `GameState.js` | ~245 | État global : joueurs (dont `towerPieces` par joueur), `dragonPos`, `dragonPhase`, `fairyState` (le champ `meepleKey` peut désormais valoir soit une clé classique `"x,y,position"`, soit `"tower-lock:x,y"` — voir `isFairyOnTile`, mis à jour pour reconnaître ce second format), `currentTilePlaced`, `destroyedTilesCount`, **`extraState`** (conteneur générique — voir section dédiée en tête de ce document — contenant aujourd'hui `towers` et `prisoners`), `_pendingTowerCapture`, `_pendingReciprocalCheck` (échange automatique différé à la fin du tour du capturant — voir plus bas), `_pendingPrisonerExchange` (choix en attente — désormais aussi transporté par `GameSync.syncFullState` et restauré à la reconnexion, voir section Tour), `_freshCaptures` (captures du tour en cours pas encore validées, bloque temporairement leur rachat), `hasPrisonerBuybacks` (flag sérialisé), **`_turnBuybackUsed`** (transitoire, non sérialisé — une seule rançon de prisonnier autorisée par tour de jeu, un tour bonus comptant comme la suite du tour précédent ; remis à `false` uniquement à l'entrée d'un véritable nouveau tour, cf. `home.js` listener `'turn-changed'`) |
| `LobbyOptions.js` | 548 | Cases à cocher du lobby (extensions, presets, coches maîtres — dont "Tour" / `all-tower`, `tiles-tower`, `ext-tower`), `localStorage`, sync réseau |
| `MeepleConfig.js` | 134 | Tailles/configuration des meeples (`getMeepleSize`) |
| `MeepleUtils.js` | 21 | Utilitaires génériques meeples — poids pour calcul de majorité (Grand Meeple = 2, Bâtisseur/Cochon = 0, Normal/Abbé = 1) |
| `Tile.js` | 100 | Modèle d'une tuile : zones, rotation, traduction des edges selon rotation |

## `modules/core/` — Infrastructure bas niveau

| Fichier | Lignes | Rôle |
|---|---|---|
| `EventBus.js` | 117 | Bus d'événements interne (`on`/`off`/`emit`). **Singleton créé une fois dans `home.js`, jamais recréé** — voir la section "Piège récurrent" en tête de ce document avant d'y ajouter un `eventBus.on(...)` dans une fonction rappelée à chaque partie |
| `GameSync.js` | ~810 | **✨ Changement d'hôte** : message `host-snapshot` (`syncHostSnapshot`, callback `onHostSnapshot`), hook `onTurnEndSynced` appelé à la fin de `syncTurnEnd`, message `host-moved` (`onHostMoved`, reçu par l'ancien hôte), `buildFullStateMessage(args)` (paquet d'état complet partagé entre `syncFullState` et le snapshot). Sérialisation/synchronisation réseau hôte↔invités, y compris les messages `tower-floor-placed`, `tower-capture-executed`, `tower-lock-executed`, `prisoner-exchange-resolved`/`prisoner-exchange-pending` (échange automatique de prisonniers, avec le champ `freshlyCapturedType`) et `prisoner-buyback-executed` (rachat de prisonnier, hôte → tous). `syncFullState`/le message `turn-undo` transportent `gameState.serialize()`/`postUndoState`, qui incluent tous deux `extraState` sans logique dédiée dans ce fichier (transport générique, cf. section extraState). **✅ FIX NOUVEAU** : `syncFullState` transporte désormais explicitement `pendingPrisonerExchange: gameState._pendingPrisonerExchange ?? null` en plus des champs sérialisés — ce champ étant transitoire (non couvert par `gameState.serialize()`), un client qui recharge sa page pendant qu'un choix d'échange automatique de prisonniers est en attente perdait cet état localement (voir section Tour, "Blocage tant que le choix n'est pas fait") |
| `HeartbeatManager.js` | 63 | Détection de déconnexion (ping/pong) |
| `Multiplayer.js` | ~340 | Connexion P2P, broadcast, sendTo. **✨ Changement d'hôte** : les invités s'enregistrent sous un code à 6 chiffres (`_openGuestPeer`, réessai si `unavailable-id`) ; `reconnectTo(hostId)` (même peer/même id), `ensurePeerReady()`, `prepareHostTakeover()` + `startAccepting()` (promotion en hôte), `hostPeerId` (`onHostDisconnected` ne se déclenche que pour l'hôte courant), `_installHostKeepAlive` (l'hôte se reconnecte à la signalisation), `resumeAccepting()`, `notifyPeer(id, msg)` (message ponctuel par connexion brute non enregistrée), connexions abandonnées marquées `_replaced` (événement `close` ignoré), `_listenIncoming` : une connexion entrante du même pair remplace l'ancienne si elle date de plus de 3 s |
| `RuleRegistry.js` | 165 | Active/désactive les règles d'extension |

## `modules/rules/` — Règles de score/placement par extension

| Fichier | Lignes | Rôle |
|---|---|---|
| `AbbeRules.js` | 86 | Règles de l'Abbé (placement, rappel, comptage points) |
| `BaseRules.js` | 74 | Règles de base (villes, routes, champs) |
| `BuilderRules.js` | 313 | Règles Bâtisseur / Cochon / Marchands |
| `DragonConfig.js` | 42 | Constantes extension Dragon : `DRAGON_EDIBLE_MEEPLES`, `FAIRY_ATTACHABLE_MEEPLES` |
| `DragonRules.js` | ~410 | Règles extension Dragon (déplacement, cible Princesse, etc.). **✅ FIX** : `getFairyTargets(playerId)` inclut désormais un éventuel garde du joueur verrouillant une tour (`gameState.extraState.towers`, clé spéciale `"tower-lock:x,y"`), en plus des meeples classiques de `placedMeeples` — auparavant la fée ne pouvait jamais être attachée à un garde de tour, cf. section "Interaction Dragon ↔ garde de tour". **✅ FIX** : `_eatMeeplesAt(x, y)` mange désormais aussi un garde verrouillant une tour présent sur la tuile visitée (lu dans `gameState.extraState.towers[x,y]`, absent de `placedMeeples`) — auparavant le dragon l'ignorait complètement — **et détache la fée si elle y était attachée** (`ownerId = null`, `meepleKey` conservé — même logique que pour un meeple classique mangé, ci-dessus dans la boucle ; la fée ne disparaît jamais une fois posée). Le meeple est toujours rendu à la réserve du joueur (jamais capturé comme prisonnier Tour, cohérent avec le comportement du dragon sur un meeple classique), et la tour est déverrouillée dans la foulée. Traité avec la clé spéciale `tower-lock:x,y` (même convention que `TowerRules.getCaptureTargets`), résolue côté visuel par `DragonUI.executeDragonMoveHost` |
| `InnsRules.js` | 127 | Règles Auberges & Cathédrales |
| `TowerConfig.js` | 42 | Constantes extension Tour : `TOWER_PIECES_BY_PLAYER_COUNT`, `TOWER_CAPTURABLE_MEEPLES`, `TOWER_LOCK_MEEPLES` (réservé), `PRISONER_BUYBACK_COST`, helpers `getTowerPiecesForPlayerCount()` / `isTowerCapturable()` |
| `TowerRules.js` | ~230 | Règles extension Tour, lisant/mutant désormais `gameState.extraState.towers`/`gameState.extraState.prisoners` (anciennement `gameState.towers`/`gameState.prisoners` directement — voir section extraState). Détection des tuiles à zone `tower`, pose d'étage (`addFloor`), calcul de la portée de capture (`getCaptureTargets`), exécution de capture (`executeCapture`), verrouillage d'une tour (`lockTower` — refuse le verrouillage sur la tuile où se trouve actuellement le dragon, `gameState.dragonPos`, même principe d'exclusion que `DragonRules.getPortalTargets` pour le portail ; ne s'applique volontairement qu'au verrouillage, aucune règle ne restreint la simple pose d'un étage), et `checkReciprocalCapture` (détection de réciprocité pour l'échange automatique de prisonniers — le tableau de types distincts retourné préserve l'ordre chronologique de capture grâce à l'ordre d'insertion de `extraState.prisoners`, ce qui permet de désigner sans tri supplémentaire "le prisonnier le plus ancien" en cas de résolution automatique, cf. section Tour) |

## `modules/game/` — Logique de partie côté client

| Fichier | Lignes | Rôle |
|---|---|---|
| `DragonUI.js` | ~500 | Détection zones dragon/volcan/portail, affichage pion dragon/fée, curseurs de déplacement. **✅ FIX** : `renderFairyPiece(meepleKey)` gère désormais le format spécial `"tower-lock:x,y"` (fée attachée à un garde de tour) en s'ancrant sur `TowerUI.getTowerLockMeepleAnchor(x, y)` au lieu du calcul en grille 5×5 utilisé pour un meeple classique — import à sens unique depuis `TowerUI.js`, aucun cycle introduit (`TowerUI.js` n'importe rien de ce fichier). **✅ FIX** : `executeDragonMoveHost` reconnaît les clés préfixées `tower-lock:x,y` (garde de tour mangé par `DragonRules._eatMeeplesAt`) et retire le bon élément visuel (`.tower-lock-meeple`) au lieu de chercher un `.meeple[data-key]` inexistant, puis re-synchronise le rendu de la fée depuis `gameState.fairyState` (nécessaire car la fée peut désormais disparaître avec un garde mangé, sans que son propre pion visuel soit retiré autrement) |
| `FinalScoresManager.js` | 292 | Calcul et affichage des scores de fin de partie |
| `GameEventSetup.js` | ~510 | Installe tous les listeners DOM du jeu. Point de fin de tour (`_installEndTurn`) : appelle désormais `d.checkPendingReciprocalExchange?.()` juste après `undoManager.reset()` (échange automatique de prisonniers différé — voir plus bas) ; `_installUndo` inclut `extraState` et `towerPieces` dans le `postUndoState` envoyé aux invités. Utilise déjà le pattern de garde contre la double installation (flag `_installed`) |
| `GameModuleInitializer.js` | ~185 | Instancie les modules UI de jeu, dont `TowerRules` si `tileGroups.tower && extensions.tower`. Relaie `renderAllTowersFromState` (via `d`) dans `undoManager.initVisualHandlers({...})`, pour que l'undo puisse redessiner l'état Tour après restauration |
| `GameStarter.js` | 200 | Démarrage de partie hôte/invité ; attribue `towerPieces` à chaque joueur actif selon `getTowerPiecesForPlayerCount()` ; appelle `initTowerUI()` en `postStartSetup()` |
| `HostMigration.js` | ~420 | **✨ NOUVEAU** — Changement d'hôte en cours de partie : snapshot (hôte), détection/grâce/élection (invités), promotion, sondage de l'ancien hôte (`_probeOldHost`), mode isolement de l'ancien hôte (`onSelfIsolated`) et son retour (`onHostMoved`). Voir la section dédiée en tête de ce document. `HOST_GRACE_MS` = 5000 en test (20000 ensuite) |
| `GameSyncCallbacks.js` | ~490 | Callbacks réseau réactifs. `onTurnEndRequest` (hôte, pour un invité qui termine son tour) appelle `checkPendingReciprocalExchange()` juste après `undoManager.reset()` — même point que côté hôte-joueur dans `GameEventSetup`. `onUndoRequest` (hôte, pour un invité qui annule) inclut `extraState` et `towerPieces` dans le `postUndoState` envoyé. Relais des requêtes invité→hôte `tower-floor-request`/`tower-capture-request`/`tower-lock-request`/`prisoner-exchange-choice-request`/`prisoner-buyback-request` |
| `GameTimer.js` | 59 | Chronomètre de partie |
| `MeeplePlacement.js` | 253 | Logique de pose de meeple |
| `NavigationManager.js` | 161 | Zoom et déplacement (pan) sur le plateau |
| `ReconnectionManager.js` | ~800 | **✨ Changement d'hôte** : `collectFullStateArgs()` (extrait de `sendFullStateTo`), `_notifyHostLost()` (route vers `HostMigration`, dep constructeur `onHostLost`), `_clearBoardDom()` appelé par `applyFullStateSync` (évite les doublons d'éléments quand l'état est appliqué sur une page déjà en jeu), heartbeat invité désormais actif (hôte muet → `_notifyHostLost`), **CAS 5** de `initInGameNetworkHandler` (joueur qui revient avec le même id réseau ; le handler `players-update` invité applique aussi `disconnected`), `handleDisconnect(peerId, force)`, `_isHostIsolated()` + dep `onHostIsolated` (l'hôte isolé n'exclut/met en pause personne), seul l'hôte courant envoie `game-in-progress`. Pause/reprise de partie, resynchronisation complète. `applyFullStateSync` : appelle `d.renderAllTowersFromState?.()` (si `tileGroups.tower`) juste après le rendu Dragon/Fée. **✅ FIX NOUVEAU** : `applyFullStateSync` restaure aussi désormais `gameState._pendingPrisonerExchange` depuis `data.pendingPrisonerExchange` (transitoire, transmis par `GameSync.syncFullState`), puis appelle `d.restorePendingPrisonerExchangeUI?.()` en toute fin de fonction pour réafficher la modale d'échange dans le bon rôle si un choix était en attente au moment d'un reload de page. `excludeDisconnectedPlayer` appelle désormais `this._resolvePendingPrisonerExchange?.(peerId)` (nouvelle dépendance constructeur) avant toute mutation de `gameState.players`, pour résoudre automatiquement un échange de prisonniers en attente si le joueur exclu est celui qui devait choisir. `initInGameNetworkHandler`, CAS 3 (reconnexion du même joueur, nouveau `playerId` réseau) appelle désormais `d.remapPendingPrisonerExchange?.(oldPeerId, from)` juste après le remap déjà existant de `placedMeeples[].playerId`, pour remapper l'identité dans l'état de l'échange automatique de prisonniers |
| `Scoring.js` | 380 | Calcul des points. `applyAndGetFinalScores` inclut `buybacks` dans les scores détaillés |
| `TilePlacement.js` | 283 | Logique de pose de tuile |
| `TowerUI.js` | ~1050 | UI et orchestration de l'extension Tour, entièrement migrée vers `gameState.extraState.towers`/`gameState.extraState.prisoners` (voir section extraState en tête de document). Curseurs de pose d'étage/capture, sélecteurs de confirmation, pose d'étage/verrouillage/capture hôte. **✅ FIX** : `_getTowerLockMeepleAnchor` renommée et **exportée** en `getTowerLockMeepleAnchor(x, y)` — anciennement privée, réutilisée par `MeepleActionsUI.js` (positionnement du curseur fée sur un garde de tour) et `DragonUI.js` (rendu du pion fée sur un garde de tour), en plus de l'usage interne déjà existant (`showTowerCaptureCursors`). **✅ FIX** : `applyLockExecuted` appelle désormais `_deps.hideAllCursors?.()` pour le joueur local, exactement comme `applyFloorPlaced` le fait déjà — sans cet appel, des curseurs déjà affichés (notamment le curseur fée) restaient visibles et cliquables après un verrouillage, alors que la phase meeple venait d'être consommée par `markMeeplePlaced(x, y, -1, null)` (cf. section "Interaction Dragon ↔ garde de tour" pour le détail du bug). **✅ FIX** : `applyCaptureExecuted` détache désormais la fée (`ownerId = null`, `meepleKey` conservé) au lieu de la retirer complètement du plateau si elle était attachée au meeple/garde capturé — la fée ne disparaît jamais une fois posée, même règle que pour une fermeture de zone classique. `showTowerCursors`/`_openTowerFloorSelector` masquent l'option de verrouillage sur la tuile où se trouve le dragon (cohérent avec `TowerRules.lockTower`). `renderAllTowersFromState()` — (re)dessine l'intégralité des tours et gardes depuis `gameState.extraState.towers`, utilisée par `UndoManager.applyLocally` et par `ReconnectionManager.applyFullStateSync`. **Échange automatique de prisonniers différé** : `executeTowerCaptureHost` ne déclenche plus `_checkAndHandleReciprocalExchange` immédiatement — elle note l'info dans `gameState._pendingReciprocalCheck`, consommée uniquement par la nouvelle fonction exportée `checkPendingReciprocalExchange()`, appelée en fin de tour du capturant. **✅ FIX — Rachat de prisonnier** : `setupPrisonerBuyback` (`isSelectable`) et `executePrisonerBuybackHost` (revalidation hôte, seule source de vérité) n'autorisent désormais le rachat que durant le propre tour du joueur (`_deps.getIsMyTurn()` côté client, `gameState.getCurrentPlayer()?.id === buyerId` côté hôte) et une seule fois par tour de jeu, un tour bonus comptant comme la suite du tour précédent (`gameState._turnBuybackUsed`, posé à `true` dans `applyPrisonerBuybackExecuted`, remis à `false` uniquement à l'entrée d'un véritable nouveau tour dans `home.js`) — auparavant possible à tout moment de la partie et sans limite. **✅ FIX — masquage des panels pendant l'échange automatique** : `_openPrisonerSelectionUI(opponentId, chooserId, availableTypes)` transmet désormais `chooserId` en plus de `playerId` à `ScorePanelUI.enablePrisonerSelection()`, pour que le panel du joueur qui choisit reçoive un rôle visuel distinct (mis en avant mais assombri sur desktop) de celui des autres joueurs (masqués) — voir `ScorePanelUI.js` et `style.css`. **✅ FIX NOUVEAU — Blocage tant que le choix n'est pas fait** : `showPrisonerExchangeModal` n'affiche désormais AUCUN bouton (modale non fermable) pour tout le monde sauf le choisisseur tant que `chosenType` n'est pas fourni (échange non résolu) — auparavant tous les joueurs non concernés disposaient d'un bouton "Fermer" leur permettant de jouer pendant que l'échange restait en suspens, alors que le tour suivant démarre avant la résolution (la vérification de réciprocité n'a lieu qu'à la fin du tour du capturant, cf. paragraphe précédent). Trois nouvelles fonctions exportées couvrent les angles morts réseau : `resolvePendingPrisonerExchangeForPlayer(disconnectedPlayerId)` (résout automatiquement avec le prisonnier le plus ancien — `availableTypes[0]`, ordre garanti par `TowerRules.checkReciprocalCapture` — si le joueur exclu est le choisisseur en attente ; appelée depuis `ReconnectionManager.excludeDisconnectedPlayer`), `restorePendingPrisonerExchangeUI()` (réaffiche la modale dans le bon rôle après un `full-state-sync`, pour un client qui a rechargé sa page ; appelée depuis `ReconnectionManager.applyFullStateSync`), `remapPendingPrisonerExchangeAndPrisoners(oldPeerId, newPeerId)` (remappe `extraState.prisoners`, `_pendingPrisonerExchange`, `_pendingReciprocalCheck`, `_freshCaptures` vers le nouveau `playerId` réseau d'un joueur qui se reconnecte sous la même identité ; appelée depuis `ReconnectionManager.initInGameNetworkHandler`, CAS 3). **Limite connue, volontairement non traitée** : ce remap ne touche pas `extraState.towers.lockedBy` — un joueur qui verrouille une tour puis se reconnecte sous un nouveau `playerId` verra `TowerRules.isLocked` continuer de pointer vers son ancien id (impact mineur identifié, pas de blocage fonctionnel constaté à ce jour ; à traiter comme un chantier à part si un bug concret est rapporté) |
| `TurnManager.js` | 415 | Gestion du tour courant, tour bonus |
| `UndoManager.js` | ~700 | Annulation d'actions du tour en cours. **✨ ÉTENDU (Extension Tour)** : `saveTurnStart`/`saveAfterTilePlaced`/`saveDragonMove` copient désormais `gameState.extraState` (deep copy, générique) et `player.towerPieces` en plus des champs déjà existants. `restoreExtraState(source)` restaure `gameState.extraState` génériquement (boucle sur `Object.keys`, sans connaître les sous-clés — voir section extraState) ; appelée par `restoreSnapshot()` (undo tuile/meeple/abbé) et `undoDragonMove()` (undo déplacement dragon — nécessaire car le dragon peut désormais manger un garde de tour). `restoreSnapshot()` réinitialise aussi explicitement `gameState._pendingTowerCapture`/`_pendingReciprocalCheck` (turn-scoped, non couverts par `extraState`). `applyLocally()` appelle un seul `d.renderAllTowersFromState?.()` générique en tête de fonction (avant le `switch` sur le type d'action), qui redessine l'état Tour quel que soit le type d'annulation — plus simple et plus sûr que de traiter chaque branche séparément. `applyRemote()` (invités) fait le même travail de restauration `extraState`/`towerPieces`/`_pending*` avant de déléguer à `applyLocally()`. Le rachat de prisonnier n'est volontairement pas concerné par l'undo (non annulable, cf. section Tour) : `_turnBuybackUsed` n'est ni sauvegardé ni restauré par ce fichier. L'échange automatique de prisonniers n'est pas non plus concerné par l'undo (non annulable en tant que tel — seule la capture qui le précède l'est, cf. section Tour) : `_pendingPrisonerExchange` n'est ni sauvegardé ni restauré par ce fichier, il vit dans son propre cycle géré par `GameSync.syncFullState`/`ReconnectionManager` |
| `UnplaceableTileManager.js` | 401 | Gestion des tuiles implaçables |
| `ZoneMerger.js` | 720 | Fusionne les zones entre tuiles adjacentes |
| `ZoneRegistry.js` | 201 | Registre central des zones fusionnées |
| `ZoomManager.js` | 204 | Gestion du niveau de zoom |

## `modules/ui/` — Composants d'affichage

| Fichier | Lignes | Rôle |
|---|---|---|
| `GameMenuUI.js` | 49 | Menu en jeu |
| `LobbyJoin.js` | ~172 | Logique de connexion en tant qu'invité. Tout le handler est ignoré si le joueur est hôte (un invité promu le garde au bas de sa chaîne). Le message `welcome` est ignoré en partie (`getTurnManager()` non nul) : il ne doit remettre ni l'ancien code de partie ni le heartbeat du lobby après une reconnexion / un changement d'hôte |
| `LobbyNavigator.js` | ~185 | Retour au lobby / lobby initial ; réinitialise `towerRules` au retour lobby |
| `LobbyUI.js` | 356 | Interface du lobby |
| `MeepleActionsUI.js` | ~670 | Actions meeples : rappel abbé, portail, éjection princesse, placement fée ; orchestre l'extension Tour via les imports de `TowerUI.js`. **✅ FIX** : `showMeepleActionCursors` résout désormais une cible fée dont la clé est `"tower-lock:x,y"` (garde verrouillant une tour) en lisant `gameState.extraState.towers`, et positionne son curseur via `TowerUI.getTowerLockMeepleAnchor(x, y)` au lieu du calcul en grille 5×5 utilisé pour un meeple classique — sans ce cas, la cible calculée par `DragonRules.getFairyTargets` n'avait aucun curseur affiché (`placedMeeples[key]` étant `undefined` pour ce format de clé). `initNetworkMeepleListeners(eventBus)` protégée par flag module-level (`_networkListenersInstalled`) contre la double installation — voir "Piège récurrent" |
| `MeepleCursorsUI.js` | 455 | Curseurs de placement de meeple ; exclut la zone `tower` (et `dragon`/`volcano`/`portal`) des positions de meeple classiques |
| `MeepleDisplayUI.js` | 91 | Affichage visuel des meeples posés |
| `MeepleSelectorUI.js` | 333 | Sélecteur de type de meeple |
| `ModalUI.js` | 528 | Utilitaires génériques de modales |
| `ScorePanelUI.js` | ~530 | Panneau des scores (desktop + mobile). Lit `gameState.extraState.prisoners[player.id]`. **Sélection de prisonniers** (mécanisme générique `enablePrisonerSelection`/`forceOpenPlayerPanel`/`setBuybackHandler`) — les conditions d'éligibilité effectives (propre tour, une fois par tour, etc.) sont posées par le gestionnaire enregistré depuis `TowerUI.setupPrisonerBuyback`/`_openPrisonerSelectionUI`, pas par ce fichier. **✅ FIX** : `enablePrisonerSelection({ playerId, chooserId, isSelectable, onSelect })` accepte désormais un `chooserId` optionnel en plus de `playerId` (le détenteur/cible). Pendant une sélection active, chaque panel reçoit une classe CSS selon son rôle — posée par `_updateDesktop`/`_updateMobile`, comportement défini dans `style.css` : `.prisoner-selection-target` (panel de `playerId`, mise en page intacte, recouvert intégralement d'un calque sombre `::after` à 0.9 — nom, score, meeples, prisonniers non concernés — SAUF les `.prisoner-selectable` remontés au-dessus du calque (z-index) ; toute future ligne ajoutée par une extension est automatiquement recouverte sans modification. Sur mobile, la carte fermée de la barre du haut et le détail reçoivent tous deux ce calque), `.prisoner-selection-chooser` (panel de `chooserId`, desktop uniquement, visible mais assombri par un calque local), `.prisoner-selection-hidden` (tous les autres panels, desktop ET mobile — y compris les cartes fermées de la barre du haut sur mobile). Sur mobile, un seul panel étant affichable à la fois, seul le rôle "cible" s'applique (pas de rôle "choisisseur" distinct) |
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
  identique au Dragon. Si le garde capturé (voir ci-dessous) portait la fée,
  elle est détachée (reste sur le plateau, sans propriétaire —
  `applyCaptureExecuted`).
- **Verrouillage** : à partir de 1 étage, n'importe quel joueur peut verrouiller
  une tour avec un meeple normal ou grand meeple (ressource personnelle
  consommée), ce qui l'exclut des tuiles éligibles à un nouvel étage et
  consomme la phase meeple du tour, exactement comme la pose d'un étage.
  Interdit sur la tuile où se trouve actuellement le dragon
  (`gameState.dragonPos`).
- **Interaction Dragon/Fée ↔ garde de tour** : un garde qui verrouille une
  tour (vivant dans `gameState.extraState.towers[x,y]`, absent de
  `placedMeeples`) se comporte comme un meeple classique vis-à-vis du dragon
  et de la fée, moyennant une clé d'identification spéciale `"tower-lock:x,y"`
  (au lieu du format `"x,y,position"` habituel) utilisée de façon cohérente
  à travers tout le code :
  - **Dragon** : mangé comme n'importe quel meeple classique lorsque le
    dragon visite la tuile (`DragonRules._eatMeeplesAt`), avec retour à la
    réserve du joueur et déverrouillage de la tour. Le déplacement dragon
    correspondant est annulable comme les autres (`UndoManager.saveDragonMove`/
    `undoDragonMove` incluent `gameState.extraState`). **✅ FIX** : côté
    invité, le retrait visuel du pion `.tower-lock-meeple` n'était auparavant
    déclenché que côté hôte (`DragonUI.executeDragonMoveHost`) — le handler
    réseau `network-dragon-state-update` (`home.js`) ne traitait que le cas
    classique `.meeple[data-key]` pour `eatenKeys`, laissant le garde affiché
    à tort chez les invités. Corrigé en y ajoutant le même traitement de la
    clé `tower-lock:x,y` que côté hôte. **✅ FIX (plus profond)** :
    `DragonUI.broadcastDragonState()` ne transporte que `dragonPos`/
    `dragonPhase`/`fairyState`/`players` — **jamais** `gameState.extraState`.
    Le déverrouillage de la tour (`lockedBy`/`lockMeepleType`/`lockMeepleColor`
    remis à `null` par `DragonRules._eatMeeplesAt`) n'était donc appliqué que
    sur la copie `gameState` de l'**hôte** ; chaque invité gardait sa propre
    copie de `extraState.towers` figée sur "verrouillée par ce joueur",
    l'empêchant à tort de reposer un étage/garde sur cette tour par la suite
    (`TowerRules.isLocked` local renvoyait `true`), et laissant la fée
    continuer de proposer ce garde comme cible valide
    (`DragonRules.getFairyTargets` relit ce même état local). Corrigé en
    mutant directement `gameState.extraState.towers[coords]` dans le handler
    `network-dragon-state-update` (`home.js`), pour la clé `tower-lock:x,y`,
    en plus du retrait visuel déjà en place.
  - **Fée** : peut être attachée à un garde de tour du joueur
    (`DragonRules.getFairyTargets` parcourt aussi
    `gameState.extraState.towers`, en plus de `placedMeeples`). Le curseur
    d'action (`MeepleActionsUI.showMeepleActionCursors`) et le rendu du pion
    fée (`DragonUI.renderFairyPiece`) reconnaissent tous deux la clé spéciale
    et s'ancrent sur la position réelle du garde
    (`TowerUI.getTowerLockMeepleAnchor`, exportée pour l'occasion).
    `GameState.isFairyOnTile` reconnaît le format `"tower-lock:x,y"` pour que
    la protection de la fée continue de bloquer le dragon sur cette tuile
    (auparavant le parsing générique produisait silencieusement `NaN` et
    laissait la tuile non protégée). **✅ FIX — la fée ne disparaît jamais** :
    quand le garde/meeple qui la porte quitte le plateau suite à une capture
    Tour (`TowerUI.applyCaptureExecuted`) ou parce que le dragon le mange
    (`DragonRules._eatMeeplesAt`), ces deux fonctions appelaient auparavant
    `gameState.removeFairy()` (retrait complet — `ownerId` **et**
    `meepleKey` vidés), alors que la règle du jeu est que la fée, une fois
    posée, ne quitte jamais le plateau tant qu'aucun joueur ne la reprend —
    exactement le comportement déjà correct pour une fermeture de zone
    classique via `DragonUI.releaseFairyIfDetached` (qui ne vide que
    `ownerId`, en conservant `meepleKey`). Les deux fonctions détachent
    désormais la fée de la même façon (`ownerId = null` uniquement) au lieu
    de la retirer : elle reste visible à sa position (aucun retrait DOM) et
    continue de bloquer le dragon jusqu'à ce qu'un joueur la réattache à un
    de ses propres meeples.
  - **✅ FIX — ordre pose de garde / pose de fée** : poser un étage ou
    verrouiller une tour consomme la phase meeple du tour
    (`undoManager.markMeeplePlaced(x, y, -1, null)`), ce qui doit empêcher
    toute pose de fée dans le même tour. La pose d'étage nettoyait déjà tous
    les curseurs affichés après coup (`_deps.hideAllCursors?.()`) ; le
    verrouillage ne le faisait pas, laissant un curseur fée déjà affiché
    (rendu juste après la pose de tuile) visible et cliquable malgré le flag
    `meeplePlacedThisTurn` désormais à `true`. `TowerUI.applyLockExecuted`
    appelle maintenant le même nettoyage, symétriquement à la pose d'étage.
  - **✅ FIX — capture Tour fantôme chez l'invité** : `gameState._pendingTowerCapture`
    (posé par `applyFloorPlaced`, transitoire et volontairement non sérialisé)
    doit être remis à `null` à chaque fin de tour. Ce nettoyage n'existait que
    côté hôte (`GameEventSetup._installEndTurn` après le bloc invité,
    `GameSyncCallbacks.onTurnEndRequest`) : la branche invité de
    `_installEndTurn` retourne plus tôt (après l'envoi du `turn-end-request`)
    sans jamais nettoyer sa propre copie locale. Contrairement à
    `_pendingPrincessTile`/`_pendingPortalTile`, qui ont ce même risque mais
    sont déjà couverts par un reset générique au **début du tour suivant du
    joueur concerné** (`eventBus.on('tile-drawn', ...)` dans `home.js`,
    bloc `isOwnTurnStart`), `_pendingTowerCapture` avait été oublié de ce
    même bloc. Un invité ayant posé un étage se retrouvait donc, à son tour
    suivant, avec l'ancienne cible de capture (ex: le garde d'une tour
    voisine) réaffichée par `showPendingTowerCaptureIfAny()` sans qu'aucun
    nouvel étage n'ait été posé ce tour-là. Corrigé en ajoutant
    `gameState._pendingTowerCapture = null;` au même bloc que
    `_pendingPrincessTile`/`_pendingPortalTile`.
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
  - **✅ FIX — Blocage tant que le choix n'est pas fait** : comme la
    vérification n'a lieu qu'à la fin du tour du capturant, le tour suivant
    démarre AVANT que le joueur concerné (X) n'ait choisi lequel de ses
    meeples récupérer, si plusieurs types sont possibles. Auparavant, tous
    les joueurs non concernés disposaient d'un bouton "Fermer" sur la modale
    d'attente, ce qui leur permettait de jouer pendant que l'échange restait
    indéfiniment en suspens. `TowerUI.showPrisonerExchangeModal` n'affiche
    désormais AUCUN bouton — modale non fermable — pour tout le monde sauf
    le choisisseur, tant que `chosenType` n'est pas fourni (échange non
    résolu). Trois angles morts complémentaires sont gérés séparément :
    - **Vraie déconnexion/exclusion du choisisseur** (bouton "Continuer sans
      X" côté hôte) → `TowerUI.resolvePendingPrisonerExchangeForPlayer`,
      appelée depuis `ReconnectionManager.excludeDisconnectedPlayer` avant
      toute mutation de `gameState.players`, résout automatiquement
      l'échange avec le prisonnier **le plus ancien** de X détenu par Y
      (`availableTypes[0]` — l'ordre chronologique est déjà garanti par
      `TowerRules.checkReciprocalCapture`, qui construit ce tableau par
      `filter()`+`Set()` sur une liste alimentée par `.push()` au fil des
      captures : aucun tri à ajouter). Une simple pause (le choisisseur reste
      déconnecté mais pas encore exclu) ne déclenche rien de spécial — le
      voile de pause générique (`ReconnectionManager.pauseGame`) bloque déjà
      tous les autres joueurs entre-temps.
    - **Reload de page du choisisseur** (perte de l'état JS local,
      `gameState._pendingPrisonerExchange` étant transitoire donc non
      restauré par `gameState.deserialize()`) → `GameSync.syncFullState`
      transmet désormais ce champ explicitement ; côté client,
      `ReconnectionManager.applyFullStateSync` le restaure puis appelle
      `TowerUI.restorePendingPrisonerExchangeUI`, qui réaffiche la modale
      dans le bon rôle pour ce client.
    - **Reconnexion du même joueur avec un nouveau `playerId` réseau** (CAS 3
      de `ReconnectionManager.initInGameNetworkHandler` — PeerJS attribue
      toujours un nouvel id à la reconnexion, même pour un joueur qui reprend
      son identité) → `TowerUI.remapPendingPrisonerExchangeAndPrisoners`
      remappe `extraState.prisoners` (clé + `ownerId`),
      `_pendingPrisonerExchange`, `_pendingReciprocalCheck` et
      `_freshCaptures` vers le nouvel id, exactement comme `placedMeeples[].playerId`
      l'est déjà dans ce même bloc. Sans ce remap, un choisisseur qui recharge
      sa page en plein choix ne se reconnaîtrait plus comme "le choisisseur"
      après reconnexion et resterait bloqué indéfiniment.
    - **Limite connue, volontairement non traitée ici** : `remapPendingPrisonerExchangeAndPrisoners`
      ne touche pas `extraState.towers.lockedBy` (même catégorie de problème
      — un id de joueur référencé ailleurs dans `extraState` sans être
      remappé à la reconnexion — mais périmètre plus large que cette
      correction ponctuelle). Un joueur qui verrouille une tour puis se
      reconnecte sous un nouveau `playerId` verra `TowerRules.isLocked`
      continuer de pointer vers son ancien id (impact cosmétique/mineur :
      attribution du verrouillage, pas de blocage fonctionnel identifié à ce
      jour). À traiter comme un chantier à part si un bug concret est
      rapporté sur ce point précis.
  - Non annulable en tant que tel (l'échange n'a lieu qu'une fois la capture
    déjà verrouillée par la fin du tour) — mais la capture qui le précède l'est.
  - **✅ FIX — mise en avant/masquage des panels pendant le choix** :
    `TowerUI._openPrisonerSelectionUI(opponentId, chooserId, availableTypes)`
    transmet désormais `chooserId` à `ScorePanelUI.enablePrisonerSelection()`,
    en plus de `playerId` (= `opponentId`, le détenteur des prisonniers
    proposés). `ScorePanelUI` donne alors à chaque panel un rôle visuel
    explicite pendant la sélection (voir `modules/ui/ScorePanelUI.js` et
    `style.css`) : le panel du détenteur est entièrement visible au-dessus
    du voile (assombri à `rgba(0,0,0,0.9)`, anciennement 0.7) avec sa
    mise en page intacte, recouvert d'un calque sombre local sauf ses prisonniers
    sélectionnables ; le panel du choisisseur reste visible mais assombri
    localement (desktop uniquement) ; tous les autres panels sont masqués
    (desktop et mobile, y compris les cartes fermées de la barre du haut sur
    mobile). Auparavant, tous les panels des joueurs passaient au-dessus du
    voile sans distinction, laissant voir des informations non concernées et
    ne masquant pas suffisamment le plateau.
- **Rachat de prisonnier** : règle officielle — "Durant votre tour, vous
  pouvez également libérer un de vos meeples capturés par un autre joueur" et
  "Le paiement de rançon pour récupérer un prisonnier ne se fait qu'une fois
  par tour, même lorsqu'il y a un double tour". Le rachat n'est donc autorisé
  que **pendant le tour du joueur acheteur** (`_deps.getIsMyTurn()` côté
  client dans `TowerUI.setupPrisonerBuyback`, `gameState.getCurrentPlayer()?.id
  === buyerId` côté hôte dans `executePrisonerBuybackHost` — seule source de
  vérité), et **limité à une seule rançon par tour de jeu**, un tour bonus
  (bâtisseur) comptant comme la suite du tour précédent
  (`gameState._turnBuybackUsed`, transitoire non sérialisé, posé à `true` par
  `applyPrisonerBuybackExecuted` et remis à `false` uniquement à l'entrée d'un
  véritable nouveau tour — cf. `home.js`, listener `'turn-changed'`, qui ne
  réinitialise ce flag que si `turnManager.isBonusTurn` est `false` à cet
  instant). Coût fixe `PRISONER_BUYBACK_COST` (3 points), transaction directe
  acheteur → capturant. Désactivé tant qu'un échange automatique est en
  attente, et tant que la capture concernée est "fraîche"
  (`gameState._freshCaptures`, vidé à chaque `'turn-changed'`). Le rachat
  n'utilise pas le voile gris ni le mécanisme de mise en avant/masquage des
  panels décrit ci-dessus pour l'échange automatique (`forceOpenPlayerPanel`/
  `chooserId`) — il se contente de rendre l'entrée cliquable via
  `setBuybackHandler`, l'ouverture du panel restant à l'initiative du joueur.
- **Undo** : ✨ pleinement pris en charge — pose d'étage, capture, verrouillage
  et déplacement dragon ayant mangé un garde sont tous annulables comme les
  autres actions du tour (granularité "tout-en-un" : annuler après une
  capture Tour annule aussi la pose d'étage qui l'a précédée dans le même
  tour, cohérent avec le reste du système d'undo — voir `UndoManager.js`).
  L'échange automatique de prisonniers et le rachat restent hors du système
  d'undo (le premier ne peut de toute façon plus survenir tant que l'action
  qui le déclenche est encore annulable ; le second n'est pas lié à un tour
  au sens de l'undo, et son unique compteur `_turnBuybackUsed` n'est ni
  sauvegardé ni restauré par `UndoManager`).
- **Réseau** : architecture réactive identique aux autres actions (invité →
  requête, hôte → applique et broadcast, y compris echo à l'émetteur).
- **Reconnexion** : les tours et gardes de verrouillage sont correctement
  redessinés (`ReconnectionManager.applyFullStateSync` →
  `renderAllTowersFromState`). Un choix d'échange automatique de prisonniers
  en attente est également restauré et réaffiché (voir "Blocage tant que le
  choix n'est pas fait" ci-dessus).
- **Scoring** : pas de points directement liés à la Tour — le seul bénéfice
  est l'avantage stratégique de capturer/neutraliser des meeples adverses
  (hormis le coût/gain ponctuel du rachat de prisonnier, comptabilisé à part
  dans `scoreDetail.buybacks`).

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
| Interaction Dragon/Fée ↔ garde de tour (capture, blocage verrouillage, fée attachée à un garde) | `modules/rules/DragonRules.js` (`_eatMeeplesAt`, `getFairyTargets`), `modules/game/DragonUI.js` (`executeDragonMoveHost`, `renderFairyPiece`), `modules/rules/TowerRules.js` (`lockTower`), `modules/game/TowerUI.js` (`showTowerCursors`/`_openTowerFloorSelector`, `getTowerLockMeepleAnchor`, `applyCaptureExecuted`, `applyLockExecuted`), `modules/ui/MeepleActionsUI.js` (`showMeepleActionCursors`), `modules/GameState.js` (`isFairyOnTile`) |
| Un garde de tour mangé par le dragon reste visible chez un invité | `home.js` (handler `network-dragon-state-update`, boucle `eatenKeys`) — vérifier qu'il traite bien le préfixe `tower-lock:` comme le fait `DragonUI.executeDragonMoveHost` côté hôte |
| Après qu'un dragon a mangé un garde de tour, ce joueur ne peut plus reposer d'étage/garde sur cette tour (mais un autre joueur le peut), ou la fée peut encore cibler ce garde disparu | `home.js` (handler `network-dragon-state-update`) — vérifier que `gameState.extraState.towers[coords]` est bien démuté localement (pas seulement le rendu DOM) ; `DragonUI.broadcastDragonState` ne transporte jamais `extraState`, toute mutation Tour déclenchée par le dragon doit donc être répliquée manuellement côté invité |
| Un curseur de capture Tour apparaît sans qu'aucun étage n'ait été posé ce tour-ci | `home.js` (handler `eventBus.on('tile-drawn', ...)`, bloc `isOwnTurnStart`) — vérifier que `gameState._pendingTowerCapture` y est bien remis à `null`, comme `_pendingPrincessTile`/`_pendingPortalTile` |
| La fée disparaît du plateau quand le meeple/garde qui la porte est capturé (Tour) ou mangé (Dragon) | `modules/game/TowerUI.js` (`applyCaptureExecuted`), `modules/rules/DragonRules.js` (`_eatMeeplesAt`) — doivent détacher la fée (`fairyState.ownerId = null`, `meepleKey` conservé) et non appeler `gameState.removeFairy()`, cf. `DragonUI.releaseFairyIfDetached` pour le comportement de référence (fermeture de zone) |
| Une action censée consommer la phase meeple du tour (pose d'étage, verrouillage) laisse un curseur d'action encore cliquable | `modules/game/TowerUI.js` (`applyFloorPlaced`/`applyLockExecuted`, doivent appeler `_deps.hideAllCursors?.()` pour le joueur local) |
| Bug spécifique à l'échange automatique de prisonniers (y compris timing/annulation) | `modules/game/TowerUI.js` (`executeTowerCaptureHost`, `checkPendingReciprocalExchange`, `_checkAndHandleReciprocalExchange`, `applyPrisonerExchangeResolved`, `applyPrisonerExchangePending`), `modules/rules/TowerRules.js` (`checkReciprocalCapture`), `modules/ui/ScorePanelUI.js`, `modules/core/GameSync.js`/`modules/game/GameSyncCallbacks.js`, `modules/GameState.js` (`_pendingReciprocalCheck`) |
| Le tour suivant démarre alors qu'un échange automatique de prisonniers attend encore le choix d'un joueur (plusieurs types possibles) | `modules/game/TowerUI.js` (`showPrisonerExchangeModal` — doit être non fermable tant que `chosenType` n'est pas fourni, `resolvePendingPrisonerExchangeForPlayer`, `remapPendingPrisonerExchangeAndPrisoners`, `restorePendingPrisonerExchangeUI`), `modules/game/ReconnectionManager.js` (`excludeDisconnectedPlayer`, `applyFullStateSync`, `initInGameNetworkHandler` CAS 3), `modules/core/GameSync.js` (`syncFullState` doit transporter `pendingPrisonerExchange`) |
| Pendant un choix d'échange automatique, un panel non concerné reste visible, ou le plateau/le panel choisisseur restent trop visibles derrière le voile | `modules/game/TowerUI.js` (`_openPrisonerSelectionUI`, doit transmettre `chooserId`), `modules/ui/ScorePanelUI.js` (`enablePrisonerSelection`, `_updateDesktop`/`_updateMobile`, classes `.prisoner-selection-target`/`.prisoner-selection-chooser`/`.prisoner-selection-hidden`), `style.css` (mêmes classes + opacité du voile `#prisoner-selection-overlay` dans `index.html`) |
| Le rachat de prisonnier est possible hors de son tour, ou plusieurs fois dans le même tour (double tour bâtisseur inclus) | `modules/game/TowerUI.js` (`setupPrisonerBuyback` pour l'UI, `executePrisonerBuybackHost` pour la revalidation autoritaire, `applyPrisonerBuybackExecuted` qui pose `gameState._turnBuybackUsed = true`), `home.js` (listener `eventBus.on('turn-changed', ...)`, doit remettre `_turnBuybackUsed` à `false` uniquement quand `turnManager.isBonusTurn` est `false`), `modules/GameState.js` (déclaration de `_turnBuybackUsed`) |
| Bug spécifique au rachat de prisonnier (hors timing propre-tour/une-fois-par-tour ci-dessus) | `modules/game/TowerUI.js` (`setupPrisonerBuyback`, `executePrisonerBuybackHost`), `modules/rules/TowerConfig.js`, `modules/ui/ScorePanelUI.js`, `modules/game/Scoring.js`/`modules/game/FinalScoresManager.js` |
| Bug d'annulation (undo) qui touche l'extension Tour (étage/capture/verrouillage/dragon-mange-garde non restauré) | `modules/game/UndoManager.js` (`restoreExtraState`, `saveTurnStart`/`saveAfterTilePlaced`/`saveDragonMove`, `applyLocally`), `modules/game/TowerUI.js` (`renderAllTowersFromState`), `modules/game/GameModuleInitializer.js` (câblage de la dépendance) |
| Bug de reconnexion où un état d'extension (Tour ou future) n'apparaît pas chez l'invité reconnecté | `modules/game/ReconnectionManager.js` (`applyFullStateSync`) — vérifier qu'un rendu `renderAllXxxFromState()` est bien appelé pour cette extension, comme pour Dragon/Fée/Tour |
| Un événement réseau semble appliqué plusieurs fois (état dupliqué), surtout après un retour lobby + nouvelle partie, et seulement côté invité | Section "⚠️ Piège récurrent — `eventBus` singleton" en tête de ce document |
| Désynchronisation réseau hôte/invité | `modules/core/GameSync.js`, `modules/game/GameSyncCallbacks.js`, `home.js` |
| Déconnexion/reconnexion/pause | `modules/game/ReconnectionManager.js`, `modules/core/HeartbeatManager.js` |
| L'ancien hôte reste bloqué sur « Partie en pause » / « Connexion perdue », ou ne retrouve pas la partie | `modules/game/HostMigration.js` (`onSelfIsolated`, `_isolationLoop`, `_probeOldHost`, `onHostMoved`), `modules/game/ReconnectionManager.js` (`_isHostIsolated`), `modules/core/Multiplayer.js` (`_installHostKeepAlive`, `notifyPeer`), `home.js` (`_rejoinAsGuest`) |
| Un joueur reconnecté apparaît encore « déconnecté » chez certains invités seulement / un spectateur reste bloqué sur « Connexion perdue » après une reconnexion | `home.js` (`buildPlayersForBroadcast`, `onRejoinRejected`), `modules/game/ReconnectionManager.js` (handler `players-update`, CAS 2/5), `modules/ui/LobbyJoin.js` (`isSpectator` dans `player-info` de reconnexion) |
| Le code affiché (menu, lobby) n'est pas celui du nouvel hôte | `home.js` (`_refreshGameCodeDisplays`, dep `setGameCode` de `_getHostMigration`) |
| L'hôte disparaît : la partie ne continue pas / mauvais successeur / deux hôtes / invités bloqués sur « Connexion perdue » | `modules/game/HostMigration.js` (logs `[MIGRATION]`), `modules/core/Multiplayer.js` (`reconnectTo`, `startAccepting`, `hostPeerId`), `modules/game/ReconnectionManager.js` (CAS 5, `_notifyHostLost`), `modules/core/GameSync.js` (`host-snapshot`, `onTurnEndSynced`), section « Changement d'hôte » en tête de ce document |
| Score incorrect | `modules/game/Scoring.js`, `modules/game/ZoneMerger.js`, `modules/game/ZoneRegistry.js`, `modules/MeepleUtils.js` |
| Annulation d'action (undo) qui se comporte mal, hors extension Tour | `modules/game/UndoManager.js` |
| Je démarre une nouvelle extension avec un pion/compteur/structure persistant | Lire d'abord la section "⚠️ `gameState.extraState`" en tête de ce document, puis "Extensions à venir" pour les pièges déjà identifiés sur cette extension précise. Si cette mécanique peut bloquer le jeu tant qu'un choix n'est pas fait par un joueur, lire aussi le sous-point "Blocage tant qu'un choix n'est pas fait" de la même section, et s'inspirer directement de l'implémentation de l'échange automatique de prisonniers (section Tour) |
| Modale/texte d'interface à modifier | `index.html` (texte statique) ou le manager JS correspondant si dynamique |
