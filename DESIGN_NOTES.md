# Notes de conception — Carcassonne Online

> Complément de `ARCHITECTURE.md` (qui renvoie ici par `DN §x`). **À lire seulement si la tâche touche le sujet.**
> Ce fichier ne contient que des **règles durables** et des mécanismes. L'historique des bugs est dans les
> commentaires `// ✅ FIX` du code et dans git — ne pas le recopier ici.

## Sommaire

1. Pièges transversaux (`eventBus`, callbacks différés)
2. Modèle réseau
3. Changement d'hôte
4. Remplacement d'un id de joueur
5. `gameState.extraState` et états `_pending*`
6. Extension Tour
7. Interaction Dragon / Fée ↔ garde de tour
8. Check-list d'une nouvelle extension
9. Extensions à venir
10. Panneaux joueurs (spectateurs, barre mobile)

---

## 1. Pièges transversaux

### 1.1 `eventBus` singleton et redémarrage de partie

`eventBus` est créé **une fois** dans `home.js` et **jamais recréé**, y compris au retour lobby. La plupart des autres
modules (`gameState`, `zoneMerger`, `_deps` de `TowerUI`/`DragonUI`/`MeepleActionsUI`…) sont recréés ou réinjectés à
chaque partie (`GameStarter.postStartSetup()`).

**Règle** : une fonction qui fait `eventBus.on(...)` et qui est appelée depuis `postStartSetup()` (donc à chaque
partie) **accumule un listener de plus à chaque partie** → l'événement réseau correspondant est traité N fois
(ex. une entrée dupliquée dans `extraState.prisoners`, visible seulement côté invité car l'hôte applique sans passer
par le bus).

**Pattern** : flag module-level vérifié en tête de fonction (voir `MeepleActionsUI.initNetworkMeepleListeners`,
flag `_networkListenersInstalled` ; `GameEventSetup.install` utilise `_installed`). Sûr tant que les callbacks lisent
`_deps` / `gameState` **dynamiquement à l'appel**, ce qui est le cas partout (`_deps` est réassigné à chaque partie
par `initXxxUI()`).

Toute nouvelle `initXxxListeners(eventBus)` : soit protégée par un flag, soit appelée une seule fois au chargement.

### 1.2 Callbacks différés et onglet en arrière-plan

Le navigateur **suspend `requestAnimationFrame`** quand l'onglet est caché ; le callback s'exécute au retour au
premier plan, parfois plusieurs tours plus tard, alors que les messages réseau, eux, ont continué d'être traités.

**Règle** : dans tout callback différé (`requestAnimationFrame`, `setTimeout` long, `.then`), **relire l'état courant
à l'exécution** (`d.getXxx()`), jamais une valeur capturée avant. Toute écriture DOM déclenchée par un
`full-state-sync` y est soumise (cas concret : l'aperçu `#tile-preview` dans `ReconnectionManager.applyFullStateSync`).

---

## 2. Modèle réseau

- **Topologie en étoile** : les invités ne sont connectés qu'à l'hôte. Un message d'invité n'atteint les autres
  invités que si l'hôte le **relaie**.
- **Flux standard** : invité → `xxx-request` → hôte valide, applique, **diffuse** `xxx` à tous (y compris un écho à
  l'émetteur, qui applique alors à la réception — invité « purement réactif »).
- **Où brancher quoi** :
  - requête invité → hôte : `GameSyncCallbacks._attachHostCallbacks` (ou `switch` de `GameSync._handleGameMessage`) ;
  - diffusion hôte → invités : méthode `syncXxx` de `GameSync` + `case` + callback `onXxx` dans `GameSyncCallbacks.attach` ;
  - message d'invité qui doit aussi atteindre **les autres invités** : l'ajouter à `relayTypes`
    (`GameSync._handleGameMessage`). Sans cela seuls l'hôte et l'émetteur voient l'action (visible dès 3 joueurs).
- **Dédup** : `Multiplayer.broadcast` ajoute un `msgId` ; les doublons reçus sont ignorés 5 s.
- **Paquet d'état complet** : `GameSync.buildFullStateMessage` (arguments via `ReconnectionManager.collectFullStateArgs`),
  utilisé à la fois par `full-state-sync` (reconnexion) et `host-snapshot` (changement d'hôte). **Tout champ ajouté
  là est couvert par les deux mécanismes.** Les champs transitoires non sérialisés par `gameState.serialize()` qui
  doivent survivre à un rechargement (ex. `_pendingPrisonerExchange`) doivent y être transportés explicitement.
- **Capacité** : 6 joueurs non spectateurs maximum. `'spectator'` n'est jamais une couleur « prise » (spectateurs
  illimités). Un nouvel arrivant sans couleur libre devient spectateur, au lobby (`home.js`, handler `player-info`)
  comme en partie (`ReconnectionManager`, CAS 1 → CAS 2). `game-in-progress` transporte `full` et `reservedNames`
  (pseudos des joueurs non spectateurs) : `LobbyJoin` masque « Joueur » si `full` et pseudo non réservé — un joueur
  qui revient doit toujours pouvoir reprendre sa place (CAS 3). Un joueur converti en spectateur aligne son
  `playerColor` local sur `'spectator'` (`applyFullStateSync`).
- **Validation hôte** : l'hôte ne fait jamais confiance au client (ex. `getCurrentPlayer()?.id === from` avant
  d'appliquer une requête de tour) ; l'identité fiable est `from`, pas un champ du message.

---

## 3. Changement d'hôte (`HostMigration`)

Livré **en partie et au lobby**. Constantes (délai de grâce, sondage, balayage) : voir le début de
`HostMigration.js` ; heartbeat : `HeartbeatManager.js`.

### Principe

- Id PeerJS = code à 6 chiffres, **pour les invités aussi** (`Multiplayer._openGuestPeer`). L'id d'un invité promu
  devient le **nouveau code de partie** ; on ne récupère jamais l'ancien code.
- **Snapshot** : à chaque `syncTurnEnd`, l'hôte diffuse `host-snapshot` = paquet d'état complet + `hostId` +
  `candidates` (successeurs, ordre de `gameState.players`, hors spectateurs/déconnectés/exclus).
- **Détection (invité)** : fermeture de la connexion de `hostPeerId`, erreur réseau PeerJS, ou heartbeat muet →
  `ReconnectionManager._notifyHostLost` → `HostMigration.onHostLost`. Sans snapshot : ancienne reconnexion en boucle.
- **Élection déterministe sans communication** : chaque invité parcourt `[hostId, ...candidates]`, tente de rejoindre
  chaque cible pendant le délai de grâce (`Multiplayer.reconnectTo`, même peer/même id), et se **promeut** en arrivant
  à son propre id. Un succès exige la confirmation `game-in-progress` de la cible. Un invité **hors ligne** n'élit
  personne : il attend le retour du réseau (`_waitOnline`).
- **Promotion** (`_promote`, bloc **synchrone**) : adapte le snapshot (ancien hôte `disconnected`+`kicked`, son tour
  sauté, la tuile déjà piochée passe au suivant), `isHost=true` partout (`home.js`, `gameSync.isHost`,
  `turnManager.isHost`, `prepareHostTakeover`), `applyFullStateSync`, puis réinstalle tout ce qu'un hôte doit avoir
  (`attachGameSyncCallbacks`, `initInGameNetworkHandler`, menu, `prepareHostLobby`) et **en dernier**
  `startAccepting()`.
- **État restauré = début du tour en cours** : tout ce qui a eu lieu depuis est perdu.
- Les autres invités gardent leur id réseau → traités en **CAS 5** de `initInGameNetworkHandler` (même id,
  réactivation + `sendFullStateTo`). L'ancien hôte qui revient avec le même pseudo passe par le **CAS 3**.

### Ancien hôte isolé

Si c'est l'hôte qui perd internet (`offline`, ou `ReconnectionManager._isHostIsolated()`), il passe en **mode
isolement** (`onSelfIsolated`) : overlay, aucun joueur marqué déconnecté, reconnexion à la signalisation sous le même
id (`ensurePeerReady`, `_installHostKeepAlive`). Deux issues :
1. il revient avant la fin de la grâce des invités → ils le rejoignent (CAS 5) ; seule une connexion **nouvelle**
   compte (`_staleConns`/`_guestAlive` : une ancienne connexion morte mais « ouverte » est ignorée) ;
2. sinon le **nouvel hôte** sonde l'ancien id (`_probeOldHost`, `notifyPeer`) et lui envoie `host-moved` + nouveau
   code ; l'ancien hôte quitte son rôle et rejoint automatiquement (`_rejoinAsGuest`, même pseudo → CAS 3).

Après un isolement, `_scheduleSweep` signale déconnectés les invités qui ne sont pas revenus. La fenêtre
`recentOutage` de `_isHostIsolated` évite d'accuser des invités à cause de **sa propre** coupure.

### Au lobby

Même mécanique **sans snapshot** (la liste des joueurs et les options sont déjà connues). L'hôte qui quitte passe la
main (`leaveLobbyAsHost` → `lobby-host-transfer`) ; un hôte qui disparaît déclenche l'élection (`onLobbyHostLost`,
successeurs dans l'ordre de la liste). Le nouvel hôte n'envoie pas `game-in-progress` : l'invité se présente
(`player-info`), la réponse `players-update` fait foi. `home.js` factorise `_prepareHostLobby()` (handler lobby hôte,
synchro des options installée **une seule fois**) et `_activateHostLobby()`. Une promotion **en partie** n'appelle que
`_prepareHostLobby()` (la chaîne réseau de la partie reste intacte). Limite : pas de mode isolement au lobby.

### Règles à respecter

- **État transitoire du tour** : tout nouveau champ `_pending*` ou compteur « par tour » doit être remis à zéro dans
  `HostMigration._resetTurnTransientState` (le jeu revient au début du tour).
- **Repioche / remélange / destruction en cours de tour** : rediffuser le snapshot (`gameSync.onTurnEndSynced?.()`).
- **Vérification « début de tour propre »** (`isOwnTurnStart` dans `home.js`) : à faire aussi pour une tuile reçue par
  `fromFullSync` (ex. tuile implaçable, dragon sans volcan).
- **Handlers lobby invité en bas de chaîne** : un invité promu garde `LobbyJoin.lobbyHandler` sous ses handlers hôte.
  Tout message qu'il traite doit être inoffensif pour un hôte (garde `isHost`) ; seul l'hôte **courant** envoie
  `game-in-progress`.
- **`Multiplayer.onXxx` / `peer.on(...)`** : rester cohérent avec `isHost` qui peut passer à `true` en cours de vie
  du peer.
- **Variables « hôte » dans `home.js` hors `gameState`** (ex. `currentTileForPlayer`) : les réaffecter dans `_promote`.
- **Un spectateur** qui se reconnecte doit envoyer `isSpectator` selon sa couleur, sinon il est traité comme nouveau
  joueur. `rejoin-rejected` reçu en partie est géré par `gameSync.onRejoinRejected` (`home.js`).
- **État « déconnecté »** : `buildPlayersForBroadcast()` joint `disconnected` à `players-update` ; le handler invité
  l'applique (y compris pour le remettre à `false`, nécessaire au CAS 5).
- **Heartbeat** : `receivePong` retire un pair de `_timedOut` côté invité (sinon une 2ᵉ perte du même hôte n'est
  jamais détectée). Le heartbeat est partagé avec le lobby.

### Limites connues

- Phase dragon en cours non snapshotée (restauration à la fin du dernier tour complet).
- Si l'id d'un successeur change à la promotion (id déjà pris, très rare), les autres le cherchent sous l'ancien.
- Pas de persistance : si **tous** les joueurs quittent, la partie est perdue.
- Un ancien hôte dont la page est fermée/rechargée n'est pas joignable par le sondage : il doit saisir le nouveau code.
- Pour comparer des logs `[MIGRATION]` de deux appareils, ne pas se fier aux horloges (dérives de dizaines de
  secondes) : recouper par un événement commun.

---

## 4. Remplacement d'un id de joueur

PeerJS donne un nouvel id à chaque reconnexion ; le pseudo ne change pas. L'id sert de clé interne (propriétaire d'un
meeple, d'un prisonnier, d'une tour verrouillée, de la fée…) → il faut le remplacer **partout**.

- **Fonction unique** : `GameState.remapPlayerId(oldId, newId)` — joueurs, `disconnectedPlayers`, `extraState` (via
  `remapExtraStateIds`), `fairyState.ownerId`, `_pendingPrisonerExchange`, `_pendingReciprocalCheck`,
  `_freshCaptures`.
- **Hors de `gameState`** : `UndoManager.remapPlayerId` (snapshots d'annulation) et `placedMeeples[].playerId`.
  `home.js` `_remapPlayerEverywhere` regroupe les trois.
- **Hôte** : CAS 3 de `initInGameNetworkHandler` l'appelle puis diffuse `player-id-remapped { oldId, newId }` ;
  **invités** : `GameSync.onPlayerIdRemapped` → `GameSyncCallbacks` → `_remapPlayerEverywhere`.

**Règle** : tout id de joueur stocké hors de `players` doit être ajouté à `remapPlayerId` / `remapExtraStateIds`.

---

## 5. `gameState.extraState` et états `_pending*`

### Quand l'utiliser

`placedMeeples` convient à un pion qui appartient à un joueur, occupe une des 25 positions d'une tuile et suit le cycle
de vie d'un meeple classique (Bâtisseur, Cochon). Pour une pièce qui **n'est pas** dans ce cas (position hors 5×5,
compteur, état riche comme hauteur+verrouillage+couleur), on range une sous-structure dans `gameState.extraState`
(aujourd'hui : `towers`, `prisoners`).

### Ce que le conteneur traite **génériquement** (aucune modification pour une nouvelle sous-clé)

- `GameState.serialize()/deserialize()` (un seul bloc) — **sauf** la liste explicite des sous-clés dans `deserialize()`
  (`towers`, `prisoners`) à compléter pour une nouvelle sous-clé ;
- `UndoManager` : snapshots (`saveTurnStart`/`saveAfterTilePlaced`/`saveDragonMove`) et `restoreExtraState` ;
- réseau (`full-state-sync`, `host-snapshot`, `turn-undo`/`postUndoState`).

### Ce qu'il reste à faire pour une nouvelle extension

- **Rendu après restauration** : écrire un `renderAllXxxFromState()` (modèle : `TowerUI.renderAllTowersFromState`) qui
  efface puis redessine tout depuis `extraState`, et le brancher à `UndoManager.applyLocally` (via
  `initVisualHandlers`) et `ReconnectionManager.applyFullStateSync`.
- **Champs `_pending*` / compteurs « par tour »** : transitoires, **non sérialisés**, volontairement **hors**
  `extraState`. À réinitialiser explicitement dans : `UndoManager.restoreSnapshot`/`applyRemote`,
  `HostMigration._resetTurnTransientState`, et, selon le cas, au début du tour suivant (`home.js`, listener
  `tile-drawn`, bloc `isOwnTurnStart` — nécessaire côté **invité**, dont la branche de fin de tour ne nettoie pas
  sa copie locale) ou sur `turn-changed`.
- **Effet qui mute un autre joueur** (échange de prisonniers) : le **différer à la fin du tour**
  (`checkPendingReciprocalExchange`, appelé juste après `undoManager.reset()` dans `GameEventSetup._installEndTurn` et
  `GameSyncCallbacks.onTurnEndRequest`), pour ne pas être incohérent si l'action déclencheuse est annulée.
- **Choix bloquant** : si l'effet différé demande un choix, le tour suivant démarre déjà avant. Pattern : UI de choix
  **non fermable** pour tous sauf le joueur concerné, plus trois résolutions pour ne jamais bloquer :
  (1) exclusion/déconnexion réelle du joueur → résolution automatique par une règle par défaut
  (`resolvePendingPrisonerExchangeForPlayer`, appelé par `excludeDisconnectedPlayer` **avant** de muter `players`) ;
  (2) rechargement de page → l'état transitoire est retransporté par le full-state puis restauré et réaffiché
  (`restorePendingPrisonerExchangeUI`) ; (3) reconnexion sous nouvel id → remap (§4).
- **Pion générique (fée, dragon) qui doit pouvoir cibler la nouvelle pièce** : lui donner une clé distincte du format
  `"x,y,position"` et parcourir **chaque** endroit qui lit une clé de pion (voir §7).
- **Sélection dans le panel d'un autre joueur** : réutiliser `ScorePanelUI.enablePrisonerSelection()` /
  `forceOpenPlayerPanel()` ; le masquage/mise en avant (`.prisoner-selection-target|chooser|hidden`, voile
  `#prisoner-selection-overlay`) est déjà générique.

---

## 6. Extension Tour

- **Activation** : `tiles-tower` (tuiles, `data/Tower/`) + `ext-tower` (règle), coche maître `all-tower`. `TowerRules`
  n'existe que si `tileGroups.tower && extensions.tower`.
- **Stock de pièces** : attribué au lancement selon le nombre de joueurs non spectateurs
  (`TowerConfig.TOWER_PIECES_BY_PLAYER_COUNT`, `GameStarter._initGameState`) et **figé** dans
  `gameState.towerPiecesQuota` (sérialisé, champ de premier niveau : constante de partie, pas un état de plateau).
  Un joueur qui **arrive en cours de partie** reçoit ce même quota (CAS 1 de `initInGameNetworkHandler` côté hôte,
  handler `players-update` côté invités — même valeur partout, rien à transporter). Un joueur qui revient (CAS 3/5)
  garde son stock. Spectateurs : aucune pièce.
- **Pose d'étage** : sur une tuile à zone `tower` non verrouillée ; consomme une pièce et la **phase meeple** du tour
  (`undoManager.markMeeplePlaced(x, y, -1, null)`), puis nettoie tous les curseurs (`hideAllCursors`).
- **Capture** : après un étage, cibles sur la tuile + 4 directions en **ligne continue** jusqu'à distance = hauteur
  (`getCaptureTargets`). Auto-capture → retour en réserve ; capture d'un adversaire → prisonnier
  (`extraState.prisoners[capturant]`). Bâtisseurs/Cochons orphelins du meeple capturé sont rendus (même algorithme
  que le dragon). La mutation n'a lieu que dans `applyCaptureExecuted`, appelée à l'identique par l'hôte et les
  invités.
- **Verrouillage** : à partir de 1 étage, n'importe quel joueur peut verrouiller avec un meeple normal ou grand
  meeple de sa réserve ; consomme la phase meeple (et nettoie les curseurs, comme l'étage). **Interdit sur la tuile
  où se trouve le dragon** (`TowerRules.lockTower`, et options masquées côté UI).
- **Échange automatique de prisonniers** : après une capture non-auto, si le propriétaire capturé Y détient déjà
  des prisonniers du capturant X : un seul type → résolution automatique (le type revient à X **et** le meeple
  fraîchement capturé retourne toujours à Y, `freshlyCapturedType`) ; plusieurs types → X choisit (modale « Choisir »
  → panel de Y en mode sélection). Déclenché **à la fin du tour** (§5), jamais immédiatement. L'ordre chronologique
  de `checkReciprocalCapture` fait de `availableTypes[0]` le prisonnier le plus ancien (règle de résolution
  automatique). Le rôle visuel des panels pendant le choix (cible assombri avec prisonniers sélectionnables au-dessus,
  choisisseur assombri sur desktop, autres masqués) est posé par `ScorePanelUI` d'après `playerId`/`chooserId`.
- **Rachat de prisonnier** (`PRISONER_BUYBACK_COST`) : uniquement **pendant son propre tour** et **une seule fois par
  tour** (un tour bonus compte comme la suite : `gameState._turnBuybackUsed`, remis à `false` seulement à l'entrée
  d'un vrai nouveau tour, `home.js` listener `turn-changed`). Bloqué tant qu'un échange est en attente et tant que la
  capture est « fraîche » (`_freshCaptures`, vidé à chaque `turn-changed`). Revalidé par l'hôte
  (`executePrisonerBuybackHost`, seule source de vérité). Le rachat modifie le score et `scoreDetail.buybacks` : ces
  champs sont donc **sauvegardés/restaurés avec les snapshots d'annulation** et transmis dans `postUndoState`, avec
  `_turnBuybackUsed`.
- **Undo** : étage, capture, verrouillage et dragon-mange-garde sont annulables (granularité « tout-en-un » : annuler
  après une capture annule aussi l'étage du même tour). `UndoManager.applyLocally` redessine l'état Tour via
  `renderAllTowersFromState`. `_pendingTowerCapture`/`_pendingReciprocalCheck` sont remis à zéro à la restauration.
  L'échange automatique en tant que tel n'est pas annulable (il n'a lieu qu'une fois la capture verrouillée).
- **Reconnexion** : tours et gardes redessinés par `applyFullStateSync` ; un choix d'échange en attente est restauré.
- **Scoring** : aucun point direct, hors rachat (`scoreDetail.buybacks`, colonne affichée seulement si
  `gameState.hasPrisonerBuybacks`).
- **Limite connue** : le remap d'id couvre `extraState.towers.lockedBy` via `remapExtraStateIds` ; toute nouvelle
  référence d'id dans `extraState` doit y être ajoutée.

---

## 7. Interaction Dragon / Fée ↔ garde de tour

Un garde qui verrouille une tour vit dans `gameState.extraState.towers[x,y]` (`lockedBy`, `lockMeepleType`,
`lockMeepleColor`), **pas** dans `placedMeeples`. Il est identifié par la clé spéciale **`"tower-lock:x,y"`**, que
tout code manipulant une clé de pion doit reconnaître :

| Où | Ce qui est géré |
|---|---|
| `TowerRules.getCaptureTargets` / `executeCapture` | le garde est une cible de capture |
| `TowerUI.applyCaptureExecuted` | déverrouille la tour, retire `.tower-lock-meeple`, détache la fée |
| `DragonRules._eatMeeplesAt` | le dragon mange le garde (retour en réserve, déverrouillage, fée détachée) |
| `DragonRules.getFairyTargets` | la fée peut être attachée à un garde du joueur |
| `MeepleActionsUI.showMeepleActionCursors` | résout le meeple via `extraState.towers`, ancre le curseur via `getTowerLockMeepleAnchor` |
| `DragonUI.renderFairyPiece` | ancre le pion fée via `getTowerLockMeepleAnchor` (import à sens unique depuis `TowerUI`) |
| `DragonUI.executeDragonMoveHost` | retire `.tower-lock-meeple` (et non `.meeple[data-key]`), puis resynchronise la fée |
| `GameState.isFairyOnTile` | reconnaît le format pour que la fée continue de bloquer le dragon |
| `home.js` handler `network-dragon-state-update` | côté invité : retire le pion **et** déverrouille `extraState.towers[coords]` localement |

Règles à retenir :
- **`broadcastDragonState()` ne transporte jamais `extraState`** : toute mutation d'`extraState` déclenchée par le
  dragon doit être **répliquée à la main côté invité** (sinon la tour reste « verrouillée » localement : étage
  impossible, fée qui cible un garde disparu).
- **La fée ne disparaît jamais du plateau une fois posée** : quand son porteur (meeple ou garde) est capturé, mangé ou
  rendu par une fermeture de zone, on la **détache** (`fairyState.ownerId = null`, `meepleKey` conservé) au lieu de
  `removeFairy()` ; elle continue de bloquer le dragon jusqu'à ce qu'un joueur la reprenne
  (modèle : `DragonUI.releaseFairyIfDetached`).
- Une action qui **consomme la phase meeple** (étage, verrouillage) doit nettoyer les curseurs pour le joueur local
  (`hideAllCursors`), sinon un curseur fée déjà affiché reste cliquable.

---

## 8. Check-list d'une nouvelle extension

1. **Plan avant code** : règles touchées, modules impactés, cohérence avec les extensions existantes ; options
   possibles à présenter à l'utilisateur.
2. **Représentation** : meeple classique (`placedMeeples`, nouveau `type`, poids dans `MeepleUtils`) **ou** état
   persistant (`extraState`, §5).
3. **Lobby** : case(s) dans `index.html`, `LobbyOptions.js` (dispo, coche maître, `PRESET_MAP`, sauvegarde, compteur
   de tuiles), synchro `home.js` (`_installHostLobbyOptionSync`, `currentOptions`), liste d'ids de
   `LobbyJoin` (`options-sync`), `gameConfig` dans le clic « Démarrer », `ModalUI.showGameRules`.
4. **Tuiles** : `data/{Groupe}/`, chargement dans `Deck.loadAllTiles`, exclusion des zones non meeple dans
   `MeepleCursorsUI.EXCLUDED_ZONE_TYPES`.
5. **Réseau** : requêtes invité → hôte (`_attachHostCallbacks`), diffusion (`GameSync` + `attach`), `relayTypes` si
   l'action doit atteindre les autres invités (§2). Listeners `eventBus` protégés contre la double installation (§1.1).
6. **Snapshots/undo** : sous-état dans `extraState` ; champs `_pending*` réinitialisés (§5) ; rendu
   `renderAllXxxFromState` branché à l'undo et à `applyFullStateSync`.
7. **Changement d'hôte** (§3) : `_pending*` dans `_resetTurnTransientState` ; tout changement de tuile/pioche en cours
   de tour rediffuse le snapshot ; tout message traité par un handler lobby invité doit être inoffensif pour un hôte.
8. **Ids de joueur** hors de `players` → `remapPlayerId` / `remapExtraStateIds` (§4).
9. **Rendu DOM différé** dans `applyFullStateSync` : relire l'état courant à l'exécution (§1.2).
10. **Pions génériques** (fée, dragon) pouvant cibler la nouvelle pièce : clé distincte + parcours de tous les lieux
    qui lisent une clé de pion (§7).

---

## 9. Extensions à venir (non commencées)

Aide-mémoire des pièges déjà identifiés ; chaque extension est traitée une par une, **plan d'abord**.

| Extension | Nature | Pièges à anticiper |
|---|---|---|
| Maire, Chariot, Directeur | Meeple classique (`placedMeeples`, nouveau `type`) | Suivre Bâtisseur/Cochon : poids de majorité dans `MeepleUtils`, exclusion des zones non concernées ; à ajouter à `TOWER_CAPTURABLE_MEEPLES` |
| Berger + jetons moutons | Meeple + compteur non-meeple | Berger dans `placedMeeples` ; moutons dans `extraState.sheep` (compteur par position) ; prévoir l'undo si l'action est en 2 temps |
| Grange | Pion à l'intersection de 4 tuiles | Hors format `"x,y,position"` : nouveau schéma de clé dans `extraState` |
| Pont | Pièce au centre d'une tuile, modifie la connectivité des bords | Touche `Tile.getEdgeType` / `Board.canPlaceTile`, pas seulement l'affichage — chantier le plus structurant |
| Forteresse | Modificateur de score attaché à une ville | Probablement `Scoring.js` / `InnsRules.js` plutôt qu'un nouveau pion — à confirmer |
| Zone à 3 meeples empilés | Casse « une clé = 0 ou 1 meeple » | Impacte `ZoneMerger.getZoneMeeples`, `MeeplePlacement.canPlace`, `Scoring` : plan dédié avant tout code |

---

## 10. Panneaux joueurs (spectateurs, barre mobile)

- **Spectateurs** : jamais une carte chacun. `ScorePanelUI._getDisplayGroups()` sépare joueurs et spectateurs ; tous
  les spectateurs sont regroupés en **une** carte (clé `SPECTATORS_KEY`, qui n'est pas un id de joueur : à gérer dans
  tout code qui lit `dataset.playerId` des cartes). Elle est masquée pendant une sélection de prisonnier. Au lobby,
  `LobbyUI` compte les 6 emplacements hors spectateurs et liste ceux-ci dans un bloc séparé.
- **Barre mobile** : `#mobile-players-scores` défile horizontalement (cartes de largeur minimale
  `--mobile-card-min-w`, `0` = ancien comportement compressé). Le rendu vide le conteneur : `scrollLeft` est donc
  sauvegardé/restauré à chaque rendu, et le joueur actif n'est recentré que lorsqu'il **change** (`_lastActiveId`),
  par un calcul synchrone (pas de `requestAnimationFrame`, cf. §1.2). Les classes `can-scroll-left/right`
  (`_updateScrollFade`) estompent par masque CSS le bord où il reste des cartes ; `--mobile-fade-w: 0` le désactive.
- **Panel de détail mobile** : `#mobile-player-detail` se place sous la barre via `--mobile-bar-h`, mesurée par un
  `ResizeObserver` dans `ScorePanelUI` — ne jamais le positionner avec un `top` en dur. Le pseudo n'est pas sur la
  carte mobile mais dans `.mobile-player-detail-header`.
