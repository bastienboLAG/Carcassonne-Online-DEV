import { GameState } from '../GameState.js';
import { GameSync  } from '../core/GameSync.js';
import { TurnManager } from './TurnManager.js';
import { ReconnectionManager } from './ReconnectionManager.js';
import { initTurnUI } from '../ui/TurnUI.js';
import { initDragonUI } from './DragonUI.js';
import { initTowerUI } from './TowerUI.js'; // ✨ NOUVEAU
import { getTowerPiecesForPlayerCount } from '../rules/TowerConfig.js'; // ✨ NOUVEAU
import { initMeepleActionsUI, initNetworkMeepleListeners } from '../ui/MeepleActionsUI.js';
import { initGameMenu } from '../ui/GameMenuUI.js';

/**
 * GameStarter — Encapsule le bootstrap de partie (hôte et invité).
 * Remplace startGame() et startGameForInvite() de home.js.
 */
export class GameStarter {
    constructor(deps) {
        this._d = deps;
    }

    // ── Helpers internes ──────────────────────────────────────────────────────

    _initGameState(players, fullStateData = null) {
        const d = this._d;
        const gameState = new GameState();
        d.setGameState(gameState);

        if (fullStateData) {
            const gs = fullStateData.gameState;
            (gs.players || []).forEach(p => gameState.addPlayer(p.id, p.name, p.color, p.isHost));
        } else {
            players.forEach(p => gameState.addPlayer(p.id, p.name, p.color, p.isHost));
        }

        // Ne pas démarrer sur un spectateur
        let a = 0;
        while (gameState.players[gameState.currentPlayerIndex]?.color === 'spectator' && a++ < gameState.players.length)
            gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;

        const ext = d.getGameConfig().extensions ?? {};
        if (ext.abbot)           { gameState.players.forEach(p => { p.hasAbbot       = true; }); }
        if (ext.largeMeeple)     { gameState.players.forEach(p => { p.hasLargeMeeple = true; }); }
        if (ext.tradersBuilders) { gameState.players.forEach(p => { p.hasBuilder     = true; }); }
        if (ext.pig)             { gameState.players.forEach(p => { p.hasPig         = true; }); }

        // ✨ NOUVEAU — Extension Tour : stock de pièces selon le nombre de joueurs (hors spectateurs)
        if (ext.tower) {
            const activePlayerCount = gameState.players.filter(p => p.color !== 'spectator').length;
            const pieces = getTowerPiecesForPlayerCount(activePlayerCount);
            gameState.players.forEach(p => { if (p.color !== 'spectator') p.towerPieces = pieces; });
        }

        return gameState;
    }

    _initSync(gameState, lobbyHandler = null) {
        const d = this._d;
        const gameSync = new GameSync(d.getMultiplayer(), gameState, lobbyHandler);
        gameSync.init();
        gameSync.eventBus = d.getEventBus();
        d.setGameSync(gameSync);
        return gameSync;
    }

    _initTurnManager(gameState, isHost) {
        const d = this._d;
        const tm = new TurnManager(d.getEventBus(), gameState, d.getDeck(), d.getMultiplayer(), isHost);
        tm.init();
        d.setTurnManager(tm);
        return tm;
    }

    _postModuleSetup() {
        const d = this._d;
        const cfg = d.getGameConfig();
        const meepleSelectorUI = d.getMeepleSelectorUI();
        const meepleCursorsUI  = d.getMeepleCursorsUI();
        const scorePanelUI     = d.getScorePanelUI();
        if (meepleSelectorUI) meepleSelectorUI.config = cfg;
        if (meepleCursorsUI)  meepleCursorsUI.config  = cfg;
        if (scorePanelUI)     scorePanelUI.config      = cfg;
    }

    // ── Setup post-démarrage (UI modules + ReconnectionManager + règles) ──────

    postStartSetup() {
        const d = this._d;

        // ── Bloc A : init UI modules (TurnUI déjà initialisé avant _initTurnManager) ──
        initDragonUI(d.getDragonUIDeps());
        initTowerUI(d.getTowerUIDeps()); // ✨ NOUVEAU
        initMeepleActionsUI(d.getMeepleActionsUIDeps());
        initNetworkMeepleListeners(d.getEventBus());

        // ── Bloc B : ReconnectionManager ─────────────────────────────────────
        const rm = new ReconnectionManager(d.getReconnectionManagerDeps());
        rm.initStateHandlers(d.getStateHandlerDeps());
        d.setReconnectionManager(rm);

        // Règles
        const ruleRegistry = d.getRuleRegistry();
        const gameConfig   = d.getGameConfig();
        const gameState    = d.getGameState();
        const eventBus     = d.getEventBus();
        const zoneMerger   = d.getZoneMerger();
        const placedMeeples = d.getPlacedMeeples();
        const scoring       = d.getScoring();
        const turnManager   = d.getTurnManager();

        ruleRegistry.register('base', d.getBaseRules(), gameConfig);
        ruleRegistry.enable('base');

        if (gameConfig.extensions?.abbot) {
            ruleRegistry.register('abbot', d.getAbbeRules(), gameConfig);
            ruleRegistry.enable('abbot');
        }
        if (gameConfig.extensions?.largeMeeple || gameConfig.extensions?.cathedrals || gameConfig.extensions?.inns) {
            ruleRegistry.register('inns', d.getInnsRules(), gameConfig);
            ruleRegistry.enable('inns');
        }
        if (gameConfig.extensions?.tradersBuilders || gameConfig.extensions?.pig) {
            const BuilderRules = d.getBuilderRulesClass();
            const builderRulesInst = new BuilderRules(eventBus, gameState, zoneMerger, gameConfig);
            builderRulesInst.setPlacedMeeples(placedMeeples);
            ruleRegistry.registerInstance('builders', builderRulesInst);
            ruleRegistry.enable('builders');
            if (turnManager) turnManager.builderRules = builderRulesInst;
            if (scoring)     scoring._builderRules    = builderRulesInst;
        }

        // ── Bloc C : menu UI ─────────────────────────────────────────────────
        initGameMenu({
            getGameConfig:   () => d.getGameConfig(),
            getIsHost:       () => d.getIsHost(),
            getGameCode:     () => d.getGameCode(),
            getIsSpectator:  () => d.getIsSpectator(),
        });

        // ── Bloc D : handlers réseau en cours de partie ───────────────────────
        rm.initInGameNetworkHandler(d.getInGameNetworkDeps());
    }

    // ── Point d'entrée hôte ───────────────────────────────────────────────────

    async startHost() {
        const d = this._d;
        console.log('🎮 [HÔTE] Initialisation du jeu...');
        d.startGameTimer();

        document.getElementById('lobby-page').style.display = 'none';
        document.getElementById('game-page').style.display  = 'flex';
        history.pushState({ inGame: true }, '');

        const gameState = this._initGameState(d.getPlayers());
        const gameSync  = this._initSync(gameState, null);
        initTurnUI(d.getTurnUIDeps());   // avant _initTurnManager (qui émet turn-changed)
        this._initTurnManager(gameState, true);

        d.initializeGameModules();
        this._postModuleSetup();
        d.attachGameSyncCallbacks();
        this.postStartSetup();
        d.setupEventListeners();
        d.setupNavigation();

        const deck = d.getDeck();
        const cfg  = d.getGameConfig();
        await deck.loadAllTiles(cfg.testDeck ?? false, cfg.tileGroups ?? {}, cfg.startType ?? 'unique');
        gameSync.startGame(deck);

        const startTile = d.hostDrawAndSend();
        if (startTile) d.getTurnManager().receiveYourTurn(startTile.id);
        gameSync.syncTurnEnd(false, startTile?.id ?? null);

        d.getEventBus().emit('deck-updated', { remaining: deck.remaining(), total: deck.total() });
        d.updateTurnDisplay();
        d.getSlotsUI().createCentralSlot();

        console.log('✅ Initialisation hôte terminée');
    }

    // ── Point d'entrée invité ─────────────────────────────────────────────────

    async startGuest(fullStateData = null) {
        const d = this._d;
        console.log('🎮 [INVITÉ] Initialisation du jeu...');
        d.startGameTimer();
        d.getLobbyUI().hide();
        history.pushState({ inGame: true }, '');

        const gameState = this._initGameState(d.getPlayers(), fullStateData);
        this._initSync(gameState, d.getOriginalLobbyHandler());
        initTurnUI(d.getTurnUIDeps());   // avant _initTurnManager (qui émet turn-changed)
        this._initTurnManager(gameState, false);

        d.initializeGameModules();
        this._postModuleSetup();
        d.attachGameSyncCallbacks();
        d.setupEventListeners();
        d.setupNavigation();
        this.postStartSetup();

        if (fullStateData) {
            d.getReconnectionManager().applyFullStateSync(fullStateData);
        } else {
            d.afficherMessage("En attente de l'hôte...");
        }
        console.log('✅ Initialisation invité terminée');
    }
}
