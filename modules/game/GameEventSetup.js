/**
 * GameEventSetup — Installe tous les event listeners du jeu.
 * Remplace setupEventListeners() de home.js.
 * Appelé une seule fois au démarrage via install(deps).
 */
export class GameEventSetup {
    constructor() {
        this._installed = false;
    }

    install(d) {
        if (this._installed) {
            console.log('⚠️ Event listeners déjà installés, skip');
            return;
        }

        this._installTileRotation(d);
        this._installEndTurn(d);
        this._installNavigation(d);
        this._installMenu(d);
        this._installUndo(d);
        this._installModals(d);
        this._installMobile(d);
        this._installMobileMenu(d);

        this._installed = true;
        console.log('✅ Event listeners installés');
    }

    _closeMenu() {
        const popover = document.getElementById('game-menu-popover');
        if (popover) popover.style.display = 'none';
    }

    // ── Rotation tuile ────────────────────────────────────────────────────────

    _installTileRotation(d) {
        document.getElementById('tile-preview').addEventListener('click', () => {
            if (!d.getIsMyTurn() && d.getGameSync()) { console.log('⚠️ Pas votre tour !'); return; }
            const tuileEnMain = d.getTuileEnMain();
            if (!tuileEnMain || d.getTuilePosee()) return;

            const currentImg   = document.getElementById('current-tile-img');
            const nextRotation = (tuileEnMain.rotation + 90) % 360;
            const gameSync     = d.getGameSync();
            if (gameSync && !d.getIsHost()) {
                gameSync.syncTileRotation(nextRotation);
            } else {
                d.setTuileEnMainRotation(nextRotation);
                const currentDeg = parseInt(currentImg.style.transform.match(/rotate\((\d+)deg\)/)?.[1] || '0');
                currentImg.style.transform = `rotate(${currentDeg + 90}deg)`;
                d.getEventBus().emit('tile-rotated', { rotation: nextRotation });
                if (gameSync) gameSync.syncTileRotation(nextRotation);
            }
        });
    }

    // ── Bouton fin de tour ────────────────────────────────────────────────────

    _installEndTurn(d) {
        document.getElementById('end-turn-btn').onclick = () => {
            const finalScoresManager = d.getFinalScoresManager();
            if (finalScoresManager?.gameEnded) {
                finalScoresManager.showModal(finalScoresManager.finalScoresData);
                return;
            }

            if (d.getWaitingToRedraw() && d.getIsMyTurn()) {
                document.getElementById('tile-destroyed-modal').style.display = 'none';
                if (d.getIsHost()) {
                    const _t = d.hostDrawAndSend();
                    if (_t) d.getTurnManager().receiveYourTurn(_t.id);
                    d.setWaitingToRedraw(false);
                } else {
                    const gameSync = d.getGameSync();
                    if (gameSync) gameSync.syncUnplaceableRedraw();
                }
                d.updateTurnDisplay();
                return;
            }

            const gameState  = d.getGameState();
            const gameConfig = d.getGameConfig();
            const isDragonPhase = !!(gameConfig?.extensions?.dragon && gameState?.dragonPhase?.active);
            if (isDragonPhase) {
                const mover = gameState.players[gameState.dragonPhase.moverIndex];
                if (mover?.id !== d.getMultiplayer().playerId) return;
                if (!d.getUndoManager()?.dragonMovePlacedThisTurn) return;
                d.clearDragonCursors();
                if (d.getIsHost()) {
                    d.advanceDragonTurnHost();
                } else {
                    const hostConn = d.getGameSync()?.multiplayer?.connections?.[0];
                    if (hostConn?.open) hostConn.send({ type: 'dragon-end-turn-request', playerId: d.getMultiplayer().playerId });
                }
                return;
            }

            const gameSync = d.getGameSync();
            if (!d.getIsMyTurn() && gameSync) { alert("Ce n'est pas votre tour !"); return; }
            if (!d.getTuilePosee() && !gameState.currentTilePlaced) { alert('Vous devez poser la tuile avant de terminer votre tour !'); return; }

            if (gameSync && !d.getIsHost()) {
                d.hideAllCursors();
                const _pendingAbbe = d.getPendingAbbePoints() ? { ...d.getPendingAbbePoints() } : null;
                d.setPendingAbbePoints(null);
                const hostConn = gameSync.multiplayer.connections[0];
                if (hostConn?.open) {
                    hostConn.send({
                        type: 'turn-end-request',
                        playerId: d.getMultiplayer().playerId,
                        isBonusTurn: d.getTurnManager()?.isBonusTurn ?? false,
                        pendingAbbePoints: _pendingAbbe
                    });
                }
                return;
            }

            console.log('⏭️ Fin de tour - calcul des scores et passage au joueur suivant');
            gameState.currentTilePlaced = false;

            if (gameConfig.tileGroups?.dragon && gameConfig.extensions?.dragon && d.getDragonRules() && gameState._pendingVolcanoPos) {
                const { x: vx, y: vy } = gameState._pendingVolcanoPos;
                d.getDragonRules().onVolcanoPlaced(vx, vy);
                gameState._pendingVolcanoPos = null;
                d.broadcastDragonState();
            }

            let builderBonusTriggered = false;
            if (gameConfig.extensions?.tradersBuilders && d.getLastPlacedTile()) {
                const builderRulesInst = d.getRuleRegistry().rules?.get('builders');
                if (builderRulesInst) builderBonusTriggered = builderRulesInst.checkBonusTrigger(d.getMultiplayer().playerId);
            }

            if (d.getPendingAbbePoints()) {
                const player = gameState.players.find(p => p.id === d.getPendingAbbePoints().playerId);
                if (player) {
                    player.score += d.getPendingAbbePoints().points;
                    player.scoreDetail = player.scoreDetail || {};
                    player.scoreDetail.monasteries = (player.scoreDetail.monasteries || 0) + d.getPendingAbbePoints().points;
                }
                d.setPendingAbbePoints(null);
            }

            const scoring   = d.getScoring();
            const zoneMerger = d.getZoneMerger();
            if (scoring && zoneMerger) {
                const newlyClosed = d.getTilePlacement()?.newlyClosedZones ?? null;
                const { scoringResults, meeplesToReturn, goodsResults } = scoring.scoreClosedZones(d.getPlacedMeeples(), d.getMultiplayer().playerId, gameState, newlyClosed);
                const fairyMeepleKeySnapshot = gameState.fairyState?.meepleKey ?? null;
                const fairyOwnerIdSnapshot   = gameState.fairyState?.ownerId   ?? null;

                if (scoringResults.length > 0 || goodsResults.length > 0) {
                    const eventBus      = d.getEventBus();
                    const placedMeeples = d.getPlacedMeeples();
                    scoringResults.forEach(({ playerId, points, zoneType }) => {
                        const player = gameState.players.find(p => p.id === playerId);
                        if (player) {
                            player.score += points;
                            if (zoneType === 'city')                               player.scoreDetail.cities      += points;
                            else if (zoneType === 'road')                          player.scoreDetail.roads       += points;
                            else if (zoneType === 'abbey' || zoneType === 'garden') player.scoreDetail.monasteries += points;
                        }
                    });
                    meeplesToReturn.forEach(key => {
                        const meeple = placedMeeples[key];
                        if (meeple) {
                            if (meeple.type === 'Abbot') {
                                const p = gameState.players.find(pl => pl.id === meeple.playerId);
                                if (p) { p.hasAbbot = true; eventBus.emit('meeple-count-updated', { playerId: meeple.playerId }); }
                            } else if (meeple.type === 'Large' || meeple.type === 'Large-Farmer') {
                                const p = gameState.players.find(pl => pl.id === meeple.playerId);
                                if (p) { p.hasLargeMeeple = true; eventBus.emit('meeple-count-updated', { playerId: meeple.playerId }); }
                            } else if (meeple.type === 'Builder') {
                                const p = gameState.players.find(pl => pl.id === meeple.playerId);
                                if (p) { p.hasBuilder = true; eventBus.emit('meeple-count-updated', { playerId: meeple.playerId }); }
                            } else {
                                d.incrementPlayerMeeples(meeple.playerId);
                            }
                            document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
                            delete placedMeeples[key];
                            d.releaseFairyIfDetached(key);
                        }
                    });
                    if (gameSync) gameSync.syncScoreUpdate(scoringResults, meeplesToReturn, goodsResults, zoneMerger);
                    d.updateTurnDisplay();
                    if (gameConfig.extensions?.fairyProtection && fairyMeepleKeySnapshot && !gameState.fairyState?.meepleKey)
                        d.getEventBus().emit('fairy-detached-show-targets');
                    if (gameConfig.extensions?.fairyScoreZone && fairyMeepleKeySnapshot && meeplesToReturn.includes(fairyMeepleKeySnapshot)) {
                        const fp = gameState.players.find(p => p.id === fairyOwnerIdSnapshot);
                        if (fp) {
                            fp.score += 3; fp.scoreDetail = fp.scoreDetail || {};
                            fp.scoreDetail.fairy = (fp.scoreDetail.fairy || 0) + 3;
                            console.log(`🧚 [Fée] +3 points fermeture de zone pour ${fp.name}`);
                            if (gameSync) gameSync.syncScoreUpdate([{ playerId: fairyOwnerIdSnapshot, points: 3, zoneType: 'fairy' }], [], [], zoneMerger);
                            d.getEventBus().emit('score-updated');
                        }
                    }
                }
            }

            d.hideAllCursors();
            document.querySelectorAll('.meeple-cursors-container').forEach(c => c.remove());
            gameState._pendingPrincessTile = null;
            gameState._pendingPortalTile   = null;
            gameState._pendingTowerCapture = null; // ✨ NOUVEAU
            d.clearTowerCursors?.();               // ✨ NOUVEAU
            if (d.getUndoManager()) d.getUndoManager().reset();

            if (gameConfig.tileGroups?.dragon && gameConfig.extensions?.dragon && d.getDragonRules() && gameState._pendingDragonTile) {
                const { playerIndex } = gameState._pendingDragonTile;
                gameState._pendingDragonTile = null;
                const started = d.getDragonRules().onDragonTilePlaced(playerIndex);
                if (started) {
                    // Sauvegarder le bonus bâtisseur — sera consommé dans onDragonPhaseEnded
                    if (builderBonusTriggered) gameState._pendingBuilderBonus = true;
                    d.broadcastDragonState();
                    d.startDragonTurnUI();
                    return;
                }
            }

            if (d.getDeck().remaining() <= 0) {
                if (gameSync) gameSync.syncTurnEnd();
                d.getFinalScoresManager().computeAndApply(d.getPlacedMeeples());
                return;
            }

            if (d.getTurnManager()) {
                const result = d.getTurnManager().endTurn(builderBonusTriggered);
                if (result?.bonusTurnStarted) {
                    if (d.getIsHost()) {
                        const _bonusTile = d.hostDrawAndSend();
                        if (_bonusTile) d.getTurnManager().receiveYourTurn(_bonusTile.id);
                        if (gameSync) gameSync.syncTurnEnd(true, _bonusTile?.id ?? null);
                    } else {
                        if (gameSync) gameSync.syncTurnEndRequest(true);
                    }
                    d.getRuleRegistry().rules?.get('builders')?.resetLastPlacedTile?.();
                    d.updateTurnDisplay();
                    d.afficherToast('⭐ Tour bonus ! Votre bâtisseur vous offre un tour supplémentaire.', 'bonus');
                    const _bonusToast = document.getElementById('disconnect-toast');
                    if (_bonusToast) _bonusToast.dataset.isBonusToast = 'true';
                    return;
                }
            }

            if (gameSync) {
                if (d.getIsHost()) {
                    const _nextTile = d.hostDrawAndSend();
                    if (_nextTile) d.getTurnManager().receiveYourTurn(_nextTile.id);
                    gameSync.syncTurnEnd(false, _nextTile?.id ?? null);
                } else {
                    gameSync.syncTurnEndRequest(false);
                }
            }
            d.updateTurnDisplay();
        };
    }

    // ── Navigation (recentrer, highlight) ────────────────────────────────────

    _installNavigation(d) {
        document.getElementById('recenter-btn').onclick = () => {
            const container   = document.getElementById('board-container');
            const boardCenter = 10400;
            const tileCenter  = 10296;
            const level       = d.getNavigationManager()?.zoomLevel ?? 1;
            container.scrollLeft = boardCenter + (tileCenter - boardCenter) * level - container.clientWidth  / 2;
            container.scrollTop  = boardCenter + (tileCenter - boardCenter) * level - container.clientHeight / 2;
        };

        document.getElementById('highlight-tile-btn').onclick = () => {
            const lastPlacedTile = d.getLastPlacedTile();
            if (!lastPlacedTile) return;
            const { x, y } = lastPlacedTile;
            const container  = document.getElementById('board-container');
            const CELL       = 208;
            const level      = d.getNavigationManager()?.zoomLevel ?? 1;
            const boardCenter = 10400;
            const tileCX     = (x - 1) * CELL + CELL / 2;
            const tileCY     = (y - 1) * CELL + CELL / 2;
            container.scrollLeft = boardCenter + (tileCX - boardCenter) * level - container.clientWidth  / 2;
            container.scrollTop  = boardCenter + (tileCY - boardCenter) * level - container.clientHeight / 2;
            const el = document.querySelector(`.tile[data-pos="${x},${y}"]`);
            if (!el) return;
            el.classList.add('tile-highlight');
            setTimeout(() => el.classList.remove('tile-highlight'), 3000);
        };
    }

    // ── Menu ──────────────────────────────────────────────────────────────────

    _installMenu(d) {
        document.addEventListener('click', (e) => {
            const popover = document.getElementById('game-menu-popover');
            const menuBtn = document.getElementById('menu-btn');
            if (popover && popover.style.display !== 'none' && !popover.contains(e.target) && e.target !== menuBtn)
                popover.style.display = 'none';
        });

        document.getElementById('menu-copy-code-btn').addEventListener('click', () => {
            if (!d.getGameCode()) return;
            navigator.clipboard.writeText(d.getGameCode()).then(() => {
                const btn = document.getElementById('menu-copy-code-btn');
                btn.textContent = '✅ Copié !';
                setTimeout(() => { btn.textContent = '📋 Copier'; }, 2000);
            });
        });

        document.getElementById('back-to-lobby-btn').onclick = () => {
            this._closeMenu();
            if (confirm('Retourner au lobby ? (La partie sera terminée mais les joueurs resteront connectés)'))
                d.returnToLobby();
        };

        const _menuLeaveBtn = document.getElementById('menu-leave-btn');
        if (_menuLeaveBtn) _menuLeaveBtn.onclick = () => {
            this._closeMenu();
            if (confirm('Voulez-vous vraiment quitter la partie ?')) {
                d.getMultiplayer().onHostDisconnected = null;
                d.getMultiplayer().onPlayerLeft       = null;
                d.stopAutoReconnect();
                d.hideReconnectOverlay();
                const hostId = d.getPlayers().find(p => p.isHost)?.id;
                if (hostId) d.getMultiplayer().sendTo(hostId, { type: 'leave-game' });
                d.returnToInitialLobby();
            }
        };

        document.getElementById('menu-remaining-btn').addEventListener('click', () => {
            this._closeMenu();
            const deck = d.getDeck();
            if (!deck) { alert('Aucune partie en cours'); return; }
            d.getModalUI().showRemainingTiles(deck.getRemainingTilesByType(), deck.remaining());
        });

        document.getElementById('menu-rules-btn').addEventListener('click', () => {
            this._closeMenu();
            const gameConfig = d.getGameConfig();
            if (!gameConfig) { alert('Aucune partie en cours'); return; }
            d.getModalUI().showGameRules(gameConfig);
        });

        document.getElementById('close-final-scores-btn').onclick = () => {
            document.getElementById('final-scores-modal').style.display = 'none';
        };

        document.getElementById('test-modal-btn').onclick = () => {
            d.getFinalScoresManager()?.showDebugModal();
        };
    }

    // ── Undo ──────────────────────────────────────────────────────────────────

    _installUndo(d) {
        document.getElementById('undo-btn').addEventListener('click', () => {
            const gameState     = d.getGameState();
            const gameConfig    = d.getGameConfig();
            const undoManager   = d.getUndoManager();
            const isDragonPhase = !!(gameConfig?.extensions?.dragon && gameState?.dragonPhase?.active);
            const dragonMover   = isDragonPhase ? gameState.players[gameState.dragonPhase.moverIndex] : null;
            const isMyDragonUndo = isDragonPhase && dragonMover?.id === d.getMultiplayer().playerId && !!undoManager?.dragonMovePlacedThisTurn;

            if (!d.getIsMyTurn() && !isMyDragonUndo) return;

            if (!d.getIsHost()) {
                const gameSync = d.getGameSync();
                if (gameSync) gameSync.syncUndoRequest();
                return;
            }
            if (!undoManager || !undoManager.canUndo()) { alert('Rien à annuler'); return; }

            const undoneAction = undoManager.undo(d.getPlacedMeeples());
            if (!undoneAction) return;

            if (undoneAction.type === 'meeple' && undoManager.afterTilePlacedSnapshot?.pendingPortalTile !== undefined)
                gameState._pendingPortalTile = undoManager.afterTilePlacedSnapshot.pendingPortalTile;

            const placedMeeples = d.getPlacedMeeples();
            const zoneMerger    = d.getZoneMerger();
            undoneAction.postUndoState = {
                placedTileKeys: Object.keys(d.getPlateau().placedTiles),
                zones:          zoneMerger.registry.serialize(),
                tileToZone:     Array.from(zoneMerger.tileToZone.entries()),
                placedMeeples:  JSON.parse(JSON.stringify(placedMeeples)),
                playerMeeples:  gameState.players.map(p => ({ id: p.id, meeples: p.meeples, hasAbbot: p.hasAbbot, hasLargeMeeple: p.hasLargeMeeple, hasBuilder: p.hasBuilder, hasPig: p.hasPig })),
                fairyState:     JSON.parse(JSON.stringify(gameState.fairyState ?? { ownerId: null, meepleKey: null })),
                dragonPos:      JSON.parse(JSON.stringify(gameState.dragonPos ?? null)),
                dragonPhase:    JSON.parse(JSON.stringify(gameState.dragonPhase ?? {})),
                pendingPortalTile: gameState._pendingPortalTile ? JSON.parse(JSON.stringify(gameState._pendingPortalTile)) : null
            };

            undoManager.applyLocally(undoneAction);
            const gameSync = d.getGameSync();
            if (gameSync) gameSync.syncUndo(undoneAction);
            gameState.players.forEach(p => d.getEventBus().emit('meeple-count-updated', { playerId: p.id }));
            d.getEventBus().emit('score-updated');
            d.updateTurnDisplay();
            d.updateMobileTilePreview();
            d.getScorePanelUI()?.updateMobile();
            d.updateMobileButtons();
        });
    }

    // ── Modales ───────────────────────────────────────────────────────────────

    _installModals(d) {
        document.getElementById('unplaceable-confirm-btn').onclick = () => {
            const tuileEnMain        = d.getTuileEnMain();
            const unplaceableManager = d.getUnplaceableManager();
            const gameSync           = d.getGameSync();
            const tilePreviewUI      = d.getTilePreviewUI();
            if (!unplaceableManager || !tuileEnMain) return;

            if (d.getIsHost()) {
                const result = unplaceableManager.handleConfirm(tuileEnMain, gameSync);
                if (tilePreviewUI) tilePreviewUI.showBackside();
                if (!result) {
                    d.setWaitingToRedraw(true);
                    d.updateTurnDisplay();
                    return;
                }
                if (!result.special) {
                    unplaceableManager.showTileDestroyedModal(result.tileId, result.playerName, true, result.action, result.isRiver);
                    gameSync.syncTileDestroyed(result.tileId, result.playerName, result.action, 1, d.getMultiplayer().playerId);
                }
                d.setWaitingToRedraw(true);
                d.updateTurnDisplay();
            } else {
                const _tileId = tuileEnMain.id;
                unplaceableManager.hideUnplaceableBadge();
                if (tilePreviewUI) tilePreviewUI.showBackside();
                d.setTuileEnMain(null);
                d.setWaitingToRedraw(true);
                d.updateTurnDisplay();
                if (gameSync) gameSync.syncUnplaceableConfirm(_tileId);
            }
        };

        document.getElementById('unplaceable-examine-btn').onclick = () => {
            document.getElementById('unplaceable-modal').style.display = 'none';
        };

        document.getElementById('tile-destroyed-ok-btn').onclick = () => {
            document.getElementById('tile-destroyed-modal').style.display = 'none';
            d.updateTurnDisplay();
        };
    }

    // ── Boutons mobile ────────────────────────────────────────────────────────

    _installMobile(d) {
        document.getElementById('mobile-tile-preview').addEventListener('touchend', (e) => {
            e.preventDefault();
            if (!d.getIsMyTurn()) return;
            const tuileEnMain = d.getTuileEnMain();
            if (!tuileEnMain || d.getTuilePosee()) return;
            const nextRot  = (tuileEnMain.rotation + 90) % 360;
            const gameSync = d.getGameSync();
            if (gameSync && !d.getIsHost()) {
                gameSync.syncTileRotation(nextRot);
            } else {
                d.setTuileEnMainRotation(nextRot);
                d.updateMobileTilePreview();
                d.getEventBus().emit('tile-rotated', { rotation: nextRot });
                if (gameSync) gameSync.syncTileRotation(nextRot);
            }
        }, { passive: false });

        const mobileBtn = (id, fn) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('touchstart', () => {}, { passive: true });
            el.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                fn();
                el.blur();
            }, { passive: false });
        };

        mobileBtn('mobile-end-turn-btn',  () => { const btn = document.getElementById('end-turn-btn');  if (btn?.onclick) btn.onclick(); });
        mobileBtn('mobile-undo-btn',       () => { document.getElementById('undo-btn').dispatchEvent(new MouseEvent('click')); });
        mobileBtn('mobile-recenter-btn',   () => { document.getElementById('recenter-btn').click(); });
        mobileBtn('mobile-highlight-btn',  () => { document.getElementById('highlight-tile-btn').click(); });
    }

    // ── Bouton menu mobile ────────────────────────────────────────────────────

    _installMobileMenu(d) {
        const el = document.getElementById('mobile-menu-btn');
        if (!el) return;
        el.addEventListener('touchstart', () => {}, { passive: true });
        el.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            d.openCloseMenu(el);
        }, { passive: false });
    }
}
