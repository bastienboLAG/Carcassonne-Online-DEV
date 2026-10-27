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
10. Panneaux joueurs (spectateurs, barre mobile, rangées de pions)
11. Pistes envisagées, non commencées (plein écran mobile / PWA)
12. Points à corriger ou à surveiller (non traités)
13. À faire en toute fin de développement

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
- **Rotation de la tuile en main** : le message `tile-rotated` porte la rotation **absolue** (l'invité l'envoie à
  partir de son état local, l'hôte la relaie à tous). **Règle** : tout affichage doit se **recaler sur cette valeur
  absolue** (jamais « angle courant + 90° »), car un même message peut arriver deux fois — un invité qui clique
  deux fois avant le retour du premier écho envoie deux fois la même valeur. L'angle CSS reste cumulé (toujours dans
  le même sens, pour que l'animation de 0,3 s ne tourne pas à l'envers) mais congruent à la valeur reçue ; un message
  en double ne change rien (`GameSyncCallbacks.onTileRotated`). Limite connue : deux clics très rapprochés d'un invité
  ne produisent qu'**une** rotation (le protocole est absolu et l'état local n'a pas encore bougé) ; l'hôte, lui,
  applique chaque clic localement.
- **Détection d'un départ** : PeerJS n'émet pas toujours `close` à la fermeture d'un onglet (observé : jamais émis),
  et le heartbeat ne le découvre qu'après ~12 s (timeout 10 s + tick 3 s). Un invité qui quitte la page envoie donc
  `page-closing` (`Multiplayer`, `pagehide` hors bfcache) ; l'hôte l'exécute comme une fermeture détectée
  (`onClose`, rendu **idempotent** par `conn._closeHandled` : `page-closing` puis `close` tardif ne déclenchent
  `onPlayerLeft` qu'une fois). Best-effort : le heartbeat reste le filet de sécurité. `page-closing` est intercepté
  dans `Multiplayer` — il n'atteint jamais les handlers de jeu/lobby, qui voient simplement `onPlayerLeft`.
  `handleDisconnect` (`ReconnectionManager`) est **idempotent** : un joueur déjà `disconnected` ou `kicked` est ignoré
  (évite une seconde notification `player-disconnected` et un second « Partie en pause » pour le même départ).
- **Signalisation PeerJS ≠ lien de données** : chaque pair a deux liens — la WebSocket vers le serveur PeerJS public
  (« broker » : sert seulement à se trouver par id et à établir les connexions) et la connexion WebRTC directe vers
  l'hôte (tout le jeu y passe). Une erreur du broker (`network`, `server-error`, `disconnected`) **n'implique pas** que
  l'hôte soit perdu. **Règle** : `Multiplayer.joinGame` ne déclenche `onHostDisconnected` sur une telle erreur que si
  `isHostLinkAlive()` est faux (connexion fermée, ou aucune donnée reçue de l'hôte depuis 7 s — l'hôte envoie un ping de
  heartbeat toutes les 3 s) ; sinon la reprise d'hôte fermerait volontairement (`reconnectTo`) une connexion saine et
  provoquerait une fausse pause chez l'hôte. Dans tous les cas, `_installSignalingKeepAlive` (hôte **et** invités,
  idempotent par peer) rappelle `peer.reconnect()` tant que la signalisation est perdue, pour rester joignable par id.
  Contrepartie : si une vraie perte de l'hôte coïncide avec une erreur du broker, la détection passe par la fermeture de
  sa connexion ou par le heartbeat (jusqu'à ~10 s).
- **Logs de diagnostic `[NET]`** (`Multiplayer.js`, aucune logique de jeu, à joindre à tout rapport de coupure) : événements
  PeerJS (signalisation perdue/rétablie, erreurs, fermeture), par connexion (ouverture, fermeture avec l'âge du dernier
  message et « abandonnée volontairement » le cas échéant, états ICE/WebRTC), `online`/`offline` du navigateur, visibilité de
  la page (`cachée` / `visible`), type de réseau quand `navigator.connection` existe (Chrome/Edge/Opera ; absent sur
  Safari/iPhone et Firefox ; `effectiveType` mesure la qualité et ne distingue pas 4G de 5G). Un seul minuteur de 2 s
  signale un **retard du minuteur** (page suspendue : écran verrouillé, arrière-plan) et un **silence > 5 s** sur une
  connexion (avec la durée à la reprise). Les pings de heartbeat portent un horodatage (`t`) que le pong renvoie (`to` = émetteur) :
  un temps de réponse > 500 ms est journalisé. Le coût en jeu est négligeable (événementiel, quelques octets par heartbeat).
- **`players-update` côté invité** (`initInGameNetworkHandler`) filtre et complète `gameState.players` : le handler
  recale `currentPlayerIndex` sur l'**objet** joueur courant (pas sur son id, qui peut être remappé dans le même handler)
  et le ramène dans les bornes — sinon il pointe hors tableau (`getCurrentPlayer()` indéfini) ou sur un autre joueur.
  `TurnUI.updateTurnDisplay` tolère en outre un joueur courant introuvable.
- **Fin de partie** : l'état « partie terminée » est `gameState.finalScoresData` (scores détaillés, `null` tant que la
  partie dure), **sérialisé** donc transporté par `full-state-sync` / `host-snapshot` / `turn-ended`. `FinalScoresManager`
  n'en garde aucune copie locale : `gameEnded` / `finalScoresData` en sont dérivés (accesseurs). Un joueur qui revient
  après l'écran des scores retrouve ainsi « Détails des scores », le verso de tuile (relu à l'exécution dans le
  `requestAnimationFrame` d'`applyFullStateSync`), et la modale s'ouvre seule une fois (`autoModalDone`, géré dans
  `TurnUI.updateTurnDisplay`). `destroyedTilesCount` est sérialisé pour la même raison. `GameTimer` fige l'instant d'arrêt :
  la durée envoyée à un joueur qui revient reste la durée finale.
  **Après la fin**, `handleDisconnect` (`ReconnectionManager`) n'affiche ni pause ni `player-disconnected` : il retire
  seulement le joueur de `players` (liste du lobby, évite le fantôme au retour lobby) et le garde marqué `disconnected`
  dans `gameState` (une reconnexion sur l'écran des scores reste le CAS 3). Limite : les autres invités le perdent
  de leur panneau latéral jusqu'à son retour (où il réapparaît à 0 point côté panneau ; la modale reste exacte).
- **Paquet d'état complet** : `GameSync.buildFullStateMessage` (arguments via `ReconnectionManager.collectFullStateArgs`),
  utilisé à la fois par `full-state-sync` (reconnexion) et `host-snapshot` (changement d'hôte). **Tout champ ajouté
  là est couvert par les deux mécanismes.** Tout état de partie qui doit survivre à une reconnexion est de préférence
  placé dans `gameState` (`serialize`/`deserialize`) plutôt que dans ce paquet. Les champs transitoires non sérialisés par
  `gameState.serialize()` qui doivent survivre à un rechargement (ex. `_pendingPrisonerExchange`) doivent y être
  transportés explicitement. Pour le tour d'un **invité**, la tuile en main est lue dans le **miroir de l'hôte**
  (`getTuileEnMain`, tenu à jour par `tile-drawn` et `tile-rotated`) lorsqu'il s'agit de la même tuile que
  `getCurrentTileForPlayer` : l'objet de pioche brut n'a pas de rotation courante (`collectFullStateArgs`).
- **Options du lobby** : toute nouvelle case doit figurer dans **quatre** listes d'ids tenues à la main —
  `home.js` (`_installHostLobbyOptionSync` pour le temps réel, `currentOptions` pour l'invité qui arrive),
  `LobbyOptions.syncAllOptions` (preset appliqué par l'hôte) et `LobbyJoin` (`options-sync`, côté invité) —
  plus `PRESET_MAP`, `saveLobbyOptions` et le sélecteur de sauvegarde auto de `LobbyOptions`. Un id oublié dans
  `LobbyJoin` fait que l'invité ne reçoit pas l'option à l'arrivée.
- **Capacité** : 6 joueurs non spectateurs maximum. `'spectator'` n'est jamais une couleur « prise » (spectateurs
  illimités). Un nouvel arrivant sans couleur libre devient spectateur, au lobby (`home.js`, handler `player-info`)
  comme en partie (`ReconnectionManager`, CAS 1 → CAS 2). `game-in-progress` transporte `full` et `reservedNames`
  (pseudos des joueurs non spectateurs) : `LobbyJoin` masque « Joueur » si `full` et pseudo non réservé — un joueur
  qui revient doit toujours pouvoir reprendre sa place (CAS 3). Un joueur converti en spectateur aligne son
  `playerColor` local sur `'spectator'` (`applyFullStateSync`).
- **Validation hôte** : l'hôte ne fait jamais confiance au client (ex. `getCurrentPlayer()?.id === from` avant
  d'appliquer une requête de tour) ; l'identité fiable est `from`, pas un champ du message.
- **Limite connue : pas de serveur TURN.** `Multiplayer._peerOptions()` ne déclare que des serveurs STUN (Google).
  La signalisation (WebSocket vers le serveur cloud PeerJS) passe partout, mais la connexion de jeu (WebRTC/UDP, en
  direct entre navigateurs) échoue derrière un proxy ou un VPN qui ne transporte pas l'UDP (observé : proxy intégré
  d'Opera). `joinGame()` n'a pas de timeout et un échec ICE ne produit aucune erreur PeerJS : l'invité reste bloqué sans
  message (`reconnectTo()`, lui, a un timeout de 4 s). Piste connue, **non retenue pour l'instant** : ajouter un relais
  TURN gratuit (Open Relay, Cloudflare…), utilisé seulement en dernier recours par ICE, donc sans effet pour les joueurs
  dont la connexion directe fonctionne. Contreparties : l'identifiant du relais serait forcément public (site statique,
  quota consommable par un tiers), quota mensuel (estimation : quelques Mo par partie et par joueur concerné, jamais
  mesurée), fournisseur tiers supplémentaire (à mentionner dans le README), et efficacité sur le proxy d'Opera non
  vérifiable sans vrai VPN. Un message d'erreur sur timeout a été écarté : il ne détecte pas la cause (un site web ne
  peut pas savoir si un VPN est utilisé).

---

## 3. Changement d'hôte (`HostMigration`)

Livré **en partie et au lobby**. Constantes (délai de grâce, sondage, balayage) : voir le début de
`HostMigration.js` ; heartbeat : `HeartbeatManager.js`.

### Principe

- Id PeerJS = code à 6 chiffres, **pour les invités aussi** (`Multiplayer._openGuestPeer`). L'id d'un invité promu
  devient le **nouveau code de partie** ; on ne récupère jamais l'ancien code.
- **Snapshot** : à chaque `syncTurnEnd`, l'hôte diffuse `host-snapshot` = paquet d'état complet + `hostId` +
  `candidates` (successeurs, ordre de `gameState.players`, hors spectateurs/déconnectés/exclus).
- **Détection (invité)** : fermeture de la connexion de `hostPeerId`, erreur de signalisation PeerJS **seulement si le lien de données n'est plus vivant** (§2), ou heartbeat muet →
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
id (`ensurePeerReady`, `_installSignalingKeepAlive`). Deux issues :
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
- **Poids du snapshot** : mesuré en partie réelle (6 joueurs, ~180 tuiles), `host-snapshot` pèse ~136 Ko en moyenne
  (jusqu'à ~240 Ko), diffusé à chaque fin de tour à **chaque** invité ; avec `tile-placed` (~34 Ko, registre de zones
  inclus) et `score-update` (~38 Ko), l'hôte envoie de l'ordre de 1 Mo par tour. L'essentiel vient de la pioche
  (`deck.tiles` : chaque exemplaire répète toutes les zones de sa tuile) et du registre de zones. **Piste
  d'optimisation, à faire avec précaution** : n'envoyer que l'ordre de la pioche (ids) + une table des définitions de
  tuiles, ou ne renvoyer la pioche que lorsqu'elle change. Précautions : le snapshot est le socle du changement d'hôte
  et de la reconnexion (§2) ; tout allègement doit rester restaurable à l'identique par `applyFullStateSync`, et être
  testé en promotion d'hôte, en reconnexion et après une repioche (tuile implaçable / dragon). Priorité faible : aucune
  coupure observée ne suivait ces envois.

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

- **Activation** : `tiles-tower` (tuiles, `data/Tower/`) + `ext-tower` (« Capture par les tours », règle), coche maître
  `all-tower`. `TowerRules` n'existe que si `tileGroups.tower && extensions.tower`. **Rançon** : sous-option
  `ext-ransom` (`extensions.ransom`), **dépendante de `ext-tower`** (décochée et grisée sans elle,
  `LobbyOptions._updateRansomAvailability`) ; listée à la suite de la capture, sans décalage, dans le lobby et dans
  « Règles de cette partie » (`ModalUI`, avec le total de tuiles Tour).
- **Stock de pièces** : attribué au lancement selon le nombre de joueurs non spectateurs
  (`TowerConfig.TOWER_PIECES_BY_PLAYER_COUNT`, `GameStarter._initGameState`) et **figé** dans
  `gameState.towerPiecesQuota` (sérialisé, champ de premier niveau : constante de partie, pas un état de plateau).
  Un joueur qui **arrive en cours de partie** reçoit ce même quota (CAS 1 de `initInGameNetworkHandler` côté hôte,
  handler `players-update` côté invités — même valeur partout, rien à transporter). Un joueur qui revient (CAS 3/5)
  garde son stock. Spectateurs : aucune pièce.
- **Pose d'étage** : sur une tuile à zone `tower` non verrouillée ; consomme une pièce et la **phase meeple** du tour
  (`undoManager.markMeeplePlaced(x, y, -1, null)`), puis nettoie tous les curseurs (`hideAllCursors`).
- **Hauteur illimitée, rendu plafonné** : `height` n'a aucun plafond (maximum théorique = stock total de pièces, 30
  à 5-6 joueurs) et la portée de capture suit toujours la hauteur réelle. Seules les images s'arrêtent à
  `Tower10` : au-delà de 10 étages, `TowerUI.renderTowerHeight` garde `Tower10` et ajoute un badge numérique
  (`.tower-height-badge`, hauteur réelle) à la base de la tour, avec la même transparence que la tour
  (`MeepleConfig` `Tower`.`plateOpacity`). Tout code qui efface les pions de tour doit aussi effacer ce badge
  (`renderAllTowersFromState`).
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
  → panel de Y en mode sélection). Déclenché **à la fin du tour** (§5), jamais immédiatement. Indépendant de
  l'option rançon. L'ordre chronologique de `checkReciprocalCapture` fait de `availableTypes[0]` le prisonnier le plus
  ancien (règle de résolution automatique). Le rôle visuel des panels pendant le choix (cible assombri avec
  prisonniers sélectionnables au-dessus, choisisseur assombri sur desktop, autres masqués) est posé par
  `ScorePanelUI` d'après `playerId`/`chooserId`.
- **Rachat de prisonnier / rançon** (`PRISONER_BUYBACK_COST`) : **uniquement si `extensions.ransom`** — sans elle, les
  prisonniers ne se libèrent que par échange automatique (garde dans `TowerUI.setupPrisonerBuyback`, côté UI, **et**
  `executePrisonerBuybackHost`, côté hôte, seule source de vérité). Puis : **pendant son propre tour** et **une seule
  fois par tour** (un tour bonus compte comme la suite : `gameState._turnBuybackUsed`, remis à `false` seulement à
  l'entrée d'un vrai nouveau tour, `home.js` listener `turn-changed`). Bloqué tant qu'un échange est en attente et
  tant que la capture est « fraîche » (`_freshCaptures`, vidé à chaque `turn-changed`). Le rachat modifie le score et
  `scoreDetail.buybacks` : ces champs sont donc **sauvegardés/restaurés avec les snapshots d'annulation** et transmis
  dans `postUndoState`, avec `_turnBuybackUsed`. Le coût affiché dans le lobby (`index.html`) est écrit en dur : à
  garder aligné sur `TowerConfig.PRISONER_BUYBACK_COST` (la modale de règles, elle, le lit depuis la config).
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
3. **Lobby** : case(s) dans `index.html` (une sous-option dépendante se range à la suite de sa case parente, sans
   décalage, désactivée tant que celle-ci est décochée : modèle `ext-ransom`), `LobbyOptions.js` (dispo, coche maître,
   `PRESET_MAP`, sauvegarde, compteur de tuiles), les listes d'ids de synchro (§2, « Options du lobby »), `gameConfig`
   dans le clic « Démarrer », `ModalUI.showGameRules` (bloc de l'extension dans `extensionBlocks` : toutes ses règles
   y figurent toujours, avec ✓/✗ ; + total de tuiles). Les extensions s'affichent dans le lobby et dans les règles
   dans l'ordre : Base, Abbé, Auberges & Cathédrales, Marchands & Bâtisseurs, Princesse & Dragon, Tour.
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
10. **Pions génériques** (fée, dragon) pouvant cibler la nouvelle pièce : clé distincte + parcourir tous les lieux
    qui lisent une clé de pion (§7).
11. **Panneau joueur** : ranger la pièce dans la bonne rangée de `ScorePanelUI._buildMeeplesDisplay`, lire sa donnée
    dans `_getPieceExtras`, ajouter ses tailles dans `MeepleConfig.js` (§10).

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
| Roi, Brigand | Jetons uniques partagés (un seul détenteur à la fois) | Donnée = id du détenteur (pas un compteur) ; à ranger dans `extraState` et à remapper (§4) |
| Tuile bonus monastère | Une tuile par joueur | État par joueur (possédée ou non) à ranger dans `extraState`, remap d'id (§4) |
| Zone à 3 meeples empilés | Casse « une clé = 0 ou 1 meeple » | Impacte `ZoneMerger.getZoneMeeples`, `MeeplePlacement.canPlace`, `Scoring` : plan dédié avant tout code |

---

## 10. Panneaux joueurs (spectateurs, barre mobile, rangées de pions)

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
- **Contenu d'un panneau : 4 rangées dans un ordre fixe**, construites par `ScorePanelUI._buildMeeplesDisplay`
  (identique PC et mobile, seule la taille change via le contexte `panel` / `panelMobile`) :
  1. **meeples** : Normal, Abbé, Grand, Maire, Chariot, Berger, Directeur, puis Bâtisseur + Cochon en **bloc
     insécable** (ils passent à la ligne ensemble ou pas du tout) ;
  2. **structures** : Grange, Forteresse, Tour, Pont ;
  3. **jetons** : Blé, Vin, Tissu, Mouton, Roi, Brigand ;
  4. **butin** : tuile monastère (une par joueur) à gauche, prisonniers à droite (toute la largeur s'il n'y a pas de tuile).
- **Règles d'affichage** : flux libre avec retour à la ligne (pas de colonnes fixes, pas de libellés de rangée, pas
  de séparateur) ; une rangée sans élément n'est **pas rendue** (aucune marge fantôme) ; les icônes ne sont **jamais
  réduites** pour gagner de la place. Chaque chip a une **case de hauteur commune** (`_cellHeight`, calculée depuis
  `MeepleConfig` : suit toute modification de taille) ; l'icône y est centrée et le compteur `×N` est ancré sur le bas
  de la case, donc tous alignés (`_buildChip`). `×0` est conservé ; les **réserves** (meeples, Tour, structures) sont
  grisées (`.unavailable`) à 0, les **jetons accumulés** (marchandises, moutons) ne sont jamais grisés. **Sans
  compteur** : Roi, Brigand (jetons uniques, affichés seulement chez leur détenteur), tuile monastère (une par
  joueur) et prisonniers (individuels). Écart entre rangées posé en ligne dans `_buildMeeplesDisplay`. Les styles de ces rangées
  sont posés **en ligne** dans `ScorePanelUI` (comme l'ancienne rangée de marchandises), pas dans `style.css`.
- **Brancher une nouvelle pièce** : l'ajouter dans la bonne rangée de `_buildMeeplesDisplay`, lire sa donnée réelle
  dans `_getPieceExtras(player)` (point de branchement unique ; clé absente = pièce non affichée), déclarer ses
  tailles `w/h` + échelles dans `MeepleConfig.js`. Image : pion par couleur dans `assets/Meeples/{Couleur}/`, pion
  neutre dans `assets/Meeples/`, jeton ou tuile dans `assets/Misc/C2/` (casse exacte).
- **Aperçu provisoire** : `ScorePanelPreview.js` ajoute un bouton 🎨 (visible uniquement si « Mode debug » est
  coché au lobby) pour afficher des pièces **fictives** et juger l'agencement. Purement visuel : aucun impact sur
  `gameState`, le réseau ou l'undo. Pour le retirer : supprimer le fichier, puis l'import, l'appel dans le
  constructeur/`destroy()` et la ligne `getScorePanelPreviewExtras` de `_getPieceExtras` dans `ScorePanelUI.js`.

---

## 11. Pistes envisagées, non commencées (plein écran mobile / PWA)

Sujet évoqué, **volontairement reporté** : agrandir le jeu sur mobile en masquant la barre d'adresse du navigateur.
Rien n'est implémenté. Deux pistes retenues, à traiter seulement sur demande de l'utilisateur (plan d'abord) :

- **Mode PWA (installation sur l'écran d'accueil)** — seule solution valable sur **iPhone ET Android**. Un simple
  raccourci créé depuis Chrome **ne suffit pas** (il s'ouvre avec la barre d'adresse) : il faut un fichier de
  description (`manifest`, avec `display: standalone` ou `fullscreen`, icônes 192/512 px, couleurs, éventuellement
  `orientation`), les balises `<meta>` Apple dans `index.html`, et sur Android un **service worker minimal sans aucune
  mise en cache** (requis par Chrome pour proposer « Installer l'application »). Sans cache, une mise à jour du site
  est récupérée à chaque lancement comme aujourd'hui ; le seul point différent : pas de bouton « actualiser » dans une
  PWA, le joueur doit fermer complètement l'appli puis la rouvrir. Le contrôle `APP_VERSION` (`version.js`) continue de
  refuser une version différente à la connexion ; options d'amélioration envisagées mais non retenues : message de
  refus rappelant de fermer/rouvrir l'appli, ou détection automatique d'une nouvelle version.
- **Bouton « Plein écran » dans le menu en jeu, Android uniquement** — via la Fullscreen API. Contraintes
  structurantes à garder en tête :
  - elle exige un **geste de l'utilisateur sur son propre appareil** : l'hôte qui clique sur « Démarrer la partie »
    ne peut **pas** y faire passer les invités (le démarrage leur arrive par message réseau) ; chacun doit activer le
    mode lui-même (bouton, ou clic sur « Rejoindre » côté invité) ;
  - elle est **indisponible sur iPhone** (Safari iOS) : le bouton ne doit s'afficher que si
    `document.documentElement.requestFullscreen` existe ;
  - elle fait double emploi avec la PWA si celle-ci est mise en place.
- **Réglages d'affichage mobile associés (indépendants du plein écran)** : `#game-page` utilise `100vh`, qui sur
  mobile inclut la zone de la barre d'adresse (barre du bas potentiellement rognée) → l'unité `100dvh` serait plus
  fiable ; `overscroll-behavior: none` sur le plateau éviterait le « tirer pour actualiser » d'Android pendant le
  déplacement vertical. `viewport-fit=cover` + `env(safe-area-inset-*)` seraient à ajouter pour les encoches en mode
  installé (seul `safe-area-inset-bottom` est utilisé aujourd'hui).
- **Points de compatibilité vérifiés avec l'existant** : sortir du plein écran ne déclenche rien côté réseau ; le
  handler `popstate` (« Voulez-vous vraiment quitter la partie ? ») intercepte déjà le bouton retour Android ; une
  PWA passe plus souvent en arrière-plan, mais heartbeat, reconnexion et `host-snapshot` (§3) restent valables sans
  adaptation.
- **Maintien de l'écran allumé (Screen Wake Lock API, `navigator.wakeLock`)** — idée évoquée, **reportée** : le
  temps de savoir si elle intéresse les joueurs mobiles. Contexte : sur mobile, un écran qui se verrouille suspend la
  page (heartbeat muet, désenregistrement du serveur PeerJS) ; un hôte en attente du tour d'un autre joueur y est
  particulièrement exposé. Hypothèse non prouvée à ce jour : les logs `[NET]` (§2 : `page cachée`, `minuteur en retard`) la confirmeraient ou l'infirmeraient lors d'une prochaine partie.

---

## 12. Points à corriger ou à surveiller (non traités)

Aucun point en attente.

Format : anomalie repérée dans des logs de partie réelle, **sans correction pour l'instant** — symptôme, cause (ou
« à vérifier »), piste. Retirer l'entrée dès qu'elle est corrigée ; si le correctif établit une règle durable, la
formuler dans la section concernée (pas ici).

---

## 13. À faire en toute fin de développement

Rien à faire tant que le développement des extensions et le débogage sont en cours : ces éléments restent utiles.

- **Nettoyage des commentaires** : les marqueurs `// ✅ FIX`, `// ✨ NOUVEAU` et les commentaires d'historique
  accumulés dans le code (ainsi que les en-têtes de fichiers qui racontent l'évolution plutôt que le rôle) seront
  à élaguer, en ne gardant que les commentaires qui expliquent un « pourquoi » encore valable.
- **Nettoyage des logs** : réduire les `console.log` (très nombreux, y compris des messages réseau complets) et
  l'`EventBus` en mode debug (`eventBus.setDebug(true)` dans `home.js`).
- **Logger maison de `index.html`** : il est **conservé complet** pour l'instant (export 📥, utile au débogage). Il
  stocke toutes les lignes en mémoire, messages réseau complets compris (un `host-snapshot` pèse ~240 Ko, l'export
  d'une partie de 3 h atteint ~70 Mo) : à alléger (tronquer les gros messages, ou le retirer) avant une diffusion
  large, notamment pour les joueurs mobiles.
