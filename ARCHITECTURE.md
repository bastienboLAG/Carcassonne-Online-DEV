# Architecture — Carcassonne Online (index de navigation)

> **Rôle de ce fichier : trouver vite quel(s) fichier(s) lire.** Une ligne par module, pas d'historique de bugs.
> Les règles de conception détaillées (réseau, changement d'hôte, `extraState`, extension Tour, check-list
> nouvelle extension…) sont dans **`docs/DESIGN_NOTES.md`** — à lire **uniquement** si la tâche touche ces sujets
> (renvois `→ DN §x` ci-dessous).

## Vue d'ensemble

Carcassonne en HTML/CSS/JS vanilla (modules ES, aucun framework), multijoueur P2P (PeerJS, topologie **en étoile**).
- **L'hôte fait autorité** : il valide, applique et diffuse. Un invité envoie une *requête*, attend le broadcast de l'hôte.
- Communication interne par un `EventBus` singleton ; les modules reçoivent leurs dépendances par **getters injectés**
  (`getXxx: () => variable`), jamais par import circulaire.
- Plateau = grille 100×100 de cases de 208 px ; une tuile = 5×5 positions de meeple (1-25).
- État de jeu : `GameState` (joueurs, dragon, fée, `extraState`), `placedMeeples` (map `"x,y,position"` → meeple),
  zones fusionnées dans `ZoneRegistry` via `ZoneMerger`.
- Extensions : Abbé, Grand Meeple, Auberges & Cathédrales, Marchands & Bâtisseurs (+Cochon), Princesse & Dragon
  (+Portail, Fée), Tour, Rivière.

## Racine

| Fichier | Rôle |
|---|---|
| `index.html` | Structure DOM (lobby, plateau, modales, panneaux mobile) |
| `style.css` | Tous les styles (lobby, jeu, mobile `≤768px`, panels de score, sélection de prisonniers) |
| `home.js` | Chef d'orchestre : état global, abonnements `eventBus` globaux, lobby (créer/rejoindre/démarrer), câblage des deps de tous les modules |
| `version.js` | `APP_VERSION` (compatibilité vérifiée à la connexion) |

## `modules/`

| Fichier | Rôle |
|---|---|
| `Board.js` | Plateau : `placedTiles`, `canPlaceTile` (check géométrique + contrainte rivière) |
| `Tile.js` | Modèle d'une tuile : zones, rotation, `getEdgeType` |
| `Deck.js` | Chargement (`data/{Groupe}/{id}.json`), mélange, pioche, remélange tuile dragon |
| `GameState.js` | État partagé : joueurs, dragon, fée, `extraState`, `_pending*` transitoires, `remapPlayerId` |
| `LobbyOptions.js` | Cases du lobby, presets, coches maîtres, dépendances entre options, `localStorage` |
| `MeepleConfig.js` | Tailles des pions par contexte d'affichage (`getMeepleSize`) |
| `MeepleUtils.js` | Poids de majorité d'un meeple (Grand = 2, Bâtisseur/Cochon = 0) |

## `modules/core/` — infrastructure

| Fichier | Rôle |
|---|---|
| `EventBus.js` | Pub/sub interne. **Singleton jamais recréé** → DN §1.1 |
| `Multiplayer.js` | PeerJS : connexion, broadcast, `sendTo`, reconnexion, promotion en hôte |
| `GameSync.js` | Messages réseau de jeu (envoi + `switch` de réception), relais hôte (`relayTypes`), paquet d'état complet |
| `HeartbeatManager.js` | Ping/pong, détection de pair muet |
| `RuleRegistry.js` | Enregistre/active/désactive les règles d'extension |

## `modules/rules/` — règles par extension

| Fichier | Rôle |
|---|---|
| `BaseRules.js` | Règles de base (essentiellement placeholder, logique réelle dans Board/Scoring) |
| `AbbeRules.js` | Validation Abbé/jardin, scoring jardin |
| `InnsRules.js` | Grand meeple, coefficients cathédrale/auberge, pénalités zone ouverte |
| `BuilderRules.js` | Bâtisseur, Cochon, marchandises, tour bonus, `getPigZones` |
| `DragonRules.js` | Dragon (déplacement, manger), Fée, Princesse, Portail |
| `DragonConfig.js` | Types de meeples mangeables par le dragon / ciblables par la fée |
| `TowerRules.js` | Tour : étages, portée de capture, verrouillage, réciprocité de prisonniers |
| `TowerConfig.js` | Pièces par nombre de joueurs, meeples capturables, coût de rachat |

## `modules/game/` — logique de partie

| Fichier | Rôle |
|---|---|
| `GameStarter.js` | Démarrage hôte/invité : crée GameState, GameSync, TurnManager, règles |
| `GameModuleInitializer.js` | Instancie les modules de jeu (UI, placement, undo, règles Dragon/Tour…) |
| `GameEventSetup.js` | Listeners DOM du jeu : fin de tour, undo, menu, modales, mobile |
| `GameSyncCallbacks.js` | Callbacks réseau : réception côté invité + traitement des requêtes côté hôte (`_attachHostCallbacks`) |
| `TurnManager.js` | Joueur courant, pioche, fin de tour, tour bonus |
| `TilePlacement.js` | Pose de tuile (validation, affichage, fusion de zones, extensions déclenchées) |
| `MeeplePlacement.js` | Pose de meeple (validation d'occupation, compteurs) |
| `ZoneMerger.js` | Fusion incrémentale des zones, fermeture, recherche de zone par position |
| `ZoneRegistry.js` | Registre des zones fusionnées, historique des villes fermées |
| `Scoring.js` | Scores de zones fermées et scores finaux |
| `FinalScoresManager.js` | Calcul/affichage de la modale de scores finaux |
| `UndoManager.js` | Snapshots de tour, annulation, restauration (dont `extraState`) |
| `UnplaceableTileManager.js` | Tuiles implaçables : badge, remélange/destruction, cas rivière/dragon |
| `DragonUI.js` | Orchestration/affichage Dragon et Fée (pions, curseurs, phase dragon) |
| `TowerUI.js` | Orchestration Tour : étages, verrouillage, capture, échange et rachat de prisonniers |
| `ReconnectionManager.js` | Pause, exclusion, full-state-sync, handler réseau en jeu (joueurs qui reviennent) |
| `HostMigration.js` | Changement d'hôte (partie et lobby) : snapshot, élection, promotion, ancien hôte |
| `NavigationManager.js` | Zoom + déplacement du plateau (souris/tactile) |
| `ZoomManager.js` | Zoom molette/pinch (throttle RAF) |
| `GameTimer.js` | Chronomètre de partie |

## `modules/ui/` — affichage

| Fichier | Rôle |
|---|---|
| `TurnUI.js` | Boutons de tour, preview mobile, messages et toasts |
| `ScorePanelUI.js` | Panneaux joueurs (PC + mobile, carte Spectateurs groupée, barre mobile défilante), meeples/marchandises/prisonniers, sélection de prisonniers |
| `SlotsUI.js` | Slots de placement de tuile (dont slot central) |
| `TilePreviewUI.js` | Aperçu de la tuile en main et compteur |
| `MeepleCursorsUI.js` | Curseurs de placement de meeple, curseurs de rappel d'Abbé |
| `MeepleSelectorUI.js` | Sélecteur de type de meeple (dont portail) |
| `MeepleDisplayUI.js` | Affichage des meeples posés |
| `MeepleActionsUI.js` | Actions sur pions : rappel Abbé, fée, princesse, portail ; listeners réseau Tour/Portail/Princesse |
| `ModalUI.js` | Modales génériques (tuiles restantes, règles de la partie) |
| `GameMenuUI.js` | Visibilité des boutons du menu en jeu |
| `LobbyUI.js` | Liste des joueurs (6 emplacements + bloc Spectateurs), couleurs, code de partie, modale joueur/spectateur |
| `LobbyJoin.js` | Logique d'un invité qui rejoint (handler lobby) |
| `LobbyNavigator.js` | Retour au lobby / lobby initial |

## `data/` et assets

- `data/{Abbot,Base,Dragon,Inns_Cathedrals,River,Tower,Traders_Builders}/NN.json` : une tuile par fichier
  (`id`, `quantity`, `extension`, `image`, `zones[{id,type,edges,features,meeplePosition}]`).
  `meeplePosition` ∈ 1-25 (grille 5×5). `features` : `shield`, `inn`, `cathedral`, `cloth|wheat|wine`, `princess`,
  ou `{adjacentCities:[ids locaux]}` pour les champs. Id de tuile en jeu = `{extension en minuscules}-{id}`.
- `data/Presets/NN.json` : presets du lobby (clés mappées dans `LobbyOptions.PRESET_MAP`).
- `assets/` : images des tuiles (`assets/{Groupe}/C2/`) et des pions (`assets/Meeples/{Couleur}/`).

## Règles transversales (détails → `docs/DESIGN_NOTES.md`)

1. **`eventBus` est un singleton** : tout `eventBus.on(...)` dans une fonction rappelée à chaque partie doit avoir une garde anti-réinstallation. → DN §1.1
2. **Callbacks différés** (`requestAnimationFrame`, `setTimeout`…) : relire l'état courant à l'exécution, jamais une valeur capturée. → DN §1.2
3. **Réseau** : invité → *requête* → hôte applique et diffuse. Message qui doit atteindre les *autres* invités → l'ajouter à `relayTypes`. → DN §2
4. **État persistant d'extension non-meeple** → `gameState.extraState` ; état *du tour en cours* → `gameState._pending*` (non sérialisé, à réinitialiser explicitement). → DN §5
5. **Id de joueur stocké hors de `players`** → l'ajouter à `GameState.remapPlayerId` / `remapExtraStateIds`. → DN §4
6. **Tout changement de tuile en main / pioche en cours de tour** → rediffuser le snapshot (`gameSync.onTurnEndSynced?.()`). → DN §3
7. **Clé de pion spéciale `"tower-lock:x,y"`** (garde de tour, absent de `placedMeeples`) à gérer partout où une clé de pion est lue. → DN §7
8. **Nouvelle extension** : suivre la check-list. → DN §8

## Symptôme → fichiers

| Symptôme | Où regarder |
|---|---|
| Option/preset du lobby | `LobbyOptions.js`, `index.html`, `data/Presets/` |
| Deck : chargement, mélange, composition | `Deck.js` |
| Tuile implaçable (badge, remélange, destruction, dragon sans volcan) | `UnplaceableTileManager.js`, `home.js` (listener `tile-drawn`), `GameSyncCallbacks.js` |
| Pose de tuile / slots | `SlotsUI.js`, `Board.js`, `TilePlacement.js`, `Tile.js` |
| Zones fusionnées, fermeture de ville/route/abbaye | `ZoneMerger.js`, `ZoneRegistry.js` |
| Pose de meeple (curseurs, sélecteur, refus à tort) | `MeepleCursorsUI.js`, `MeepleSelectorUI.js`, `MeeplePlacement.js`, `MeepleActionsUI.js`, `rules/*` |
| Score incorrect | `Scoring.js`, `FinalScoresManager.js`, `rules/InnsRules.js`, `rules/BuilderRules.js`, `MeepleUtils.js` |
| Fin de tour, tour bonus, pioche suivante | `GameEventSetup.js` (`_installEndTurn`), `GameSyncCallbacks.js` (`onTurnEndRequest`), `TurnManager.js` |
| Annulation (undo) | `UndoManager.js`, `GameEventSetup.js` (`_installUndo`), `GameSyncCallbacks.js` (`onUndoRequest`) |
| Désynchro hôte/invité, message non reçu par un invité | `GameSync.js` (`relayTypes`, `switch`), `GameSyncCallbacks.js`, `Multiplayer.js` |
| Événement appliqué en double après retour lobby + nouvelle partie | DN §1.1 |
| Déconnexion, reconnexion, pause, joueur exclu | `ReconnectionManager.js`, `HeartbeatManager.js` |
| Hôte perdu, nouvel hôte, ancien hôte qui revient | `HostMigration.js`, `Multiplayer.js`, `ReconnectionManager.js`, DN §3 |
| Prisonniers/gardes/fée mal attribués après un retour de joueur | `GameState.js` (`remapPlayerId`), `home.js` (`_remapPlayerEverywhere`), DN §4 |
| Aperçu de tuile périmé après resynchronisation | `ReconnectionManager.js` (`applyFullStateSync`), DN §1.2 |
| Dragon / Fée / Princesse / Portail | `DragonUI.js`, `rules/DragonRules.js`, `rules/DragonConfig.js`, `MeepleActionsUI.js` |
| Tour (étages, capture, verrouillage, pièces) | `TowerUI.js`, `rules/TowerRules.js`, `rules/TowerConfig.js`, `GameState.js`, DN §6 |
| Échange / rachat de prisonniers | `TowerUI.js`, `ScorePanelUI.js`, `style.css`, DN §6 |
| Interaction Dragon/Fée ↔ garde de tour | DN §7 |
| Bâtisseur / Cochon / Marchandises | `rules/BuilderRules.js`, `MeepleUtils.js` |
| Abbé / jardin | `rules/AbbeRules.js`, `MeepleActionsUI.js` (`handleAbbeRecall`) |
| Auberges / Cathédrales / Grand meeple | `rules/InnsRules.js` |
| Spectateurs : 7ᵉ joueur, partie complète, liste du lobby, carte Spectateurs | `home.js` (handler lobby hôte), `ReconnectionManager.js` (`game-in-progress`, CAS 1/2), `LobbyJoin.js`, `LobbyUI.js`, `ScorePanelUI.js`, DN §2 et §10 |
| Barre joueurs mobile (défilement, panel de détail mal placé) | `ScorePanelUI.js`, `style.css`, DN §10 |
| Affichage PC/mobile, panneaux de score, modales, toasts | `TurnUI.js`, `ScorePanelUI.js`, `ModalUI.js`, `style.css`, `index.html` |
| Zoom / déplacement du plateau | `NavigationManager.js`, `ZoomManager.js` |
| Démarrage d'une nouvelle extension | DN §8 (puis DN §9 pour les pièges déjà identifiés) |

## Maintenance de ce fichier

- Une **ligne par module**. Ni nombre de lignes, ni constantes qui changent (renvoyer au fichier), ni historique de bug.
- Un bug corrigé n'est **pas** documenté ici : le « pourquoi » vit dans le commentaire `// ✅ FIX` du code et dans git.
  On n'ajoute que des **règles durables** (dans `docs/DESIGN_NOTES.md`), formulées comme une règle, pas comme une anecdote.
- Mettre à jour ce fichier seulement si : nouveau/supprimé fichier, rôle d'un module qui change, nouvelle catégorie de symptôme.
