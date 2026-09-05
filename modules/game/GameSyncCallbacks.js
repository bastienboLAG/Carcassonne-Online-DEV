import { Tile } from '../Tile.js';
import { executeAddFloorHost, executeTowerCaptureHost } from './TowerUI.js'; // ✨ NOUVEAU

/**
 * GameSyncCallbacks - Factorise tous les callbacks réseau (hôte et invités)
 */
export class GameSyncCallbacks {
    constructor({
        gameSync, gameState, deck, turnManager, tilePreviewUI, meepleDisplayUI,
        undoManager, unplaceableManager, scoring, zoneMerger, slotsUI, eventBus,
        plateau, gameConfig, ruleRegistry, scorePanelUI, tilePlacement, dragonRules,
        finalScoresManager, getPlacedMeeples, getWaitingToRedraw, setWaitingToRedraw,
        onRemoteUndo, onFinalScores, onTileDestroyed, onDeckReshuffled,
        onAbbeRecalled, onAbbeRecalledUndo, onBonusTurnStarted, onUnplaceableHandled,
        onGamePaused, onGameResumed, onFullStateSync,
        updateTurnDisplay, poserTuileSync, afficherMessage,
        onUpdateMobileTilePreview = null, updateMobileButtons = null,
        releaseFairyIfDetached, broadcastDragonState, startDragonTurnUI,
        executeDragonMoveHost, advanceDragonTurnHost, handlePrincessEject,
        tileHasDragonZone, tileHasVolcanoZone,
        setTuileEnMain, setCurrentTileForPlayer, getTuileEnMain = null,
        isHost = false,
    }) {
        Object.assign(this, {
            gameSync, gameState, deck, turnManager, tilePreviewUI, meepleDisplayUI,
            undoManager, unplaceableManager: unplaceableManager ?? null, scoring,
            zoneMerger, slotsUI, eventBus, plateau, gameConfig, ruleRegistry,
            scorePanelUI, tilePlacement, dragonRules, finalScoresManager,
            getPlacedMeeples, getWaitingToRedraw, setWaitingToRedraw,
            onRemoteUndo, onFinalScores, onTileDestroyed, onDeckReshuffled,
            onAbbeRecalled, onAbbeRecalledUndo,
            onBonusTurnStarted: onBonusTurnStarted ?? null,
            onUnplaceableHandled: onUnplaceableHandled ?? null,
            _onGamePaused:    onGamePaused  ?? null,
            _onGameResumed:   onGameResumed ?? null,
            _onFullStateSync: onFullStateSync ?? null,
            updateTurnDisplay, poserTuileSync, afficherMessage,
            onUpdateMobileTilePreview, updateMobileButtons,
            releaseFairyIfDetached, broadcastDragonState, startDragonTurnUI,
            executeDragonMoveHost, advanceDragonTurnHost, handlePrincessEject,
            tileHasDragonZone, tileHasVolcanoZone,
            setTuileEnMain, setCurrentTileForPlayer, getTuileEnMain,
            isHost,
        });
    }

    attach(isHost) {
        const gs = this.gameSync;

        gs.onGameStarted = (deckData, gameStateData) => {
            this.deck.tiles = deckData.tiles; this.deck.currentIndex = deckData.currentIndex; this.deck.totalTiles = deckData.totalTiles;
            this.gameState.deserialize(gameStateData);
            this.eventBus.emit('deck-updated', { remaining: this.deck.remaining(), total: this.deck.total() });
            this.updateTurnDisplay();
            this.slotsUI.createCentralSlot();
        };

        gs.onTileRotated = (rotation) => {
            const img = document.getElementById('current-tile-img');
            if (img) { const d = parseInt(img.style.transform.match(/rotate\((\d+)deg\)/)?.[1] || '0'); img.style.transform = `rotate(${d + 90}deg)`; }
            this.eventBus.emit('tile-rotated', { rotation });
        };

        gs.onTilePlacedRequest = (x, y, tileId, rotation, fromPlayerId) => {
            console.log('📍 [HÔTE] tile-placed-request de:', fromPlayerId, x, y, tileId);
            const tileData = this.deck.tiles.find(t => t.id === tileId); if (!tileData) return;
            const tile = new Tile(tileData); tile.rotation = rotation;
            this.poserTuileSync(x, y, tile, { skipValidation: false });
            this.undoManager?.saveAfterTilePlaced(x, y, tile, this.getPlacedMeeples());
            this.gameState.currentTilePlaced = true;
            gs.multiplayer.broadcast({ type: 'tile-placed', x, y, tileId: tile.id, rotation: tile.rotation, playerId: fromPlayerId,
                zoneRegistry: this.zoneMerger.registry.serialize(), tileToZone: Array.from(this.zoneMerger.tileToZone.entries()) });
        };

        gs.onTilePlaced = (x, y, tileId, rotation, zoneRegistryData, tileToZoneData) => {
            console.log('📍 [SYNC] Placement reçu:', x, y, tileId, rotation);
            this.gameState.currentTilePlaced = true;
            const tileData = this.deck.tiles.find(t => t.id === tileId); if (!tileData) return;
            const tile = new Tile(tileData); tile.rotation = rotation;
            this.poserTuileSync(x, y, tile, { skipValidation: true, ...(zoneRegistryData ? { skipZoneMerger: true } : {}) });
            if (zoneRegistryData && tileToZoneData) {
                this.zoneMerger.registry.deserialize(zoneRegistryData);
                this.zoneMerger.tileToZone = new Map(tileToZoneData);
                console.log('✅ [SYNC] ZoneRegistry appliqué depuis hôte');
            }
            if (this.undoManager && this.isHost) this.undoManager.saveAfterTilePlaced(x, y, tile, this.getPlacedMeeples());
            if (!this.isHost && this.turnManager?.isMyTurn) {
                console.log('📍 [INVITÉ] Echo reçu — affichage curseurs meeple');
                this.eventBus.emit('tile-placed-own', { x, y, tile });
            }
        };

        gs.onTurnEnded = (nextPlayerIndex, gameStateData, isBonusTurn = false, nextTileId = null) => {
            this.gameState.currentTilePlaced = false;
            this.turnManager.receiveTurnEnded(nextPlayerIndex, gameStateData, isBonusTurn, nextTileId);
            if (isBonusTurn && this.onBonusTurnStarted) this.onBonusTurnStarted(this.gameState.getCurrentPlayer()?.id);

        };

        gs.onTileDrawn = (tileId, rotation) => { this.turnManager.receiveTileDrawn(tileId, rotation); };

        gs.onMeeplePlaced = (x, y, position, meepleType, color, playerId) => {
            console.log('🎭 [SYNC] Meeple placé reçu');
            const key = `${x},${y},${position}`; const pm = this.getPlacedMeeples();
            pm[key] = { type: meepleType, color, playerId };
            this.meepleDisplayUI.showMeeple(x, y, position, meepleType, color);
            if (!this.isHost && playerId === gs.multiplayer.playerId)
                this.eventBus.emit('meeple-placed-own', { x, y, position, meepleType });
        };

        gs.onMeepleCountUpdate = (playerId, meeples, hasAbbot, hasLargeMeeple, hasBuilder, hasPig) => {
            const player = this.gameState.players.find(p => p.id === playerId);
            if (player) {
                player.meeples = meeples;
                if (hasAbbot       !== undefined) player.hasAbbot       = hasAbbot;
                if (hasLargeMeeple !== undefined) player.hasLargeMeeple = hasLargeMeeple;
                if (hasBuilder     !== undefined) player.hasBuilder     = hasBuilder;
                if (hasPig         !== undefined) player.hasPig         = hasPig;
                this.eventBus.emit('meeple-count-updated', { playerId, meeples });
            }
        };

        gs.onScoreUpdate = (scoringResults, meeplesToReturn, goodsResults = [], zoneRegistryData = null, tileToZoneData = null) => {
            console.log('💰 [SYNC] Mise à jour des scores reçue');
            const pm = this.getPlacedMeeples();
            scoringResults.forEach(({ playerId, points, zoneType }) => {
                const p = this.gameState.players.find(pl => pl.id === playerId); if (!p) return;
                p.score += points; p.scoreDetail = p.scoreDetail || {};
                if (zoneType === 'city')              p.scoreDetail.cities      = (p.scoreDetail.cities      || 0) + points;
                else if (zoneType === 'road')         p.scoreDetail.roads       = (p.scoreDetail.roads       || 0) + points;
                else if (zoneType === 'abbey')        p.scoreDetail.monasteries = (p.scoreDetail.monasteries || 0) + points;
                else if (zoneType === 'fairy-turn' || zoneType === 'fairy') p.scoreDetail.fairy = (p.scoreDetail.fairy || 0) + points;
            });
            goodsResults.forEach(({ playerId, cloth, wheat, wine }) => {
                const p = this.gameState.players.find(pl => pl.id === playerId); if (!p) return;
                p.goods = p.goods || { cloth: 0, wheat: 0, wine: 0 };
                p.goods.cloth += cloth; p.goods.wheat += wheat; p.goods.wine += wine;
            });
            if (zoneRegistryData) {
                this.zoneMerger.registry.deserialize(zoneRegistryData);
                if (tileToZoneData) this.zoneMerger.tileToZone = new Map(tileToZoneData);
                console.log('✅ [SYNC] ZoneRegistry post-scoring appliqué');
            }
            meeplesToReturn.forEach(key => {
                document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
                const meeple = pm[key]; if (!meeple) return;
                const p = this.gameState.players.find(pl => pl.id === meeple.playerId); if (!p) return;
                if (meeple.type === 'Abbot')                                         p.hasAbbot       = true;
                else if (meeple.type === 'Large' || meeple.type === 'Large-Farmer') p.hasLargeMeeple = true;
                else if (meeple.type === 'Builder')                                  p.hasBuilder     = true;
                else if (meeple.type === 'Pig')                                      p.hasPig         = true;
                else if (p.meeples < 7)                                              p.meeples++;
                this.eventBus.emit('meeple-count-updated', { playerId: meeple.playerId });
                delete pm[key];
            });
            this.updateTurnDisplay();
            if (this.gameState.fairyState?.meepleKey === null && this.gameState.fairyState?.ownerId === null)
                this.eventBus.emit('fairy-detached-show-targets');
        };

        gs.onTurnUndo = (undoneAction) => { console.log('⏪ [SYNC] Annulation distante reçue'); this.onRemoteUndo(undoneAction); };

        gs.onPlayerDisconnected = (peerId, playerName, nextPlayerIndex) => {
            console.log('👋 [SYNC] Joueur déconnecté:', playerName);
            if (this.gameState) { this.gameState.markDisconnected(peerId); this.gameState.currentPlayerIndex = nextPlayerIndex; }
            if (this.afficherMessage) this.afficherMessage(`💔 ${playerName} s'est déconnecté.`);
            if (this._onGamePaused) this._onGamePaused(playerName);
            if (this.turnManager) {
                this.turnManager.updateTurnState();
                this.turnManager.eventBus.emit('turn-changed', { isMyTurn: this.turnManager.isMyTurn, currentPlayer: this.turnManager.getCurrentPlayer() });
            }
        };

        gs.onGamePaused    = (name)   => { if (this._onGamePaused)   this._onGamePaused(name); };
        gs.onGameResumed   = (reason) => { if (this._onGameResumed)  this._onGameResumed(reason); };
        gs.onFullStateSync = (data)   => { if (this._onFullStateSync) this._onFullStateSync(data); };
        gs.onGameEnded     = (scores, destroyedCount = 0) => { console.log('🏁 [SYNC] Fin de partie reçue'); this.onFinalScores(scores, destroyedCount); };

        gs.onTileDestroyed = (tileId, playerName, action, count, playerId) => {
            console.log('🗑️ [SYNC] Tuile détruite:', tileId);
            if (this.tilePreviewUI) this.tilePreviewUI.showBackside();
            if (this.onUpdateMobileTilePreview) this.onUpdateMobileTilePreview();
            this.onTileDestroyed(tileId, playerName, action, count, playerId);
        };

        gs.onYourTurn = (tileId) => { console.log('🎲 [INVITÉ] your-turn reçu:', tileId); this.turnManager.receiveYourTurn(tileId); };

        gs.onUnplaceableHandled = (tileId, playerName, action, isRiver, activePeerId) => {
            console.log('🚫 [SYNC] Tuile implaçable traitée:', tileId);
            if (this.unplaceableManager) this.unplaceableManager.hideUnplaceableBadge();
            if (this.tilePreviewUI) this.tilePreviewUI.showBackside();
            if (this.onUpdateMobileTilePreview) this.onUpdateMobileTilePreview();
            const isActivePlayer = activePeerId === gs?.multiplayer?.playerId;
            if (this.onUnplaceableHandled) this.onUnplaceableHandled(tileId, playerName, action, isRiver, isActivePlayer);
        };

        gs.onAbbeRecalled    = (x, y, key, playerId, points) => { if (this.onAbbeRecalled)    this.onAbbeRecalled(x, y, key, playerId, points); };
        gs.onAbbeRecalledUndo = (x, y, key, playerId)        => { if (this.onAbbeRecalledUndo) this.onAbbeRecalledUndo(x, y, key, playerId); };

        gs.onDeckReshuffled = (tiles, currentIndex) => {
            console.log('🔀 [SYNC] Deck remélangé, currentIndex:', currentIndex);
            this.deck.tiles = tiles; this.deck.currentIndex = currentIndex;
            this.onDeckReshuffled(tiles, currentIndex);
        };

        // ✨ NOUVEAU — Extension Tour : reçu par tous (guest ET host via echo, mais host ignore son propre echo)
        gs.onTowerFloorPlaced = (data) => {
            if (this.isHost) return; // l'hôte a déjà appliqué localement dans executeAddFloorHost
            this.eventBus.emit('network-tower-floor-placed', data);
        };
        gs.onTowerCaptureExecuted = (data) => {
            if (this.isHost) return;
            this.eventBus.emit('network-tower-capture-executed', data);
        };

        if (isHost) this._attachHostCallbacks(gs);
    }

    hostDrawAndSend() {
        if (!this.deck || !this.gameSync) return null;
        const tileData = this.deck.draw();
        if (!tileData) {
            console.log('⚠️ Pioche vide !');
            this.eventBus.emit('deck-empty');
            return null;
        }

        // Extension Dragon : tuile dragon piochée sans volcan (prématurée)
        if (this.gameConfig.tileGroups?.dragon && this.gameConfig.extensions?.dragon &&
            this.tileHasDragonZone(tileData) &&
            !Object.values(this.plateau.placedTiles ?? {}).some(t => this.tileHasVolcanoZone(t))) {
            console.log('🐉 [HÔTE] Tuile dragon sans volcan — badge implaçable:', tileData.id);
            this.setTuileEnMain(tileData);
            this.setCurrentTileForPlayer(tileData);

            const _cp          = this.gameState.getCurrentPlayer();
            const _cpId        = _cp?.id   ?? null;
            const _cpName      = _cp?.name ?? '?';
            const isHostPlayer = _cpId === this.gameSync.multiplayer.playerId;

            if (isHostPlayer) {
                if (this.tilePreviewUI) this.tilePreviewUI.showTile(tileData);
                this.gameSync.syncTileDraw(tileData.id, 0);
                this.unplaceableManager?.showUnplaceableBadgeDragon(tileData.id);
            } else {
                if (this.tilePreviewUI) this.tilePreviewUI.showBackside();
                this.gameSync.syncTileDraw(tileData.id, 0);
                this.gameSync.multiplayer.broadcast({
                    type: 'dragon-premature-tile', tileId: tileData.id,
                    playerName: _cpName, playerId: _cpId,
                });
            }
            return tileData;
        }

        console.log('🎲 [HÔTE] Pioche:', tileData.id, '→', this.gameState.getCurrentPlayer()?.name);
        this.setCurrentTileForPlayer(tileData);
        this.gameSync.syncTileDraw(tileData.id, 0);
        return tileData;
    }

    _attachHostCallbacks(gs) {

        gs.onUndoRequest = (playerId) => {
            console.log('⏪ [HÔTE] Undo-request de:', playerId);
            const um = this.undoManager;
            if (!um || !um.canUndo()) { console.log('⏪ [HÔTE] Rien à annuler'); return; }
            const undoneAction = um.undo(this.getPlacedMeeples());
            if (!undoneAction) return;
            if (undoneAction.type === 'meeple' && um.afterTilePlacedSnapshot?.pendingPortalTile !== undefined)
                this.gameState._pendingPortalTile = um.afterTilePlacedSnapshot.pendingPortalTile;
            const pm = this.getPlacedMeeples();
            undoneAction.postUndoState = {
                placedTileKeys: Object.keys(this.plateau.placedTiles),
                zones:          this.zoneMerger.registry.serialize(),
                tileToZone:     Array.from(this.zoneMerger.tileToZone.entries()),
                placedMeeples:  JSON.parse(JSON.stringify(pm)),
                playerMeeples:  this.gameState.players.map(p => ({ id: p.id, meeples: p.meeples, hasAbbot: p.hasAbbot, hasLargeMeeple: p.hasLargeMeeple, hasBuilder: p.hasBuilder, hasPig: p.hasPig })),
                fairyState:     JSON.parse(JSON.stringify(this.gameState.fairyState ?? { ownerId: null, meepleKey: null })),
                dragonPos:      JSON.parse(JSON.stringify(this.gameState.dragonPos ?? null)),
                dragonPhase:    JSON.parse(JSON.stringify(this.gameState.dragonPhase ?? {})),
                pendingPortalTile: this.gameState._pendingPortalTile ? JSON.parse(JSON.stringify(this.gameState._pendingPortalTile)) : null
            };
            um.applyLocally(undoneAction);
            if (this.gameSync) this.gameSync.syncUndo(undoneAction);
            this.gameState.players.forEach(p => this.eventBus.emit('meeple-count-updated', { playerId: p.id }));
            this.eventBus.emit('score-updated');
            this.updateTurnDisplay();
            if (this.onUpdateMobileTilePreview) this.onUpdateMobileTilePreview();
            if (this.scorePanelUI) this.scorePanelUI.updateMobile();
            if (this.updateMobileButtons) this.updateMobileButtons();
        };

        gs.onMeeplePlacedRequest = (x, y, position, meepleType, fromPlayerId) => {
            console.log('🎭 [HÔTE] meeple-placed-request de:', fromPlayerId, x, y, position, meepleType);
            const player = this.gameState.players.find(p => p.id === fromPlayerId); if (!player) return;
            const playerColor = player.color.charAt(0).toUpperCase() + player.color.slice(1);
            const key = `${x},${y},${position}`; const pm = this.getPlacedMeeples();
            pm[key] = { type: meepleType, color: playerColor, playerId: fromPlayerId };
            if (!['Abbot','Large','Large-Farmer','Builder','Pig'].includes(meepleType)) { if (player.meeples > 0) player.meeples--; }
            else if (meepleType === 'Abbot')                                          { player.hasAbbot       = false; }
            else if (meepleType === 'Large' || meepleType === 'Large-Farmer')         { player.hasLargeMeeple = false; }
            else if (meepleType === 'Builder')                                         { player.hasBuilder     = false; }
            else if (meepleType === 'Pig')                                             { player.hasPig         = false; }
            if (this.undoManager) this.undoManager.markMeeplePlaced(x, y, position, key);
            this.eventBus.emit('meeple-count-updated', { playerId: fromPlayerId });
            if (this.meepleDisplayUI) this.meepleDisplayUI.showMeeple(x, y, position, meepleType, playerColor);
            gs.multiplayer.broadcast({ type: 'meeple-placed', x, y, position, meepleType, color: playerColor, playerId: fromPlayerId });
            gs.multiplayer.broadcast({ type: 'meeple-count-update', playerId: fromPlayerId, meeples: player.meeples, hasAbbot: player.hasAbbot, hasLargeMeeple: player.hasLargeMeeple, hasBuilder: player.hasBuilder, hasPig: player.hasPig });
        };

        gs.onTurnEndRequest = (playerId, nextPlayerIndex, gameStateData, isBonusTurnRequest, pendingAbbeData = null) => {
            console.log('⏭️ [HÔTE] turn-end-request de:', playerId);
            this.setWaitingToRedraw(false); gs._pendingUnplaceableRedraw = null;
            const currentPlayer = this.gameState.getCurrentPlayer();
            if (!currentPlayer || currentPlayer.id !== playerId) { console.warn('⚠️ [HÔTE] rejeté: pas le tour de', playerId); return; }
            if (!this.gameState.currentTilePlaced) { console.warn('⚠️ [HÔTE] rejeté: tuile non posée pour', playerId); return; }
            if (pendingAbbeData) {
                const p = this.gameState.players.find(pl => pl.id === pendingAbbeData.playerId);
                if (p) { p.score += pendingAbbeData.points; p.scoreDetail = p.scoreDetail || {}; p.scoreDetail.monasteries = (p.scoreDetail.monasteries || 0) + pendingAbbeData.points; }
            }
            let isBonusTurn = false;
            if (this.gameConfig.extensions?.tradersBuilders && !isBonusTurnRequest) {
                const builderRulesInst = this.ruleRegistry.rules?.get('builders');
                if (builderRulesInst?.checkBonusTrigger(playerId)) isBonusTurn = true;
            }
            if (this.scoring && this.zoneMerger) {
                const newlyClosed = this.tilePlacement?.newlyClosedZones ?? null;
                const { scoringResults, meeplesToReturn, goodsResults } = this.scoring.scoreClosedZones(this.getPlacedMeeples(), playerId, this.gameState, newlyClosed);
                const fairyKeySnap    = this.gameState.fairyState?.meepleKey ?? null;
                const fairyOwnerSnap  = this.gameState.fairyState?.ownerId   ?? null;
                if (scoringResults.length > 0 || goodsResults.length > 0) {
                    const pm = this.getPlacedMeeples();
                    scoringResults.forEach(({ playerId: pid, points, zoneType }) => {
                        const p = this.gameState.players.find(pl => pl.id === pid); if (!p) return;
                        p.score += points;
                        if (zoneType === 'city')                               p.scoreDetail.cities      += points;
                        else if (zoneType === 'road')                          p.scoreDetail.roads       += points;
                        else if (zoneType === 'abbey' || zoneType === 'garden') p.scoreDetail.monasteries += points;
                    });
                    meeplesToReturn.forEach(key => {
                        const meeple = pm[key]; if (!meeple) return;
                        const p = this.gameState.players.find(pl => pl.id === meeple.playerId); if (!p) return;
                        if (meeple.type === 'Abbot')                                         p.hasAbbot       = true;
                        else if (meeple.type === 'Large' || meeple.type === 'Large-Farmer') p.hasLargeMeeple = true;
                        else if (meeple.type === 'Builder')                                  p.hasBuilder     = true;
                        else if (meeple.type === 'Pig')                                      p.hasPig         = true;
                        else if (p.meeples < 7)                                              p.meeples++;
                        document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
                        delete pm[key];
                        this.releaseFairyIfDetached(key);
                        this.eventBus.emit('meeple-count-updated', { playerId: meeple.playerId });
                    });
                    if (this.gameSync) this.gameSync.syncScoreUpdate(scoringResults, meeplesToReturn, goodsResults, this.zoneMerger);
                    if (this.gameConfig.extensions?.fairyProtection && fairyKeySnap && !this.gameState.fairyState?.meepleKey)
                        this.eventBus.emit('fairy-detached-show-targets');
                    if (this.gameConfig.extensions?.fairyScoreZone && fairyKeySnap && meeplesToReturn.includes(fairyKeySnap)) {
                        const fp = this.gameState.players.find(p => p.id === fairyOwnerSnap);
                        if (fp) {
                            fp.score += 3; fp.scoreDetail = fp.scoreDetail || {}; fp.scoreDetail.fairy = (fp.scoreDetail.fairy || 0) + 3;
                            console.log(`🧚 [Fée] +3 points fermeture zone pour ${fp.name}`);
                            if (this.gameSync) this.gameSync.syncScoreUpdate([{ playerId: fairyOwnerSnap, points: 3, zoneType: 'fairy' }], [], [], this.zoneMerger);
                            this.eventBus.emit('score-updated');
                        }
                    }
                }
            }
            this.gameState.currentTilePlaced = false;
            if (this.gameConfig.tileGroups?.dragon && this.gameConfig.extensions?.dragon && this.dragonRules && this.gameState._pendingVolcanoPos) {
                const { x: vx, y: vy } = this.gameState._pendingVolcanoPos;
                this.dragonRules.onVolcanoPlaced(vx, vy); this.gameState._pendingVolcanoPos = null;
                this.broadcastDragonState();
            }
            if (this.gameConfig.tileGroups?.dragon && this.gameConfig.extensions?.dragon && this.dragonRules && this.gameState._pendingDragonTile) {
                const { playerIndex } = this.gameState._pendingDragonTile;
                this.gameState._pendingDragonTile = null; this.gameState._pendingPrincessTile = null; this.gameState._pendingPortalTile = null;
                this.gameState._pendingTowerCapture = null; // ✨ NOUVEAU
                if (this.undoManager) this.undoManager.reset();
                const started = this.dragonRules.onDragonTilePlaced(playerIndex);
                if (started) {
                    this.broadcastDragonState(); this.gameSync.syncDragonPhaseStarted(this.gameState.dragonPhase);
                    this.startDragonTurnUI(); return;
                }
            }
            this.gameState._pendingPrincessTile = null; this.gameState._pendingPortalTile = null;
            this.gameState._pendingTowerCapture = null; // ✨ NOUVEAU
            if (this.undoManager) this.undoManager.reset();
            if (this.turnManager) this.turnManager.endTurnRemote(isBonusTurn);
            if (isBonusTurn) this.ruleRegistry.rules?.get('builders')?.resetLastPlacedTile?.();
            if (this.deck.remaining() <= 0) { this.gameSync.syncTurnEnd(false, null); this.finalScoresManager.computeAndApply(this.getPlacedMeeples()); return; }
            const _nextTile = this.hostDrawAndSend();
            if (_nextTile) this.turnManager.receiveYourTurn(_nextTile.id);
            this.gameSync.syncTurnEnd(isBonusTurn, _nextTile?.id ?? null);
        };

        gs.onUnplaceableConfirm = (playerId, tileId) => {
            console.log('🚫 [HÔTE] Tuile implaçable de:', playerId, '— tileId:', tileId);
            if (!this.unplaceableManager) return;
            const guestTile = this.deck.tiles.find(t => t.id === tileId) ?? { id: tileId };
            const result    = this.unplaceableManager.handleConfirm(guestTile, this.gameSync, playerId);
            if (this.tilePreviewUI) this.tilePreviewUI.showBackside();
            if (!result) { gs._pendingUnplaceableRedraw = playerId; return; }
            this.gameSync.syncUnplaceableHandled(result.tileId, result.playerName, result.action, result.isRiver, playerId);
            if (!result.special) this.unplaceableManager.showTileDestroyedModal(result.tileId, result.playerName, false, result.action, result.isRiver);
            gs._pendingUnplaceableRedraw = playerId;
        };

        gs.onUnplaceableRedraw = (playerId) => {
            console.log('🔄 [HÔTE] Repiocher après implaçable pour:', playerId);
            const _nextTile = this.hostDrawAndSend();
            if (_nextTile) {
                const isHostPlayer = playerId === gs.multiplayer.playerId || playerId === gs.multiplayer.peerId;
                if (isHostPlayer) { this.turnManager.receiveYourTurn(_nextTile.id); }
                else {
                    const conn = gs.multiplayer.connections.find(c => c.peer === playerId);
                    if (conn?.open) conn.send({ type: 'your-turn', tileId: _nextTile.id });
                    if (this.tilePreviewUI) this.tilePreviewUI.showTile(_nextTile);
                }
            }
            gs._pendingUnplaceableRedraw = null;
        };

        gs.multiplayer.onDataReceived = ((prev) => (data, from) => {
            if (data.type === 'dragon-move-request') {
                const mover = this.gameState.players[this.gameState.dragonPhase.moverIndex];
                if (!this.gameState.dragonPhase.active || mover?.id !== from) { console.warn('⚠️ dragon-move-request rejeté de', from); return; }
                this.executeDragonMoveHost(data.x, data.y); return;
            }
            if (data.type === 'dragon-end-turn-request') {
                const mover = this.gameState.players[this.gameState.dragonPhase.moverIndex];
                if (!this.gameState.dragonPhase.active || mover?.id !== from) { console.warn('⚠️ dragon-end-turn-request rejeté de', from); return; }
                this.advanceDragonTurnHost(); return;
            }
            if (data.type === 'princess-eject-request') { this.handlePrincessEject(data.meepleKey); return; }
            if (data.type === 'portal-meeple-request') {
                const { x, y, position, meepleType, playerId: fromId } = data;
                const pPlayer = this.gameState.players.find(p => p.id === fromId); if (!pPlayer) return;
                const pColor = pPlayer.color.charAt(0).toUpperCase() + pPlayer.color.slice(1);
                const pKey   = `${x},${y},${position}`; const pm = this.getPlacedMeeples();
                pm[pKey] = { type: meepleType, color: pColor, playerId: fromId };
                if (meepleType === 'Abbot')                                          pPlayer.hasAbbot       = false;
                else if (meepleType === 'Large' || meepleType === 'Large-Farmer')   pPlayer.hasLargeMeeple = false;
                else if (pPlayer.meeples > 0)                                        pPlayer.meeples--;
                if (this.undoManager) this.undoManager.markMeeplePlaced(x, y, position, pKey);
                this.gameState._pendingPortalTile = null;
                if (this.meepleDisplayUI) this.meepleDisplayUI.showMeeple(x, y, position, meepleType, pColor);
                gs.multiplayer.broadcast({ type: 'portal-meeple-placed', x, y, position, meepleType, playerId: fromId, color: pColor });
                this.eventBus.emit('meeple-count-updated', { playerId: fromId }); return;
            }
            // ✨ NOUVEAU — Extension Tour : requêtes invité → hôte
            if (data.type === 'tower-floor-request') {
                if (this.gameState.getCurrentPlayer()?.id !== from) { console.warn('⚠️ tower-floor-request rejeté de', from); return; }
                executeAddFloorHost(data.x, data.y, from);
                return;
            }
            if (data.type === 'tower-capture-request') {
                if (this.gameState.getCurrentPlayer()?.id !== from) { console.warn('⚠️ tower-capture-request rejeté de', from); return; }
                executeTowerCaptureHost(data.meepleKey, from);
                return;
            }
            if (prev) prev(data, from);
        })(gs.multiplayer.onDataReceived);
    }

    incrementPlayerMeeples(playerId) {
        const player = this.gameState.players.find(p => p.id === playerId);
        if (player && player.meeples < 7) {
            player.meeples++;
            console.log(`🎭 ${player.name} récupère un meeple (${player.meeples}/7)`);
            this.eventBus.emit('score-updated');
            if (this.gameSync) {
                this.gameSync.multiplayer.broadcast({
                    type: 'meeple-count-update', playerId, meeples: player.meeples
                });
            }
        }
    }
}
