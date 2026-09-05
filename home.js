import { Multiplayer }            from './modules/core/Multiplayer.js';
import { APP_VERSION } from './version.js';
import { Tile }                   from './modules/Tile.js';
import { Board }                  from './modules/Board.js';
import { Deck }                   from './modules/Deck.js';
import { GameState }              from './modules/GameState.js';
import { GameSync }               from './modules/core/GameSync.js';
import { ZoneMerger }             from './modules/game/ZoneMerger.js';
import { Scoring }                from './modules/game/Scoring.js';

import { EventBus }               from './modules/core/EventBus.js';
import { RuleRegistry }           from './modules/core/RuleRegistry.js';
import { BaseRules }              from './modules/rules/BaseRules.js';
import { AbbeRules }              from './modules/rules/AbbeRules.js';
import { InnsRules }              from './modules/rules/InnsRules.js';
import { BuilderRules }          from './modules/rules/BuilderRules.js';
import { ZoomManager }           from './modules/game/ZoomManager.js';
import { NavigationManager }      from './modules/game/NavigationManager.js';
import { ReconnectionManager }    from './modules/game/ReconnectionManager.js';
import { startGameTimer, startGameTimerFrom, stopGameTimer, getElapsedSeconds } from './modules/game/GameTimer.js';
import {
    initDragonUI,
    tileHasDragonZone, tileHasVolcanoZone, tileHasPortalZone,
    broadcastDragonState,
    updateDragonOverlay, clearDragonCursors, showDragonMoveCursors, showDragonVisitedTiles,
    startDragonTurnUI, onDragonMoveConfirm, executeDragonMoveHost,
    onDragonPhaseEnded, advanceDragonTurnHost,
    renderDragonPiece, renderFairyPiece, removeFairyPiece, releaseFairyIfDetached,
} from './modules/game/DragonUI.js';
import { initTowerUI, clearTowerCursors } from './modules/game/TowerUI.js'; // ✨ NOUVEAU
import { TowerRules } from './modules/rules/TowerRules.js'; // ✨ NOUVEAU (import direct non utilisé ici mais gardé pour clarté — l'instanciation réelle se fait dans GameModuleInitializer)
import {
    initTurnUI,
    updateTurnDisplay, updateMobileButtons, updateMobileTilePreview,
    afficherMessage, afficherToast, hideToast,
} from './modules/ui/TurnUI.js';
import {
    initMeepleActionsUI, initNetworkMeepleListeners,
    handleAbbeRecall, countAbbePoints,
    clearFairyCursors, hideAllCursors, showFairyTargets,
    handleFairyPlacement, showMeepleActionCursors,
    handlePortalActivate, placeMeepleViaPortal,
    handlePrincessEject,
    afficherSelecteurMeeple, placerMeeple,
} from './modules/ui/MeepleActionsUI.js';
import {
    initLobbyOptions,
    applyPreset,
    saveLobbyOptions,
    syncAllOptions,
    updateOptionsAccess,
    updateColorPickerVisibility,
    updateLobbyUI as _updateLobbyUI,
    loadPresets,
    updateAllAvailability,
    updateMasterCheckboxes,
} from './modules/LobbyOptions.js';
import { TurnManager }            from './modules/game/TurnManager.js';
import { UndoManager }            from './modules/game/UndoManager.js';
import { TilePlacement }          from './modules/game/TilePlacement.js';
import { MeeplePlacement }        from './modules/game/MeeplePlacement.js';
import { GameSyncCallbacks }      from './modules/game/GameSyncCallbacks.js';
import { GameStarter }            from './modules/game/GameStarter.js';
import { initGameMenu }           from './modules/ui/GameMenuUI.js';
import { LobbyNavigator }         from './modules/ui/LobbyNavigator.js';
import { LobbyJoin }              from './modules/ui/LobbyJoin.js';
import { GameModuleInitializer }  from './modules/game/GameModuleInitializer.js';
import { GameEventSetup }         from './modules/game/GameEventSetup.js';
import { UnplaceableTileManager } from './modules/game/UnplaceableTileManager.js';
import { HeartbeatManager }       from './modules/core/HeartbeatManager.js';
import { FinalScoresManager }     from './modules/game/FinalScoresManager.js';

import { ScorePanelUI }    from './modules/ui/ScorePanelUI.js';
import { SlotsUI }         from './modules/ui/SlotsUI.js';
import { TilePreviewUI }   from './modules/ui/TilePreviewUI.js';
import { MeepleCursorsUI } from './modules/ui/MeepleCursorsUI.js';
import { MeepleSelectorUI }from './modules/ui/MeepleSelectorUI.js';
import { MeepleDisplayUI } from './modules/ui/MeepleDisplayUI.js';
import { LobbyUI }         from './modules/ui/LobbyUI.js';
import { DragonRules }      from './modules/rules/DragonRules.js';
import { getMeepleSize }    from './modules/MeepleConfig.js';
import { ModalUI }         from './modules/ui/ModalUI.js';

// ═══════════════════════════════════════════════════════
// DÉTECTION MOBILE
// ═══════════════════════════════════════════════════════
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

// ═══════════════════════════════════════════════════════
// VARIABLES LOBBY
// ═══════════════════════════════════════════════════════
const multiplayer = new Multiplayer();
multiplayer.appVersion = APP_VERSION;
multiplayer.appOrigin  = window.location.hostname + window.location.pathname.replace(/\/+$/, '');
// Callbacks heartbeat assignés dès le départ — heartbeatManager peut être null avant le démarrage
multiplayer.onHeartbeatPing = () => heartbeatManager?.receivePing();
multiplayer.onHeartbeatPong = (peerId) => heartbeatManager?.receivePong(peerId);

/**
 * Démarrer (ou redémarrer) le heartbeat avec le bon handler selon le contexte
 * @param {Function} onTimeout - callback(peerId) en cas de timeout
 */
function _startHeartbeat(onTimeout) {
    if (!multiplayer?.peer) return;
    if (heartbeatManager) { heartbeatManager.stop(); heartbeatManager = null; }
    heartbeatManager = new HeartbeatManager({ multiplayer, onPeerTimeout: onTimeout });
    heartbeatManager.start();
}
const lobbyUI     = new LobbyUI(multiplayer);
const modalUI     = new ModalUI();
let gameCode      = null;
let playerName    = '';
let playerColor   = 'blue';
let players       = [];
let takenColors   = [];
let inLobby       = false;
let isHost        = false;
let eventListenersInstalled = false;

let gameConfig = {
    playFields:         true,
    showRemainingTiles: true,
    extensions: { base: true, abbot: false, largeMeeple: false, cathedrals: true, inns: true },
    tileGroups: { base: true, abbot: false, inns_cathedrals: false, dragon: false }
};

// ═══════════════════════════════════════════════════════
// VARIABLES JEU
// ═══════════════════════════════════════════════════════
const plateau = new Board();
const deck    = new Deck();
let gameState = null;

// ═══════════════════════════════════════════════════════
// EVENTBUS & RULE REGISTRY
// ═══════════════════════════════════════════════════════
const eventBus     = new EventBus();
const ruleRegistry = new RuleRegistry(eventBus);
eventBus.setDebug(true);

let turnManager    = null;
let undoManager    = null;
let meeplePlacement = null;
let tilePlacement  = null;
let gameSync       = null;
let zoneMerger     = null;
let scoring        = null;

let scorePanelUI    = null;
let slotsUI         = null;
let tilePreviewUI   = null;
let meepleCursorsUI = null;
let meepleSelectorUI = null;
let meepleDisplayUI = null;

let unplaceableManager = null;
let dragonRules = null;   // Extension Princesse & Dragon
let towerRules  = null;   // ✨ NOUVEAU — Extension Tour
let finalScoresManager = null;

// ── Reconnexion / Pause ──────────────────────────────────────────────────────
const PAUSE_TIMEOUT_MS = 60_000;  // 1 min (tests) → 3 min (prod)
let reconnectionManager = null;
let gameSyncCallbacks   = null;   // instance GameSyncCallbacks, expose hostDrawAndSend()
const _voluntaryLeaves = new Set(); // peerIds ayant quitté volontairement (leave-game)

function _isSpectator() {
    if (!gameState || !multiplayer) return false;
    const me = gameState.players.find(p => p.id === multiplayer.playerId);
    return me?.color === 'spectator';
}

let originalLobbyHandler = null;

// ═══════════════════════════════════════════════════════
// ÉTAT DU JEU
// ═══════════════════════════════════════════════════════
let tuileEnMain    = null;
let currentTileForPlayer = null; // Tuile piochée pour le joueur courant (hôte ou invité)
let tuilePosee     = false;
let waitingToRedraw   = false;
let pendingAbbePoints = null; // { playerId, points } — points abbé à attribuer en fin de tour
let firstTilePlaced = false;
let isMyTurn       = false;
let lastPlacedTile = null;
let placedMeeples  = {};

let zoomLevel  = 1;
let navigationManager = null; // instance NavigationManager (zoom + drag)
let heartbeatManager = null;

const allColors   = ['black', 'red', 'pink', 'green', 'blue', 'yellow'];
const colorImages = {
    black:  './assets/Meeples/Black/Normal.png',
    red:    './assets/Meeples/Red/Normal.png',
    pink:   './assets/Meeples/Pink/Normal.png',
    green:  './assets/Meeples/Green/Normal.png',
    blue:   './assets/Meeples/Blue/Normal.png',
    yellow: './assets/Meeples/Yellow/Normal.png'
};

// ═══════════════════════════════════════════════════════
// EVENTBUS — abonnements globaux
// ═══════════════════════════════════════════════════════
eventBus.on('tile-drawn', (data) => {
    if (!data.tileData) return;

    tuileEnMain          = new Tile(data.tileData);
    tuileEnMain.rotation = data.tileData.rotation || 0;
    tuilePosee           = false;
    updateTurnDisplay(); // corriger l'état du bouton dès la réception de la tuile

    // ── Extension Dragon : tuile dragon piochée sans volcan sur le plateau ──
    // Cette tuile ne peut légalement pas être posée (règle spéciale hors du
    // check géométrique de Board.canPlaceTile), et une modale d'alerte va
    // s'afficher pour forcer sa repioche. Tant que cette situation n'est pas
    // résolue (le joueur a effectivement repioché une nouvelle tuile valide),
    // on bloque les slots de placement en lecture seule — sinon les pointillés
    // dorés restent affichés et cliquables, permettant de poser la tuile
    // dragon prématurément (bug). Ce check s'exécute pour l'hôte ET l'invité,
    // car 'tile-drawn' est émis des deux côtés à la réception de la tuile.
    // Le flag se remet automatiquement à false au prochain tile-drawn si la
    // nouvelle tuile ne pose plus problème (repioche effectuée).
    if (slotsUI) {
        const _isDragonPrematureTile = !!(
            gameConfig?.tileGroups?.dragon && gameConfig?.extensions?.dragon &&
            tileHasDragonZone(tuileEnMain) &&
            !Object.values(plateau.placedTiles ?? {}).some(t => tileHasVolcanoZone(t))
        );
        slotsUI.setBlocked(_isDragonPrematureTile);
    }

    // Mettre à jour isRiverPhase : true si la tuile courante est une tuile river
    if (slotsUI) slotsUI.isRiverPhase = tuileEnMain.id.startsWith('river-');

    // Ne pas afficher la tuile dans le preview si :
    // - bug 1 : invité attend sa tuile de remplacement (waitingToRedraw) et ce tile-drawn n'est pas la sienne
    // - bug 2 : tile-drawn réseau d'un autre joueur alors que la tuile est déjà posée (déco passive)
    const _guestWaiting = waitingToRedraw && !isHost && !data.fromYourTurn;
    const _hostWaiting  = waitingToRedraw && isHost && !data.fromYourTurn;
    const _skipPreview = _guestWaiting || _hostWaiting;
    if (tilePreviewUI && !_skipPreview) tilePreviewUI.showTile(tuileEnMain);
    if (!_skipPreview) updateMobileTilePreview();

    // Invité : quand sa tuile de remplacement arrive (fromYourTurn), remettre waitingToRedraw à false
    if (waitingToRedraw && !isHost && data.fromYourTurn) {
        waitingToRedraw = false;
        updateTurnDisplay();
    }

    // Snapshot + reset builder : au début de notre propre tour (local ou via your-turn réseau)
    const isOwnTurnStart = !data.fromUndo && (!data.fromNetwork || data.fromYourTurn);
    // Nouveau tour — effacer les pending du tour précédent
    if (isOwnTurnStart && gameState) {
        gameState._pendingPrincessTile = null;
        gameState._pendingPortalTile = null;
    }
    // Invité : reset des flags de placement du tour précédent
    // (l'hôte le fait via undoManager.reset(), le guest doit le faire ici)
    if (isOwnTurnStart && !isHost && undoManager) {
        undoManager.meeplePlacedThisTurn = false;
        undoManager.tilePlacedThisTurn   = false;
        undoManager.abbeRecalledThisTurn = false;
        undoManager.lastMeeplePlaced     = null;
    }
    // L'hôte sauvegarde le snapshot début de tour pour tout le monde (undo centralisé)
    // isOwnTurnStart = notre propre tour ; fromNetwork sans fromYourTurn = tour d'un invité reçu par l'hôte
    const isNewTurnSnapshot = isHost && !data.fromUndo &&
        (isOwnTurnStart || (data.fromNetwork && !data.fromYourTurn));
    if (undoManager && isNewTurnSnapshot) {
        undoManager.setLastPlacedTileBeforeTurn(lastPlacedTile);
        undoManager.saveTurnStart(placedMeeples);
    }
    if (isOwnTurnStart && gameConfig?.extensions?.tradersBuilders) {
        ruleRegistry.rules?.get('builders')?.resetLastPlacedTile?.();
    }

    // Fix 1 — Fée : +1 point au début du tour du propriétaire de la fée
    // Seul l'hôte applique et synchronise — l'invité reçoit via score-update
    // Pas appliqué lors d'un tour bonus (bâtisseur)
    const _isBonusTurnStart = turnManager?.isBonusTurn ?? false;
    if (isHost && isOwnTurnStart && !_isBonusTurnStart && gameConfig?.extensions?.fairyScoreTurn
        && gameState?.fairyState?.ownerId) {
        // Vérifier que c'est bien le tour du propriétaire de la fée
        const currentPlayer = gameState.getCurrentPlayer();
        if (currentPlayer?.id === gameState.fairyState.ownerId) {
            const fairyPlayer = gameState.players.find(p => p.id === gameState.fairyState.ownerId);
            if (fairyPlayer) {
                fairyPlayer.score += 1;
                fairyPlayer.scoreDetail = fairyPlayer.scoreDetail || {};
                fairyPlayer.scoreDetail.fairy = (fairyPlayer.scoreDetail.fairy || 0) + 1;
                console.log(`🧚 [Fée] +1 point début de tour pour ${fairyPlayer.name} (score: ${fairyPlayer.score})`);
                if (gameSync) gameSync.syncScoreUpdate(
                    [{ playerId: fairyPlayer.id, points: 1, zoneType: 'fairy-turn' }],
                    [], [], zoneMerger
                );
                eventBus.emit('score-updated');
            }
        }
    }


    if (isOwnTurnStart && isMyTurn && tilePlacement && unplaceableManager) {
        const isRiverPhase = tuileEnMain?.id?.startsWith('river-') ?? false;
        const placeable = unplaceableManager.isTilePlaceable(tuileEnMain, tilePlacement.plateau, isRiverPhase);
        if (!placeable) {
            const actionText = gameConfig?.unplaceableAction === 'reshuffle'
                ? 'remise dans la pioche'
                : 'détruite';
            unplaceableManager.showUnplaceableBadge(tuileEnMain, actionText);
        }
    }
});

eventBus.on('deck-updated', (data) => {
    const counter = document.getElementById('mobile-tile-counter');
    if (counter) counter.textContent = `${data.remaining} / ${data.total}`;
});

eventBus.on('turn-changed', (data) => {
    isMyTurn = data.isMyTurn && !_isSpectator();
    console.log('🔄 Sync isMyTurn global:', isMyTurn, '— isBonusTurn:', data.isBonusTurn ?? false);
    // Synchroniser isBonusTurn sur turnManager si transmis par receiveTurnEnded
    if (turnManager && data.isBonusTurn !== undefined) {
        turnManager.isBonusTurn = data.isBonusTurn;
    }
    updateTurnDisplay();
});

eventBus.on('turn-ended', (data) => {
    console.log('⏭️ Turn ended - recalcul isMyTurn pour tous');
    if (gameState && multiplayer) {
        const currentPlayer = gameState.getCurrentPlayer();
        const newIsMyTurn   = currentPlayer && currentPlayer.id === multiplayer.playerId;
        eventBus.emit('turn-changed', { isMyTurn: newIsMyTurn, currentPlayer });
    }
});

// ✅ Étape 3 : echo du placement meeple invité
eventBus.on('meeple-placed-own', (data) => {
    hideAllCursors();
    updateMobileButtons();
    updateTurnDisplay();
});

// ✅ Étape 2 : echo du placement invité — déclencher curseurs meeple
eventBus.on('tile-placed-own', (data) => {
    const { x, y, tile } = data;
    tuilePosee = true;
    lastPlacedTile = { x, y };
    gameState.currentTilePlaced = true;
    currentTileForPlayer = null;
    if (unplaceableManager) unplaceableManager.resetSeenImplacable();
    updateMobileButtons();
    updateTurnDisplay();
    const _isVolcanoTileOwn = !!(gameConfig?.tileGroups?.dragon && gameConfig?.extensions?.dragon && tileHasVolcanoZone(tile));

    // Détection princesse — ici le zoneRegistry est déjà désérialisé
    if (gameConfig?.tileGroups?.dragon && gameConfig?.extensions?.princess && dragonRules) {
        const _hasPrincess = tile.zones?.some(z => z.type === 'city' && z.features?.includes?.('princess'));
        if (_hasPrincess) {
            const targets = dragonRules.getPrincessTargets(x, y, tile, multiplayer.playerId, zoneMerger);
            console.log(`👸 [tile-placed-own] targets:`, targets);
            if (targets.length > 0) {
                gameState._pendingPrincessTile = { x, y, targets };
            }
        }
    }

    // Détection portail — ici le zoneRegistry est déjà désérialisé
    if (gameConfig?.tileGroups?.dragon && gameConfig?.extensions?.portal && dragonRules && tileHasPortalZone(tile)) {
        const portalZoneIdx = tile.zones?.findIndex(z => z.type === 'portal');
        if (portalZoneIdx !== -1) {
            const rawPos = tile.zones[portalZoneIdx].meeplePosition;
            if (rawPos != null) {
                const rotatedPos = zoneMerger ? zoneMerger._rotatePosition(rawPos, tile.rotation) : Number(rawPos);
                gameState._pendingPortalTile = { x, y, zoneIndex: portalZoneIdx, position: rotatedPos };
            }
        }
    }

    if (meepleCursorsUI && !undoManager?.abbeRecalledThisTurn) {
        if (!_isVolcanoTileOwn) {
            meepleCursorsUI.showCursors(x, y, gameState, placedMeeples, afficherSelecteurMeeple);
        }
        showMeepleActionCursors();
    }
});

eventBus.on('tile-rotated', (data) => {
    // ✅ Mettre à jour tuileEnMain.rotation pour que SlotsUI recalcule
    // avec la bonne rotation (important côté joueur inactif qui reçoit la rotation via réseau)
    if (tuileEnMain) {
        tuileEnMain.rotation = data.rotation;
    }
    updateMobileTilePreview();
});

eventBus.on('meeple-placed', (data) => {
    if (meepleDisplayUI) {
        meepleDisplayUI.showMeeple(data.x, data.y, data.position, data.meepleType, data.playerColor);
    }
    if (!data.skipSync && gameSync) {
        gameSync.syncMeeplePlacement(data.x, data.y, data.position, data.meepleType, data.playerColor);
    }
});

// Nettoyer pendingAbbePoints côté invité quand le tour change
// (les scores sont déjà dans gameStateData reçu via deserialize)
eventBus.on('turn-changed', () => {
    hideToast();
    if (!isMyTurn && pendingAbbePoints) {
        console.log('🧹 pendingAbbePoints nettoyé côté invité au changement de tour');
        pendingAbbePoints = null;
    }
});

eventBus.on('meeple-count-updated', (data) => {
    // ✅ Seul l'hôte broadcast son propre compte — l'invité le reçoit via meeple-count-update de l'hôte
    if (gameSync && isHost && data.playerId === multiplayer.playerId) {
        // Toujours lire depuis gameState pour éviter de broadcaster null
        const player = gameState?.players.find(p => p.id === data.playerId);
        gameSync.multiplayer.broadcast({
            type: 'meeple-count-update',
            playerId:       data.playerId,
            meeples:        player ? player.meeples        : data.meeples,
            hasAbbot:       player ? player.hasAbbot       : undefined,
            hasLargeMeeple: player ? player.hasLargeMeeple : undefined,
            hasBuilder:     player ? player.hasBuilder     : undefined,
            hasPig:         player ? player.hasPig         : undefined
        });
    }
    // Panel mobile mis à jour via ScorePanelUI
    if (scorePanelUI) scorePanelUI.updateMobile();
});

// ── Extension Dragon : affichage pion dragon ─────────────────────────
eventBus.on('dragon-moved', (data) => {
    renderDragonPiece(data.x, data.y);
});

eventBus.on('dragon-phase-ended', () => {
    renderDragonPiece(gameState?.dragonPos?.x, gameState?.dragonPos?.y);
});

// ── Extension Fée : affichage pion fée ───────────────────────────────
eventBus.on('fairy-placed', (data) => {
    renderFairyPiece(data.meepleKey);
});

eventBus.on('fairy-removed', () => {
    removeFairyPiece();
});

// ═══════════════════════════════════════════════════════
// LOBBY — helpers
// ═══════════════════════════════════════════════════════
document.getElementById('pseudo-input').addEventListener('input', (e) => {
    playerName = e.target.value.trim();
});

// Lobby options — géré par modules/LobbyOptions.js
// updateColorPickerVisibility, updateOptionsAccess, updateLobbyUI,
// applyPreset, saveLobbyOptions, syncAllOptions, loadPresets
// sont importées en haut du fichier.

function updateLobbyUI() {
    _updateLobbyUI(
        document.getElementById('create-game-btn'),
        document.getElementById('join-game-btn')
    );
}


// ✅ Bouton retour Android — interception pendant la partie
let _handlingPopstate = false;
window.addEventListener('popstate', (e) => {
    if (!gameState) return;
    if (_handlingPopstate) { _handlingPopstate = false; return; }
    _handlingPopstate = true;
    history.go(1);
    setTimeout(() => {
        const quitter = confirm('Voulez-vous vraiment quitter la partie ?');
        if (quitter) {
            location.reload();
        }
    }, 50);
});

// Sélection de couleur
const colorOptions = document.querySelectorAll('.color-option');
colorOptions.forEach(option => {
    option.addEventListener('click', () => {
        if (option.classList.contains('disabled')) return;
        colorOptions.forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');
        const input = option.querySelector('input');
        input.checked = true;
        playerColor = input.value;

        if (multiplayer.peer?.open) {
            const me = players.find(p => p.id === multiplayer.playerId);
            if (me) { me.color = playerColor; lobbyUI.updatePlayersList(); }
            multiplayer.broadcast({ type: 'color-change', playerId: multiplayer.playerId, color: playerColor });
        }
    });
});

// ═══════════════════════════════════════════════════════
// LOBBY — créer une partie
// ═══════════════════════════════════════════════════════
document.getElementById('create-game-btn').addEventListener('click', async () => {
    if (!playerName) { alert('Veuillez entrer un pseudo !'); return; }

    try {
        gameCode = await multiplayer.createGame();
        inLobby  = true;
        isHost   = true;
        updateLobbyUI();

        document.getElementById('game-code-container').style.display = 'block';
        document.getElementById('game-code-text').textContent = `Code: ${gameCode}`;

        players.push({ id: multiplayer.playerId, name: playerName, color: playerColor, isHost: true });
        lobbyUI.setIsHost(true);
        lobbyUI.setPlayers(players);

        // Sync temps réel de toutes les options vers les invités
        ['base-fields', 'list-remaining', 'use-test-deck', 'enable-debug', 'ext-abbot', 'tiles-abbot', 'ext-large-meeple', 'ext-cathedrals', 'ext-inns', 'tiles-inns-cathedrals', 'tiles-traders-builders', 'ext-builder', 'ext-merchants', 'ext-pig', 'tiles-dragon', 'ext-dragon', 'ext-princess', 'ext-portal', 'ext-fairy-protection', 'ext-fairy-score-turn', 'ext-fairy-score-zone', 'tiles-tower', 'ext-tower'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', (e) => {
                multiplayer.broadcast({ type: 'option-change', option: id, value: e.target.checked });
            });
        });
        // Sync des radios (unplaceable + start)
        document.querySelectorAll('input[name="unplaceable"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (e.target.checked) multiplayer.broadcast({ type: 'option-change', option: 'unplaceable', value: e.target.value });
            });
        });
        document.querySelectorAll('input[name="start"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (e.target.checked) multiplayer.broadcast({ type: 'option-change', option: 'start', value: e.target.value });
            });
        });

        const _lobbyHeartbeatTimeout = (peerId) => {
            players = players.filter(p => p.id !== peerId);
            lobbyUI.setPlayers(players);
            multiplayer.broadcast({ type: 'players-update', players });
            console.warn(`💔 Joueur ${peerId} retiré du lobby (timeout heartbeat)`);
        };

        multiplayer.onPlayerJoined = (playerId) => {
            console.log('👤 Nouveau joueur connecté:', playerId);
            if (heartbeatManager) {
                // Heartbeat déjà actif : juste enregistrer le nouveau peer
                heartbeatManager._lastPong[playerId] = Date.now();
            } else {
                // Premier joueur : démarrer le heartbeat
                _startHeartbeat(_lobbyHeartbeatTimeout);
            }
        };

        // ✅ Retrait immédiat si un invité déconnecte dans le lobby
        multiplayer.onPlayerLeft = (peerId) => {
            console.log('👋 [LOBBY] Joueur déconnecté:', peerId);
            players = players.filter(p => p.id !== peerId);
            lobbyUI.setPlayers(players);
            multiplayer.broadcast({ type: 'players-update', players });
        };

        multiplayer._lobbyHostHandler = null; // sera set après définition
        const _hostLobbyHandler = (data, from) => {
            console.log('📨 [HÔTE] Reçu:', data);

            if (data.type === 'player-info') {
                // Vérifier compatibilité version + origine
                const _compat = _checkCompatibility(data.version, data.origin);
                if (!_compat.ok) {
                    multiplayer.sendTo(from, { type: 'rejoin-rejected', reason: _compat.reason });
                    return;
                }
                if (!players.find(p => p.id === from)) {
                    const taken    = players.map(p => p.color);
                    const assigned = taken.includes(data.color)
                        ? (allColors.find(c => !taken.includes(c)) || 'blue')
                        : data.color;
                    players.push({ id: from, name: data.name, color: assigned, isHost: false });
                    lobbyUI.setPlayers(players);
                }
                multiplayer.broadcast({ type: 'players-update', players });

                // ✅ Envoyer l'état courant des options directement au nouvel invité
                // (les broadcasts précédents ne l'avaient pas encore, il les a manqués)
                const currentOptions = {
                    'base-fields':           document.getElementById('base-fields')?.checked           ?? true,
                    'list-remaining':        document.getElementById('list-remaining')?.checked        ?? true,
                    'use-test-deck':         document.getElementById('use-test-deck')?.checked         ?? false,
                    'enable-debug':          document.getElementById('enable-debug')?.checked          ?? false,
                    'unplaceable':           document.querySelector('input[name="unplaceable"]:checked')?.value ?? 'reshuffle',
                    'ext-abbot':             document.getElementById('ext-abbot')?.checked             ?? false,
                    'tiles-abbot':           document.getElementById('tiles-abbot')?.checked           ?? false,
                    'ext-large-meeple':      document.getElementById('ext-large-meeple')?.checked      ?? false,
                    'ext-cathedrals':        document.getElementById('ext-cathedrals')?.checked        ?? false,
                    'ext-inns':              document.getElementById('ext-inns')?.checked              ?? false,
                    'tiles-inns-cathedrals': document.getElementById('tiles-inns-cathedrals')?.checked ?? false,
                    'tiles-traders-builders':document.getElementById('tiles-traders-builders')?.checked ?? false,
                    'ext-builder':           document.getElementById('ext-builder')?.checked           ?? false,
                    'ext-merchants':         document.getElementById('ext-merchants')?.checked         ?? false,
                    'ext-pig':               document.getElementById('ext-pig')?.checked               ?? false,
                    'tiles-dragon':          document.getElementById('tiles-dragon')?.checked          ?? false,
                    'ext-dragon':            document.getElementById('ext-dragon')?.checked            ?? false,
                    'ext-princess':          document.getElementById('ext-princess')?.checked          ?? false,
                    'ext-portal':            document.getElementById('ext-portal')?.checked            ?? false,
                    'ext-fairy-protection':  document.getElementById('ext-fairy-protection')?.checked  ?? false,
                    'ext-fairy-score-turn':  document.getElementById('ext-fairy-score-turn')?.checked  ?? false,
                    'ext-fairy-score-zone':  document.getElementById('ext-fairy-score-zone')?.checked  ?? false,
                    'tiles-tower':           document.getElementById('tiles-tower')?.checked           ?? false, // ✨ NOUVEAU
                    'ext-tower':             document.getElementById('ext-tower')?.checked             ?? false, // ✨ NOUVEAU
                    'start':                 document.querySelector('input[name="start"]:checked')?.value ?? 'unique',
                };
                multiplayer.sendTo(from, { type: 'options-sync', options: currentOptions });
            }

            if (data.type === 'color-change') {
                const player     = players.find(p => p.id === data.playerId);
                const colorTaken = players.some(p => p.id !== data.playerId && p.color === data.color);
                if (player && !colorTaken) {
                    player.color = data.color;
                    lobbyUI.updatePlayersList();
                    multiplayer.broadcast({ type: 'players-update', players });
                }
            }

            if (data.type === 'player-order-update') {
                players = data.players;
                lobbyUI.setPlayers(players);
            }

            if (data.type === 'player-left') {
                // Un invité quitte volontairement
                players = players.filter(p => p.id !== from);
                lobbyUI.setPlayers(players);
                multiplayer.broadcast({ type: 'players-update', players });
            }
        };
        multiplayer.onDataReceived = _hostLobbyHandler;
        multiplayer._lobbyHostHandler = _hostLobbyHandler;

        // Hôte : kick un invité
        lobbyUI.onKickPlayer = (playerId) => {
            multiplayer.sendTo(playerId, { type: 'you-are-kicked' });
            players = players.filter(p => p.id !== playerId);
            lobbyUI.setPlayers(players);
            multiplayer.broadcast({ type: 'players-update', players });
        };

        // Hôte : quitter le lobby (kick général + retour menu)
        lobbyUI.onHostLeave = () => {
            const invites = players.filter(p => !p.isHost);
            if (invites.length > 0) multiplayer.broadcast({ type: 'you-are-kicked' });
            returnToInitialLobby();
        };

    } catch (error) {
        console.error('❌ Erreur:', error);
        alert('Erreur lors de la création de la partie: ' + error.message);
        inLobby = false; isHost = false;
        updateLobbyUI();
    }
});

document.getElementById('copy-code-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(gameCode).then(() => {
        const btn = document.getElementById('copy-code-btn');
        btn.textContent = '✅ Copié !';
        setTimeout(() => { btn.textContent = '📋 Copier'; }, 2000);
    });
});

// ═══════════════════════════════════════════════════════
// LOBBY — rejoindre une partie
// ═══════════════════════════════════════════════════════
document.getElementById('join-game-btn').addEventListener('click', () => {
    if (!playerName) { alert('Veuillez entrer un pseudo !'); return; }
    document.getElementById('join-modal').style.display = 'flex';
    document.getElementById('join-code-input').value    = '';
    document.getElementById('join-error').style.display = 'none';
    document.getElementById('join-code-input').focus();
});

function _checkCompatibility(hostVersion, hostOrigin) {
    // Version absente = ancienne version sans système de compatibilité → bloquer
    if (!hostVersion || !hostOrigin) {
        return { ok: false, reason: `Votre jeu ou celui de l'hôte est trop ancien. Mettez à jour votre jeu.` };
    }
    const myOrigin = window.location.hostname + window.location.pathname.replace(/\/+$/, '');
    const originOk = hostOrigin === myOrigin;
    const versionOk = hostVersion === APP_VERSION;
    if (!originOk) return { ok: false, reason: `Source incompatible. Utilisez la même version officielle du jeu.` };
    if (!versionOk) return { ok: false, reason: `Version incompatible : hôte v${hostVersion}, vous v${APP_VERSION}. Mettez à jour votre jeu.` };
    return { ok: true };
}

function _makeJoiner() {
    return new LobbyJoin({
        getMultiplayer:          () => multiplayer,
        getLobbyUI:              () => lobbyUI,
        getPlayers:              () => players,
        setPlayers:              (v) => { players = v; },
        getPlayerName:           () => playerName,
        getPlayerColor:          () => playerColor,
        setPlayerColor:          (v) => { playerColor = v; },
        getTurnManager:          () => turnManager,
        getReconnectionManager:  () => reconnectionManager,
        setGameCode:             (v) => { gameCode = v; },
        setGameConfig:           (v) => { gameConfig = v; },
        setInLobby:              (v) => { inLobby = v; },
        setIsHost:               (v) => { isHost = v; },
        setOriginalLobbyHandler: (v) => { originalLobbyHandler = v; },
        startHeartbeat:          (cb) => _startHeartbeat(cb),
        showJoinError,
        showRoleChoiceModal:     _showRoleChoiceModal,
        checkCompatibility:      _checkCompatibility,
        getAppVersion:           () => APP_VERSION,
        getAppOrigin:            () => window.location.hostname + window.location.pathname.replace(/\/+$/, ''),
        returnToLobby,
        returnToInitialLobby,
        startGameForInvite,
        updateLobbyUI,
        updateAllAvailability,
        updateOptionsAccess,
        updateMasterCheckboxes,
    });
}

async function _doJoin(isSpectator = false) {
    await _makeJoiner().join(isSpectator);
}


// ── Menu bouton (global) ────────────────────────────────────────────────────
function _openCloseMenu(btnEl) { lobbyUI.openCloseMenu(btnEl); }

document.getElementById('menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openCloseMenu(e.currentTarget);
});
// mobile-menu-btn branché via mobileBtn(touchend) dans setupEventListeners


// Clic "Rejoindre" → connexion directe (le choix joueur/spectateur se fait
// après connexion via modale si la partie est déjà en cours)
document.getElementById('join-confirm-btn').addEventListener('click', () => _doJoin(false));

document.getElementById('join-cancel-btn').addEventListener('click', () => {
    document.getElementById('join-modal').style.display = 'none';
});

function _showRoleChoiceModal(cb) { lobbyUI.showRoleChoiceModal(cb); }

function showJoinError(msg) { lobbyUI.showJoinError(msg); }

// ═══════════════════════════════════════════════════════
// LOBBY — démarrer la partie
// ═══════════════════════════════════════════════════════
document.getElementById('start-game-btn').addEventListener('click', async () => {
    if (!inLobby) return;

    gameConfig = {
        playFields:         document.getElementById('base-fields').checked,
        showRemainingTiles: document.getElementById('list-remaining').checked,
        testDeck:           document.getElementById('use-test-deck').checked,
        enableDebug:        document.getElementById('enable-debug').checked,
        unplaceableAction:  document.querySelector('input[name="unplaceable"]:checked')?.value || 'destroy',
        startType: document.querySelector('input[name="start"]:checked')?.value || 'unique',
        extensions: {
            base:  true,
            abbot:           document.getElementById('ext-abbot')?.checked          ?? false,
            largeMeeple:     document.getElementById('ext-large-meeple')?.checked    ?? false,
            cathedrals:      document.getElementById('ext-cathedrals')?.checked      ?? true,
            inns:            document.getElementById('ext-inns')?.checked            ?? true,
            tradersBuilders: document.getElementById('ext-builder')?.checked         ?? false,
            merchants:       document.getElementById('ext-merchants')?.checked       ?? false,
            pig:             document.getElementById('ext-pig')?.checked             ?? false,
            dragon:          document.getElementById('ext-dragon')?.checked              ?? false,
            princess:        document.getElementById('ext-princess')?.checked            ?? false,
            portal:          document.getElementById('ext-portal')?.checked              ?? false,
            fairyProtection: document.getElementById('ext-fairy-protection')?.checked     ?? false,
            fairyScoreTurn:  document.getElementById('ext-fairy-score-turn')?.checked     ?? false,
            fairyScoreZone:  document.getElementById('ext-fairy-score-zone')?.checked     ?? false,
            tower:           document.getElementById('ext-tower')?.checked               ?? false // ✨ NOUVEAU
        },
        tileGroups: {
            base:  true,
            abbot:            document.getElementById('tiles-abbot')?.checked             ?? false,
            inns_cathedrals:  document.getElementById('tiles-inns-cathedrals')?.checked   ?? false,
            traders_builders: document.getElementById('tiles-traders-builders')?.checked  ?? false,
            dragon:           document.getElementById('tiles-dragon')?.checked            ?? false,
            tower:            document.getElementById('tiles-tower')?.checked             ?? false, // ✨ NOUVEAU
            river: document.querySelector('input[name="start"]:checked')?.value === 'river'
        }
    };

    console.log('🔧 gameConfig construit:', JSON.stringify(gameConfig.extensions), '— tileGroups:', JSON.stringify(gameConfig.tileGroups));

    if (isHost) {
        multiplayer.broadcast({ type: 'game-starting', message: "L'hôte démarre la partie !", config: gameConfig });
    }

    await startGame();
});

// ═══════════════════════════════════════════════════════
// INITIALISATION COMMUNE DES MODULES
// ═══════════════════════════════════════════════════════
// INITIALISATION COMMUNE DES MODULES
// ═══════════════════════════════════════════════════════
function initializeGameModules() {
    new GameModuleInitializer({
        getEventBus:          () => eventBus,
        getGameState:         () => gameState,
        getGameConfig:        () => gameConfig,
        getPlateau:           () => plateau,
        getGameSync:          () => gameSync,
        getDeck:              () => deck,
        getMultiplayer:       () => multiplayer,
        getPlacedMeeples:     () => placedMeeples,
        getRuleRegistry:      () => ruleRegistry,
        getIsHost:            () => isHost,
        getIsMyTurn:          () => isMyTurn,
        getFirstTilePlaced:   () => firstTilePlaced,
        getTuileEnMain:       () => tuileEnMain,
        getTilePlacement:     () => tilePlacement,
        getZoneMerger:        () => zoneMerger,
        getUndoManager:       () => undoManager,
        getMeepleCursorsUI:   () => meepleCursorsUI,
        getTilePreviewUI:     () => tilePreviewUI,
        getUnplaceableManager:() => unplaceableManager,
        getDragonRules:       () => dragonRules,
        getTowerRules:        () => towerRules, // ✨ NOUVEAU
        getSlotsUI:           () => slotsUI,
        getLastPlacedTile:    () => lastPlacedTile,
        getScoring:           () => scoring,
        getFinalScoresManager:() => finalScoresManager,
        setScorePanelUI:      (v) => { scorePanelUI     = v; },
        setSlotsUI:           (v) => { slotsUI          = v; },
        setTilePreviewUI:     (v) => { tilePreviewUI    = v; },
        setZoneMerger:        (v) => { zoneMerger       = v; },
        setScoring:           (v) => { scoring          = v; },
        setTilePlacement:     (v) => { tilePlacement    = v; },
        setMeeplePlacement:   (v) => { meeplePlacement  = v; },
        setMeepleCursorsUI:   (v) => { meepleCursorsUI  = v; },
        setMeepleSelectorUI:  (v) => { meepleSelectorUI = v; },
        setMeepleDisplayUI:   (v) => { meepleDisplayUI  = v; },
        setUndoManager:       (v) => { undoManager      = v; },
        setDragonRules:       (v) => { dragonRules      = v; },
        setTowerRules:        (v) => { towerRules       = v; }, // ✨ NOUVEAU
        setUnplaceableManager:(v) => { unplaceableManager = v; },
        setFinalScoresManager:(v) => { finalScoresManager = v; },
        setTuileEnMain:       (v) => { tuileEnMain = v; },
        setTuilePosee:        (v) => { tuilePosee = v; },
        setFirstTilePlaced:   (v) => { firstTilePlaced = v; if (slotsUI) slotsUI.firstTilePlaced = v; if (tilePlacement) tilePlacement.firstTilePlaced = v; },
        setLastPlacedTile:    (v) => { lastPlacedTile = v; },
        setCurrentTileForPlayer: (v) => { currentTileForPlayer = v; },
        setWaitingToRedraw:   (v) => { waitingToRedraw = v; },
        setPendingAbbePoints: (v) => { pendingAbbePoints = v; },
        tileHasVolcanoZone,
        tileHasDragonZone,
        tileHasPortalZone,
        afficherSelecteurMeeple,
        showMeepleActionCursors,
        updateTurnDisplay,
        updateMobileButtons,
        updateMobileTilePreview,
        renderDragonPiece,
        renderFairyPiece,
        removeFairyPiece,
        updateDragonOverlay,
        showDragonMoveCursors,
        showDragonVisitedTiles,
        hideAllCursors,
    }).init();
}

// ═══════════════════════════════════════════════════════
function attachGameSyncCallbacks() {
    gameSyncCallbacks = new GameSyncCallbacks({
        gameSync, gameState, deck, turnManager, tilePreviewUI, meepleDisplayUI,
        undoManager, unplaceableManager, scoring, zoneMerger, slotsUI, eventBus,
        plateau, gameConfig, ruleRegistry, scorePanelUI, tilePlacement, dragonRules,
        finalScoresManager,
        getPlacedMeeples:  () => placedMeeples,
        getWaitingToRedraw: () => waitingToRedraw,
        setWaitingToRedraw: (v) => { waitingToRedraw = v; updateTurnDisplay(); },
        onRemoteUndo:     (action) => undoManager.applyRemote(action),
        onFinalScores:    (scores, destroyedTilesCount = 0) => finalScoresManager.receiveFromNetwork(scores, destroyedTilesCount),
        onTileDestroyed:  (tileId, pName, action, count = 1, playerId = null) => {
            if (action === 'destroy' && gameState) gameState.destroyedTilesCount = (gameState.destroyedTilesCount || 0) + count;
            const currentPlayer = gameState?.getCurrentPlayer();
            const isMyTileDestroyed = !isHost && action === 'dragon-reshuffle'
                && (playerId === multiplayer.playerId || currentPlayer?.id === multiplayer.playerId);
            if (isMyTileDestroyed) {
                waitingToRedraw = true;
                if (tilePreviewUI) tilePreviewUI.showBackside();
                updateMobileTilePreview();
                updateTurnDisplay();
            }
            unplaceableManager.showTileDestroyedModal(tileId, pName, isMyTileDestroyed, action);
        },
        onDeckReshuffled: (tiles, idx) => { deck.tiles = tiles; deck.currentIndex = idx; },
        onAbbeRecalled: (x, y, key, playerId, points) => {
            document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
            delete placedMeeples[key];
            releaseFairyIfDetached(key);
            const player = gameState.players.find(p => p.id === playerId);
            if (player) player.hasAbbot = true;
            if (isHost && undoManager) undoManager.markAbbeRecalled(x, y, key, playerId, points);
            eventBus.emit('meeple-count-updated', { playerId });
            eventBus.emit('score-updated');
            updateTurnDisplay();
        },
        onAbbeRecalledUndo: (x, y, key, playerId) => {
            pendingAbbePoints = null;
            const player = gameState.players.find(p => p.id === playerId);
            if (player) player.hasAbbot = false;
            eventBus.emit('score-updated');
            updateTurnDisplay();
        },
        onBonusTurnStarted: (playerId) => {
            if (turnManager) turnManager.isBonusTurn = true;
            updateTurnDisplay();
            const player = gameState.players.find(p => p.id === playerId);
            if (player) {
                afficherToast(`⭐ Tour bonus pour ${player.name} !`, 'bonus');
                const _bonusToast = document.getElementById('disconnect-toast');
                if (_bonusToast) _bonusToast.dataset.isBonusToast = 'true';
            }
        },
        onUnplaceableHandled: (tileId, pName, action, isRiver, isActivePlayer) => {
            if (action === 'destroy' && gameState) gameState.destroyedTilesCount = (gameState.destroyedTilesCount || 0) + 1;
            unplaceableManager.showTileDestroyedModal(tileId, pName, isActivePlayer, action, isRiver);
            if (isActivePlayer) { waitingToRedraw = true; updateTurnDisplay(); }
        },
        onGamePaused:  (name)   => { reconnectionManager?._showPauseOverlay(name); },
        onGameResumed: (reason) => {
            reconnectionManager?._hidePauseOverlay();
            if (reason === 'timeout') afficherToast('⏱ Partie reprise (joueur exclu).');
            else afficherToast('✅ Partie reprise !');
        },
        onFullStateSync: (data) => { reconnectionManager.applyFullStateSync(data); },
        updateTurnDisplay,
        poserTuileSync:            (x, y, tile, opts) => tilePlacement.handlePlaceSync(x, y, tile, opts),
        afficherMessage:            (msg) => { afficherToast(msg); },
        onUpdateMobileTilePreview: updateMobileTilePreview,
        updateMobileButtons,
        releaseFairyIfDetached,
        broadcastDragonState,
        startDragonTurnUI,
        executeDragonMoveHost,
        advanceDragonTurnHost,
        handlePrincessEject,
        tileHasDragonZone,
        tileHasVolcanoZone,
        setTuileEnMain:          (v) => { tuileEnMain = v; },
        setCurrentTileForPlayer: (v) => { currentTileForPlayer = v; },
        isHost,
    });
    gameSyncCallbacks.attach(isHost);
}

function _hostDrawAndSend() { return gameSyncCallbacks?.hostDrawAndSend() ?? null; }

// Invités : écouter dragon-state-update et dragon-phase-started
eventBus.on('network-dragon-state-update', (data) => {
    if (isHost) return;
    const wasActive = gameState.dragonPhase.active;
    const prevPos = gameState.dragonPos ? `${gameState.dragonPos.x},${gameState.dragonPos.y}` : null;

    gameState.dragonPos   = data.dragonPos;
    gameState.dragonPhase = { ...gameState.dragonPhase, ...data.dragonPhase };
    gameState.fairyState  = data.fairyState;
    if (data.players) {
        data.players.forEach(pd => {
            const p = gameState.players.find(pl => pl.id === pd.id);
            if (p) Object.assign(p, pd);
        });
    }
    // Retirer visuellement les meeples mangés
    if (data.eatenKeys?.length) {
        data.eatenKeys.forEach(key => {
            document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
            delete placedMeeples[key];
            releaseFairyIfDetached(key);
        });
        eventBus.emit('meeple-count-updated', {});
    }
    // Rendu pion dragon
    if (gameState.dragonPos) {
        renderDragonPiece(gameState.dragonPos.x, gameState.dragonPos.y);
    }

    // Détecter si le dragon vient de se déplacer (position changée)
    const newPos = gameState.dragonPos ? `${gameState.dragonPos.x},${gameState.dragonPos.y}` : null;
    const dragonMoved = newPos && newPos !== prevPos;

    if (!gameState.dragonPhase.active) {
        // Phase terminée
        if (wasActive) {
            clearDragonCursors();
            updateDragonOverlay(); // cache l'overlay bandeau rouge
            if (undoManager) { undoManager.dragonMovePlacedThisTurn = false; undoManager.dragonMoveSnapshot = null; }
            updateTurnDisplay();
        }
    } else {
        const mover = gameState.players[gameState.dragonPhase.moverIndex];
        const isMyDragonTurn = mover?.id === multiplayer.playerId;

        if (dragonMoved && isMyDragonTurn) {
            // L'hôte vient de confirmer notre déplacement → marquer "a déplacé" et attendre clic
            if (undoManager) undoManager.dragonMovePlacedThisTurn = true;
            clearDragonCursors();
            showDragonVisitedTiles(gameState.dragonPhase.visitedTiles, gameState.dragonPos);
            updateDragonOverlay();
            updateTurnDisplay();
        } else if (dragonMoved && !isMyDragonTurn) {
            // Un autre joueur a déplacé → on attend que ce joueur clique Terminer
            clearDragonCursors();
            showDragonVisitedTiles(gameState.dragonPhase.visitedTiles, gameState.dragonPos);
            updateDragonOverlay();
            updateTurnDisplay();
        } else if (!dragonMoved) {
            // moverIndex a changé (avancement de tour dragon) → afficher curseurs si c'est notre tour
            if (undoManager) { undoManager.dragonMovePlacedThisTurn = false; undoManager.dragonMoveSnapshot = null; }
            startDragonTurnUI();
        }
    }
    eventBus.emit('score-updated');
});

eventBus.on('network-fairy-placed', (data) => {
    if (!dragonRules || !gameState) return;
    // Mettre à jour l'état fairy dans gameState (hôte ET invité)
    gameState.fairyState.ownerId   = data.ownerId;
    gameState.fairyState.meepleKey = data.meepleKey;
    gameState.players.forEach(p => { p.hasFairy = false; });
    const owner = gameState.players.find(p => p.id === data.ownerId);
    if (owner) owner.hasFairy = true;
    // Afficher la fée
    renderFairyPiece(data.meepleKey);
    // Côté hôte : marquer la fée comme posée ce tour pour que l'undo invité fonctionne
    if (isHost && undoManager) undoManager.markFairyPlaced();
});

// Après une fermeture de zone, si la fée s'est retrouvée seule,
// réafficher les curseurs pour que le joueur puisse la réassigner.
eventBus.on('fairy-detached-show-targets', () => {
    if (!isMyTurn || !gameConfig.extensions?.fairyProtection) return;
    if (undoManager?.meeplePlacedThisTurn) return;
    clearFairyCursors();
    showMeepleActionCursors();
});

// ═══════════════════════════════════════════════════════
// DÉMARRAGE — HÔTE
// ═══════════════════════════════════════════════════════
// ── Pause / Reconnexion ─────────────────────────────────────────────────────────

/**
 * Déclencher la pause (hôte uniquement)
 * Affiche l'overlay, démarre le timer, broadcaster aux invités
 */
/**
 * Construit la liste players enrichie pour le broadcast players-update :
 * inclut les fantômes kicked de gameState afin que les invités puissent
 * afficher l'icône 🚪 et ne pas les effacer de leur gameState.
 */
function buildPlayersForBroadcast() {
    if (!gameState) return players;
    const enriched = [...players];
    gameState.players.forEach(gp => {
        if (gp.kicked && gp.color !== 'spectator') {
            // Ajouter seulement s'il n'est pas déjà dans la liste
            if (!enriched.find(p => p.id === gp.id)) {
                enriched.push({ id: gp.id, name: gp.name, color: gp.color, isHost: false, kicked: true });
            }
        }
    });
    return enriched;
}

function pauseGame(disconnectedName)              { reconnectionManager?.pauseGame(disconnectedName); }
function resumeGame(reason = 'reconnected')       { reconnectionManager?.resumeGame(reason); }
function _excludeDisconnectedPlayer(name)         { reconnectionManager?.excludeDisconnectedPlayer(name); }
function _startAutoReconnect()                    { reconnectionManager?.startAutoReconnect(); }
function _stopAutoReconnect()                     { reconnectionManager?.stopAutoReconnect(); }
function _showPauseOverlay(name)                  { reconnectionManager?._showPauseOverlay(name); }
function _hidePauseOverlay()                      { reconnectionManager?._hidePauseOverlay(); }
function _showReconnectOverlay()                  { reconnectionManager?._showReconnectOverlay(); }
function _hideReconnectOverlay()                  { reconnectionManager?.hideReconnectOverlay(); }
/**
 * Indique si une tuile contient une zone dragon (déclencheur de phase dragon).
 */


function _makeStarter() {
    return new GameStarter({
        getGameConfig:           () => gameConfig,
        getPlayers:              () => players,
        getMultiplayer:          () => multiplayer,
        getEventBus:             () => eventBus,
        getDeck:                 () => deck,
        getTurnManager:          () => turnManager,
        getMeepleSelectorUI:     () => meepleSelectorUI,
        getMeepleCursorsUI:      () => meepleCursorsUI,
        getScorePanelUI:         () => scorePanelUI,
        getSlotsUI:              () => slotsUI,
        getLobbyUI:              () => lobbyUI,
        getReconnectionManager:  () => reconnectionManager,
        getOriginalLobbyHandler: () => originalLobbyHandler,
        getZoneMerger:           () => zoneMerger,
        getPlacedMeeples:        () => placedMeeples,
        getScoring:              () => scoring,
        getRuleRegistry:         () => ruleRegistry,
        getGameState:            () => gameState,
        getIsHost:               () => isHost,
        getIsSpectator:          () => _isSpectator(),
        getGameCode:             () => gameCode,
        getBaseRules:            () => BaseRules,
        getAbbeRules:            () => AbbeRules,
        getInnsRules:            () => InnsRules,
        getBuilderRulesClass:    () => BuilderRules,
        setGameState:            (v) => { gameState = v; },
        setGameSync:             (v) => { gameSync  = v; },
        setTurnManager:          (v) => { turnManager = v; },
        setReconnectionManager:  (v) => { reconnectionManager = v; },
        startGameTimer,
        hostDrawAndSend:         _hostDrawAndSend,
        initializeGameModules,
        attachGameSyncCallbacks,
        setupEventListeners,
        setupNavigation:         () => setupNavigation(document.getElementById('board-container'), document.getElementById('board')),
        updateTurnDisplay,
        afficherMessage:         (msg) => afficherToast(msg),
        // deps pour initTurnUI
        getTurnUIDeps: () => ({
            getGameState:          () => gameState,
            getGameConfig:         () => gameConfig,
            getMultiplayer:        () => multiplayer,
            getTurnManager:        () => turnManager,
            getUndoManager:        () => undoManager,
            getFinalScoresManager: () => finalScoresManager,
            getScorePanelUI:       () => scorePanelUI,
            getDeck:               () => deck,
            getIsHost:             () => isHost,
            getIsMyTurn:           () => isMyTurn,
            setIsMyTurn:           (v) => { isMyTurn = v; },
            getIsSpectator:        () => _isSpectator(),
            getWaitingToRedraw:    () => waitingToRedraw,
            getTuilePosee:         () => tuilePosee,
            getTuileEnMain:        () => tuileEnMain,
            getTilePreviewUI:      () => tilePreviewUI,
            getEventBus:           () => eventBus,
            isMobile,
        }),
        // deps pour initDragonUI
        getDragonUIDeps: () => ({
            getGameState:         () => gameState,
            getGameConfig:        () => gameConfig,
            getMultiplayer:       () => multiplayer,
            getGameSync:          () => gameSync,
            getDragonRules:       () => dragonRules,
            getUndoManager:       () => undoManager,
            getZoneMerger:        () => zoneMerger,
            getPlacedMeeples:     () => placedMeeples,
            getMeepleSelectorUI:  () => meepleSelectorUI,
            getDeck:              () => deck,
            getTurnManager:       () => turnManager,
            getFinalScoresManager:() => finalScoresManager,
            getIsHost:            () => isHost,
            getMeepleSize,
            onUpdateTurnDisplay:  () => updateTurnDisplay(),
            onHostDrawAndSend:    () => _hostDrawAndSend(),
            hideToast,
            getRuleRegistry:      () => ruleRegistry,
            afficherToast,
        }),
        // ✨ NOUVEAU — deps pour initTowerUI
        getTowerUIDeps: () => ({
            getGameState:        () => gameState,
            getGameConfig:       () => gameConfig,
            getMultiplayer:      () => multiplayer,
            getGameSync:         () => gameSync,
            getTowerRules:       () => towerRules,
            getZoneMerger:       () => zoneMerger,
            getPlacedMeeples:    () => placedMeeples,
            getPlateau:          () => plateau,
            getUndoManager:      () => undoManager,
            getIsHost:           () => isHost,
            getIsMyTurn:         () => isMyTurn,
            onUpdateTurnDisplay: () => updateTurnDisplay(),
        }),
        // deps pour initMeepleActionsUI
        getMeepleActionsUIDeps: () => ({
            getGameState:           () => gameState,
            getMultiplayer:         () => multiplayer,
            getPlacedMeeples:       () => placedMeeples,
            getPlateau:             () => plateau,
            getGameConfig:          () => gameConfig,
            getEventBus:            () => eventBus,
            getUndoManager:         () => undoManager,
            getGameSync:            () => gameSync,
            getDragonRules:         () => dragonRules,
            getMeepleCursorsUI:     () => meepleCursorsUI,
            getMeepleSelectorUI:    () => meepleSelectorUI,
            getMeepleDisplayUI:     () => meepleDisplayUI,
            getScorePanelUI:        () => scorePanelUI,
            getMeeplePlacement:     () => meeplePlacement,
            getZoneMerger:          () => zoneMerger,
            getLastPlacedTile:      () => lastPlacedTile,
            getIsHost:              () => isHost,
            getIsMyTurn:            () => isMyTurn,
            releaseFairyIfDetached,
            renderFairyPiece,
            hideAllCursors:         () => hideAllCursors(),
            setPendingAbbePoints:   (v) => { pendingAbbePoints = v; },
            onHandlePortalActivate: () => handlePortalActivate(),
            onHandlePrincessEject:  (key) => handlePrincessEject(key),
            updateTurnDisplay,
            updateMobileButtons,
        }),
        // deps pour ReconnectionManager
        getReconnectionManagerDeps: () => ({
            multiplayer,
            gameSync,
            turnManager,
            eventBus,
            getGameState:            () => gameState,
            getPlayers:              () => players,
            setPlayers:              (p) => { players = p; },
            getIsHost:               () => isHost,
            getGameCode:             () => gameCode,
            getPlayerName:           () => playerName,
            hostDrawAndSend:         _hostDrawAndSend,
            buildPlayersForBroadcast,
            afficherToast,
            onGameSyncInit:          () => { if (gameSync) gameSync.init(); },
            onReturnToInitialLobby:  () => returnToInitialLobby(),
        }),
        // deps pour reconnectionManager.initStateHandlers
        getStateHandlerDeps: () => ({
            getTileClass:            () => Tile,
            getGameConfig:           () => gameConfig,
            getDeck:                 () => deck,
            getPlateau:              () => plateau,
            getZoneMerger:           () => zoneMerger,
            getPlacedMeeples:        () => placedMeeples,
            getSlotsUI:              () => slotsUI,
            getTilePlacement:        () => tilePlacement,
            getMeepleDisplayUI:      () => meepleDisplayUI,
            getTilePreviewUI:        () => tilePreviewUI,
            getTurnManager:          () => turnManager,
            getEventBus:             () => eventBus,
            getPlayerName:           () => playerName,
            getPlayerColor:          () => playerColor,
            getTuileEnMain:          () => tuileEnMain,
            getCurrentTileForPlayer: () => currentTileForPlayer,
            getElapsedSeconds,
            setTuileEnMain:          (v) => { tuileEnMain = v; },
            setTuilePosee:           (v) => { tuilePosee = v; },
            setFirstTilePlaced:      (v) => { firstTilePlaced = v; },
            setPlayerColor:          (v) => { playerColor = v; },
            renderDragonPiece,
            renderFairyPiece,
            startGameTimerFrom,
            updateTurnDisplay,
        }),
        // deps pour reconnectionManager.initInGameNetworkHandler
        getInGameNetworkDeps: () => ({
            getGameState:           () => gameState,
            getGameSync:            () => gameSync,
            getGameConfig:          () => gameConfig,
            getEventBus:            () => eventBus,
            getPlayers:             () => players,
            setPlayers:             (v) => { players = v; },
            getPlacedMeeples:       () => placedMeeples,
            getScorePanelUI:        () => scorePanelUI,
            getTurnManager:         () => turnManager,
            getTuileEnMain:         () => tuileEnMain,
            getHeartbeatManager:    () => heartbeatManager,
            getVoluntaryLeaves:     () => _voluntaryLeaves,
            getPlayerName:          () => playerName,
            getPlayerColorVar:      () => playerColor,
            buildPlayersForBroadcast,
            afficherToast,
            updateTurnDisplay,
            pauseGame,
            resumeGame,
            startHeartbeat:             (cb) => _startHeartbeat(cb),
            startAutoReconnect:          () => _startAutoReconnect(),
            excludeDisconnectedPlayer:   (name) => _excludeDisconnectedPlayer(name),
        }),
    });
}

// ═══════════════════════════════════════════════════════
// DÉMARRAGE — HÔTE
// ═══════════════════════════════════════════════════════
async function startGame() {
    await _makeStarter().startHost();
}

// ═══════════════════════════════════════════════════════
// DÉMARRAGE — INVITÉ
// ═══════════════════════════════════════════════════════
async function startGameForInvite(fullStateData = null) {
    await _makeStarter().startGuest(fullStateData);
}

// ═══════════════════════════════════════════════════════
// MOBILE — Mise à jour de l'UI
// ═══════════════════════════════════════════════════════

/**
 * Met à jour le style de la carte mobile du joueur actif selon le tour bonus
 */



// ═══════════════════════════════════════════════════════
// ABBÉ — Rappel anticipé
// ═══════════════════════════════════════════════════════

/**
 * Rappeler l'Abbé depuis le plateau
 * Appelé quand le joueur clique sur l'Abbé rappelable en phase 2
 */
// ═══════════════════════════════════════════════════════
// MEEPLES
// ═══════════════════════════════════════════════════════
// ── Dragon prématuré : modales 1 et 2 ────────────────────────────────

// Invités : modale dragon prématuré
// ═══════════════════════════════════════════════════════
// EVENT LISTENERS DU JEU
// ═══════════════════════════════════════════════════════
let _gameEventSetup = null;

function setupEventListeners() {
    if (!_gameEventSetup) _gameEventSetup = new GameEventSetup();
    _gameEventSetup.install({
        getGameState:            () => gameState,
        getGameConfig:           () => gameConfig,
        getGameCode:             () => gameCode,
        getMultiplayer:          () => multiplayer,
        getEventBus:             () => eventBus,
        getDeck:                 () => deck,
        getPlayers:              () => players,
        getPlacedMeeples:        () => placedMeeples,
        getPlateau:              () => plateau,
        getZoneMerger:           () => zoneMerger,
        getScoring:              () => scoring,
        getRuleRegistry:         () => ruleRegistry,
        getGameSync:             () => gameSync,
        getTurnManager:          () => turnManager,
        getUndoManager:          () => undoManager,
        getDragonRules:          () => dragonRules,
        getFinalScoresManager:   () => finalScoresManager,
        getScorePanelUI:         () => scorePanelUI,
        getTilePreviewUI:        () => tilePreviewUI,
        getUnplaceableManager:   () => unplaceableManager,
        getModalUI:              () => modalUI,
        getNavigationManager:    () => navigationManager,
        getTilePlacement:        () => tilePlacement,
        getIsHost:               () => isHost,
        getIsMyTurn:             () => isMyTurn,
        getTuileEnMain:          () => tuileEnMain,
        getTuilePosee:           () => tuilePosee,
        getWaitingToRedraw:      () => waitingToRedraw,
        getPendingAbbePoints:    () => pendingAbbePoints,
        getLastPlacedTile:       () => lastPlacedTile,
        setTuileEnMain:          (v) => { tuileEnMain = v; },
        setTuileEnMainRotation:  (v) => { if (tuileEnMain) tuileEnMain.rotation = v; },
        setWaitingToRedraw:      (v) => { waitingToRedraw = v; },
        setPendingAbbePoints:    (v) => { pendingAbbePoints = v; },
        isMobile,
        hostDrawAndSend:         _hostDrawAndSend,
        hideAllCursors,
        clearDragonCursors,
        clearTowerCursors, // ✨ NOUVEAU
        broadcastDragonState,
        startDragonTurnUI,
        advanceDragonTurnHost,
        releaseFairyIfDetached,
        incrementPlayerMeeples:  (id) => gameSyncCallbacks?.incrementPlayerMeeples(id),
        openCloseMenu:           _openCloseMenu,
        stopAutoReconnect:       () => _stopAutoReconnect(),
        hideReconnectOverlay:    () => _hideReconnectOverlay(),
        returnToLobby,
        returnToInitialLobby,
        updateTurnDisplay,
        updateMobileButtons,
        updateMobileTilePreview,
        afficherToast,
    });
}


// ═══════════════════════════════════════════════════════
// RETOUR AU LOBBY
// ═══════════════════════════════════════════════════════
function _makeLobbyNavigator() {
    return new LobbyNavigator({
        getMultiplayer:           () => multiplayer,
        getIsHost:                () => isHost,
        getPlayers:               () => players,
        setPlayers:               (v) => { players = v; },
        getPlacedMeeples:         () => placedMeeples,
        getLobbyUI:               () => lobbyUI,
        getOriginalLobbyHandler:  () => originalLobbyHandler,
        getUnplaceableManager:    () => unplaceableManager,
        getHeartbeatManager:      () => heartbeatManager,
        getTurnManager:           () => turnManager,
        getPlayerColor:           () => playerColor,
        setInLobby:               (v) => { inLobby = v; },
        setIsHost:                (v) => { isHost = v; },
        setGameCode:              (v) => { gameCode = v; },
        clearDragonCursors,
        stopGameTimer,
        stopAutoReconnect:        () => _stopAutoReconnect(),
        startHeartbeat:           (cb) => _startHeartbeat(cb),
        stopHeartbeat:            () => { if (heartbeatManager) { heartbeatManager.stop(); heartbeatManager = null; } },
        resetZoom:                () => { zoomLevel = 1; },
        destroyNavigationManager: () => { if (navigationManager) { navigationManager.destroy(); navigationManager = null; } },
        destroyReconnectionManager: () => { if (reconnectionManager) { reconnectionManager.destroy(); reconnectionManager = null; } },
        destroyGameModules: () => {
            [tilePreviewUI, slotsUI, meepleCursorsUI, meepleSelectorUI, meepleDisplayUI, scorePanelUI, undoManager]
                .forEach(m => { if (m?.destroy) m.destroy(); });
            tilePreviewUI = null; slotsUI = null; meepleCursorsUI = null;
            meepleSelectorUI = null; meepleDisplayUI = null; scorePanelUI = null;
            undoManager = null; gameSync = null; zoneMerger = null; scoring = null;
            tilePlacement = null; meeplePlacement = null; turnManager = null;
            unplaceableManager = null; finalScoresManager = null;
            waitingToRedraw = false; pendingAbbePoints = null;
            towerRules = null; // ✨ NOUVEAU
            ruleRegistry.disable('base'); ruleRegistry.disable('abbot');
            ruleRegistry.disable('inns'); ruleRegistry.disable('builders');
        },
        resetGameState: () => {
            deck.tiles = []; deck.currentIndex = 0; deck.totalTiles = 0;
            plateau.reset();
            gameState = null; tuileEnMain = null; tuilePosee = false;
            firstTilePlaced = false; placedMeeples = {}; lastPlacedTile = null;
            isMyTurn = false;
        },
        updateLobbyUI,
    });
}

function returnToLobby()                   { _makeLobbyNavigator().returnToLobby(); }
function returnToInitialLobby(message = null) { _makeLobbyNavigator().returnToInitialLobby(message); }

function setupNavigation(container, board) {
    if (navigationManager) return; // déjà initialisé
    navigationManager = new NavigationManager(container, board, { isMobile });
    navigationManager.init();
    // Synchroniser la variable globale zoomLevel (utilisée ailleurs)
    Object.defineProperty(window, '_zoomLevelProxy', {
        get: () => navigationManager.zoomLevel,
        configurable: true,
    });
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
// Initialiser les options du lobby (listeners, presets, localStorage)
initLobbyOptions({
    getIsHost:  () => isHost,
    getInLobby: () => inLobby,
    multiplayer,
});
lobbyUI.init();
console.log('Page chargée');

// Afficher la version
const _versionEl = document.getElementById('app-version-display');
if (_versionEl) _versionEl.textContent = `v.${APP_VERSION}`;
