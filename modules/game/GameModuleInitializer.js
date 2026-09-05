import { ScorePanelUI }        from '../ui/ScorePanelUI.js';
import { SlotsUI }             from '../ui/SlotsUI.js';
import { TilePreviewUI }       from '../ui/TilePreviewUI.js';
import { ZoneMerger }          from './ZoneMerger.js';
import { Scoring }             from './Scoring.js';
import { TilePlacement }       from './TilePlacement.js';
import { MeeplePlacement }     from './MeeplePlacement.js';
import { MeepleCursorsUI }     from '../ui/MeepleCursorsUI.js';
import { MeepleSelectorUI }    from '../ui/MeepleSelectorUI.js';
import { MeepleDisplayUI }     from '../ui/MeepleDisplayUI.js';
import { UndoManager }         from './UndoManager.js';
import { UnplaceableTileManager } from './UnplaceableTileManager.js';
import { FinalScoresManager }  from './FinalScoresManager.js';
import { DragonRules }         from '../rules/DragonRules.js';
import { TowerRules }          from '../rules/TowerRules.js'; // ✨ NOUVEAU

/**
 * GameModuleInitializer — Instancie tous les modules de jeu.
 * Remplace initializeGameModules() de home.js.
 */
export class GameModuleInitializer {
    constructor(deps) {
        this._d = deps;
    }

    init() {
        const d = this._d;
        console.log('🔧 Initialisation des modules de jeu...');

        const eventBus    = d.getEventBus();
        const gameState   = d.getGameState();
        const gameConfig  = d.getGameConfig();
        const plateau     = d.getPlateau();
        const gameSync    = d.getGameSync();
        const deck        = d.getDeck();
        const multiplayer = d.getMultiplayer();
        const placedMeeples = d.getPlacedMeeples();
        const ruleRegistry  = d.getRuleRegistry();

        const scorePanelUI = new ScorePanelUI(eventBus, gameState, gameConfig);
        d.setScorePanelUI(scorePanelUI);

        const slotsUI = new SlotsUI(plateau, gameSync, eventBus, () => d.getTuileEnMain());
        slotsUI.init();
        slotsUI.setSlotClickHandler((x, y, tile, isFirst) => d.getTilePlacement().handlePlace(x, y, tile, isFirst));
        slotsUI.isMyTurn        = d.getIsMyTurn();
        slotsUI.firstTilePlaced = d.getFirstTilePlaced();
        d.setSlotsUI(slotsUI);

        const tilePreviewUI = new TilePreviewUI(eventBus);
        tilePreviewUI.init();
        d.setTilePreviewUI(tilePreviewUI);

        const zoneMerger = new ZoneMerger(plateau);
        const scoring    = new Scoring(zoneMerger, gameConfig);
        d.setZoneMerger(zoneMerger);
        d.setScoring(scoring);

        const tilePlacement = new TilePlacement(eventBus, plateau, zoneMerger);
        tilePlacement.initHandlers({
            getGameState:            () => d.getGameState(),
            getGameConfig:           () => d.getGameConfig(),
            getMultiplayer:          () => d.getMultiplayer(),
            getGameSync:             () => d.getGameSync(),
            getZoneMerger:           () => d.getZoneMerger(),
            getDragonRules:          () => d.getDragonRules(),
            getUndoManager:          () => d.getUndoManager(),
            getMeepleCursorsUI:      () => d.getMeepleCursorsUI(),
            getPlacedMeeples:        () => d.getPlacedMeeples(),
            getTilePreviewUI:        () => d.getTilePreviewUI(),
            getUnplaceableManager:   () => d.getUnplaceableManager(),
            getIsHost:               () => d.getIsHost(),
            getIsMyTurn:             () => d.getIsMyTurn(),
            getFirstTilePlaced:      () => d.getFirstTilePlaced(),
            setTuileEnMain:          (v) => d.setTuileEnMain(v),
            setTuilePosee:           (v) => d.setTuilePosee(v),
            setFirstTilePlaced:      (v) => d.setFirstTilePlaced(v),
            setLastPlacedTile:       (v) => d.setLastPlacedTile(v),
            setCurrentTileForPlayer: (v) => d.setCurrentTileForPlayer(v),
            tileHasVolcanoZone:      d.tileHasVolcanoZone,
            tileHasDragonZone:       d.tileHasDragonZone,
            tileHasPortalZone:       d.tileHasPortalZone,
            afficherSelecteurMeeple: d.afficherSelecteurMeeple,
            showMeepleActionCursors: d.showMeepleActionCursors,
            updateTurnDisplay:       d.updateTurnDisplay,
            updateMobileButtons:     d.updateMobileButtons,
            updateMobileTilePreview: d.updateMobileTilePreview,
        });
        d.setTilePlacement(tilePlacement);

        const meeplePlacement = new MeeplePlacement(eventBus, gameState, zoneMerger);
        meeplePlacement.setPlacedMeeples(placedMeeples);
        d.setMeeplePlacement(meeplePlacement);

        const meepleCursorsUI = new MeepleCursorsUI(multiplayer, zoneMerger, plateau, gameConfig);
        meepleCursorsUI.init();
        d.setMeepleCursorsUI(meepleCursorsUI);

        const meepleSelectorUI = new MeepleSelectorUI(multiplayer, gameState, gameConfig);
        meepleSelectorUI.zoneMerger    = zoneMerger;
        meepleSelectorUI.placedMeeples = placedMeeples;
        d.setMeepleSelectorUI(meepleSelectorUI);

        const meepleDisplayUI = new MeepleDisplayUI();
        meepleDisplayUI.init();
        d.setMeepleDisplayUI(meepleDisplayUI);

        const undoManager = new UndoManager(eventBus, gameState, plateau, zoneMerger);
        undoManager.initVisualHandlers({
            getGameConfig:        () => d.getGameConfig(),
            getMultiplayer:       () => d.getMultiplayer(),
            getPlacedMeeples:     () => d.getPlacedMeeples(),
            getDragonRules:       () => d.getDragonRules(),
            getGameSync:          () => d.getGameSync(),
            getMeepleCursorsUI:   () => d.getMeepleCursorsUI(),
            getTilePreviewUI:     () => d.getTilePreviewUI(),
            getSlotsUI:           () => d.getSlotsUI(),
            getTilePlacement:     () => d.getTilePlacement(),
            getIsMyTurn:          () => d.getIsMyTurn(),
            getLastPlacedTile:    () => d.getLastPlacedTile(),
            getFirstTilePlaced:   () => d.getFirstTilePlaced(),
            setLastPlacedTile:    (v) => d.setLastPlacedTile(v),
            setTuileEnMain:       (v) => d.setTuileEnMain(v),
            setTuilePosee:        (v) => d.setTuilePosee(v),
            setFirstTilePlaced:   (v) => d.setFirstTilePlaced(v),
            setPendingAbbePoints: (v) => d.setPendingAbbePoints(v),
            renderDragonPiece:    d.renderDragonPiece,
            renderFairyPiece:     d.renderFairyPiece,
            removeFairyPiece:     d.removeFairyPiece,
            updateDragonOverlay:  d.updateDragonOverlay,
            showDragonMoveCursors:    d.showDragonMoveCursors,
            showDragonVisitedTiles:   d.showDragonVisitedTiles,
            tileHasVolcanoZone:   d.tileHasVolcanoZone,
            afficherSelecteurMeeple: d.afficherSelecteurMeeple,
            showMeepleActionCursors: d.showMeepleActionCursors,
            hideAllCursors:       d.hideAllCursors,
            updateTurnDisplay:    d.updateTurnDisplay,
        });
        d.setUndoManager(undoManager);

        // Extension Dragon
        if (gameConfig.extensions?.dragon || gameConfig.tileGroups?.dragon) {
            const dragonRules = new DragonRules({
                gameState, plateau: plateau.placedTiles, placedMeeples, eventBus, ruleRegistry
            });
            d.setDragonRules(dragonRules);
            console.log('🐉 [Dragon] DragonRules initialisé');
        } else {
            d.setDragonRules(null);
        }

        // ✨ NOUVEAU — Extension Tour
        if (gameConfig.tileGroups?.tower && gameConfig.extensions?.tower) {
            const towerRules = new TowerRules({ gameState, plateau });
            d.setTowerRules(towerRules);
            console.log('🗼 [Tour] TowerRules initialisé');
        } else {
            d.setTowerRules(null);
        }

        const unplaceableManager = new UnplaceableTileManager({
            deck, gameState, tilePreviewUI, gameSync, gameConfig, plateau,
            setRedrawMode: (active) => { d.setWaitingToRedraw(active); d.updateTurnDisplay(); },
            triggerEndGame: () => {
                if (deck.remaining() <= 0) {
                    if (gameSync) gameSync.syncTurnEnd();
                    d.getFinalScoresManager()?.computeAndApply(d.getPlacedMeeples());
                }
            }
        });
        unplaceableManager.initNetworkListeners(eventBus, () => d.getIsHost(), () => d.getMultiplayer());
        d.setUnplaceableManager(unplaceableManager);

        const finalScoresManager = new FinalScoresManager({
            gameState, scoring: d.getScoring(), zoneMerger, gameSync, eventBus,
            updateTurnDisplay: d.updateTurnDisplay, gameConfig
        });
        d.setFinalScoresManager(finalScoresManager);

        const thMerchants = document.getElementById('th-merchants');
        if (thMerchants) thMerchants.style.display = gameConfig?.extensions?.merchants ? '' : 'none';

        console.log('✅ Tous les modules initialisés');
    }
}
