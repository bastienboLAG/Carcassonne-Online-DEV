# Architecture — Carcassonne Online REFIXED (multijoueur P2P)

> Document généré à partir d'un accès réel au dépôt GitHub
> (`bastienboLAG/Carcassonne-Online-REFIXED`, branche `main`).
> Nombre de lignes indiqué à titre de repère de taille/complexité.

## Vue d'ensemble

Jeu de plateau **Carcassonne** en HTML/CSS/JS vanilla (pas de framework),
multijoueur peer-to-peer. L'hôte fait autorité sur l'état du jeu (placement,
scoring, pioche) et synchronise les invités via `GameSync`.

Extensions optionnelles : Abbé, Grand Meeple, Auberges & Cathédrales,
Marchands & Bâtisseurs (+ Cochon), Dragon & Princesse & Portail & Fée, Rivière.

Point d'entrée : **`home.js`** (1463 lignes) — orchestre tous les modules,
gère le lobby, les event listeners globaux, et les callbacks passés aux managers.

---

## Racine

| Fichier | Lignes | Rôle |
|---|---|---|
| `index.html` | 494 | Structure DOM complète (lobby, plateau, modales, badge dragon, sélecteurs) |
| `style.css` | 1569 | Tous les styles |
| `home.js` | 1463 | Chef d'orchestre : état global, listeners `eventBus`, init lobby, `startGame`/`startGameForInvite` |
| `version.js` | — | Constante `APP_VERSION` |

---

## `modules/` (racine du dossier modules)

| Fichier | Lignes | Rôle |
|---|---|---|
| `Board.js` | 121 | Modèle du plateau : `placedTiles`, `isFree`, `canPlaceTile` (check géométrique, ne connaît pas les règles spéciales type "dragon sans volcan") |
| `Deck.js` | 217 | Chargement des tuiles (`loadAllTiles`, fetch parallèle par groupe depuis `data/{Groupe}/{id}.json`), mélange, pioche, `reshuffleDragonTile()` |
| `GameState.js` | 221 | État global : joueurs, `dragonPos`, `dragonPhase`, `fairyState`, `currentTilePlaced`, `destroyedTilesCount` |
| `LobbyOptions.js` | 548 | Cases à cocher du lobby (extensions, presets, coches maîtres), `localStorage`, sync réseau |
| `MeepleConfig.js` | 134 | Tailles/configuration des meeples (`getMeepleSize`) |
| `MeepleUtils.js` | 21 | Utilitaires génériques meeples — poids pour calcul de majorité (Grand Meeple = 2, Bâtisseur/Cochon = 0, Normal/Abbé = 1) |
| `Tile.js` | 100 | Modèle d'une tuile : zones, rotation, traduction des edges selon rotation |

## `modules/core/` — Infrastructure bas niveau

| Fichier | Lignes | Rôle |
|---|---|---|
| `EventBus.js` | 117 | Bus d'événements interne (`on`/`off`/`emit`) |
| `GameSync.js` | 688 | Sérialisation/synchronisation réseau hôte↔invités |
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

## `modules/game/` — Logique de partie côté client

| Fichier | Lignes | Rôle |
|---|---|---|
| `DragonUI.js` | 480 | Détection zones dragon/volcan/portail, affichage pion dragon/fée, curseurs de déplacement |
| `FinalScoresManager.js` | 292 | Calcul et affichage des scores de fin de partie |
| `GameEventSetup.js` | 499 | Installe tous les listeners DOM du jeu (boutons, modales implaçable, menu) |
| `GameModuleInitializer.js` | 175 | Instancie les modules UI de jeu |
| `GameStarter.js` | 200 | Démarrage de partie hôte/invité |
| `GameSyncCallbacks.js` | 454 | Callbacks réseau réactifs : tirage tuile hôte (`hostDrawAndSend`, check dragon-sans-volcan), tuile détruite/implaçable, rappel abbé, tour bonus |
| `GameTimer.js` | 59 | Chronomètre de partie |
| `MeeplePlacement.js` | 253 | Logique de pose de meeple |
| `NavigationManager.js` | 161 | Zoom et déplacement (pan) sur le plateau |
| `ReconnectionManager.js` | 674 | Pause/reprise de partie, resynchronisation complète |
| `Scoring.js` | 380 | Calcul des points (fermeture de zones, fin de partie) |
| `TilePlacement.js` | 283 | Logique de pose de tuile |
| `TurnManager.js` | 415 | Gestion du tour courant, tour bonus |
| `UndoManager.js` | 649 | Annulation d'actions du tour en cours |
| `UnplaceableTileManager.js` | 401 | Gestion des tuiles implaçables (badge, modale, `handleConfirm`, `showUnplaceableBadgeDragon`) |
| `ZoneMerger.js` | 720 | Fusionne les zones entre tuiles adjacentes, calcule les meeples présents dans une zone fusionnée — fichier le plus volumineux du projet, cœur des bugs de placement de meeple. Chaque zone (y compris `garden`/`abbey`) est enregistrée dans le registre dès la pose de tuile (`createZone`) — `findMergedZoneForPosition` retourne donc presque toujours une zone existante. |
| `ZoneRegistry.js` | 201 | Registre central des zones fusionnées (persistant, mis à jour incrémentalement, historique des villes fermées pour le scoring des champs) |
| `ZoomManager.js` | 204 | Gestion du niveau de zoom |

## `modules/ui/` — Composants d'affichage

| Fichier | Lignes | Rôle |
|---|---|---|
| `GameMenuUI.js` | 49 | Menu en jeu |
| `LobbyJoin.js` | 168 | Logique de connexion en tant qu'invité |
| `LobbyNavigator.js` | 176 | Retour au lobby / lobby initial |
| `LobbyUI.js` | 356 | Interface du lobby (liste joueurs, kick, menu) |
| `MeepleActionsUI.js` | 655 | Actions meeples : rappel abbé, portail, éjection princesse, placement fée |
| `MeepleCursorsUI.js` | 455 | Curseurs de placement de meeple sur une tuile posée (filtre par type de zone + ressources dispo + occupation de zone fusionnée) |
| `MeepleDisplayUI.js` | 91 | Affichage visuel des meeples posés |
| `MeepleSelectorUI.js` | 333 | Sélecteur de type de meeple (rappel abbé + fée, etc.) |
| `ModalUI.js` | 528 | Utilitaires génériques de modales |
| `ScorePanelUI.js` | 310 | Panneau des scores (desktop + mobile) |
| `SlotsUI.js` | 234 | Slots de placement de tuile (pointillés dorés). Écoute `tile-drawn`/`tile-placed`/`turn-changed`/`tile-rotated`. Flag `isBlocked` pour forcer le lecture-seule |
| `TilePreviewUI.js` | 65 | Aperçu de la tuile en main (recto/verso) |
| `TurnUI.js` | 293 | Affichage tour courant, boutons mobile, messages/toasts |

---

## Données (`data/`)

```
data/
├── Abbot/             01.json … 08.json   (8 tuiles)
├── Base/              01.json … 24.json   (24 tuiles)
├── Dragon/            01.json … 29.json   (29 tuiles)
├── Inns_Cathedrals/   01.json … 18.json   (18 tuiles)
├── River/             01.json … 12.json   (12 tuiles — source et embouchure fixes, milieu mélangé)
├── Traders_Builders/  01.json … 24.json   (24 tuiles)
└── Presets/           01.json, 02.json... (presets de configuration de partie, pas des tuiles)
```

Chargement effectué par `modules/Deck.js` → `loadAllTiles()`, via
`fetch('./data/{Groupe}/{id}.json')`, en parallèle par groupe. Chaque tuile a
un `id` unique reconstruit en `{extension}-{id}` (ex. `base-04`, `dragon-22`).

Cas particuliers notables dans `Deck.js` :
- `startType === 'river'` : tuile source (`river-01`) et embouchure (`river-12`) fixes, tuiles intermédiaires mélangées.
- `testMode` : deck réduit, parfois un ordre forcé (séquence rivière figée, ou deck custom `['base-04', 'dragon-22', ...]`).
- Tuile normale (`unique`) : `base-04` toujours forcée en première position après mélange.

---

## Aide au diagnostic — quel(s) fichier(s) regarder selon le symptôme

| Symptôme | Fichiers probables |
|---|---|
| Case à cocher du lobby ne se comporte pas comme prévu | `modules/LobbyOptions.js` |
| Meeple ne peut/peut être posé à tort quelque part | `modules/ui/MeepleCursorsUI.js`, `modules/game/ZoneMerger.js`, `modules/game/ZoneRegistry.js`, `modules/rules/*Rules.js`, `modules/MeepleUtils.js` |
| Tuile peut être posée alors qu'elle ne devrait pas (ou inversement) | `modules/ui/SlotsUI.js`, `modules/Board.js`, `modules/game/TilePlacement.js` |
| Bug lié au chargement/mélange/composition du deck | `modules/Deck.js` |
| Bug spécifique Dragon/Fée/Princesse/Portail | `modules/game/DragonUI.js`, `modules/rules/DragonRules.js`, `modules/rules/DragonConfig.js`, `modules/game/GameSyncCallbacks.js` |
| Désynchronisation réseau hôte/invité | `modules/core/GameSync.js`, `modules/game/GameSyncCallbacks.js`, `home.js` |
| Déconnexion/reconnexion/pause | `modules/game/ReconnectionManager.js`, `modules/core/HeartbeatManager.js` |
| Score incorrect | `modules/game/Scoring.js`, `modules/game/ZoneMerger.js`, `modules/game/ZoneRegistry.js`, `modules/MeepleUtils.js` |
| Annulation d'action (undo) qui se comporte mal | `modules/game/UndoManager.js` |
| Modale/texte d'interface à modifier | `index.html` (texte statique) ou le manager JS correspondant si dynamique |
