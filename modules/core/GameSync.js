/**
 * Gère la synchronisation du jeu en multijoueur
 */
export class GameSync {
    constructor(multiplayer, gameState, originalHandler = null) {
        this.multiplayer = multiplayer;
        this.gameState = gameState;
        this.isHost = multiplayer.isHost;
        this.originalHandler = originalHandler; // Handler du lobby à préserver
        this.eventBus = null; // Assigné depuis home.js après construction
        
        // Callbacks pour les actions de jeu
        this.onDeckReceived = null;
        this.onTileRotated = null;
        this.onTilePlaced = null;
        this.onTilePlacedRequest = null;
        this.onTurnEnded        = null;
        this.onGameStarted = null;
        this.onTileDrawn = null;
        this.onMeeplePlaced = null;
        this.onMeeplePlacedRequest = null;
        this.onScoreUpdate = null;
        this.onTurnUndo = null;
        this.onGameEnded = null;
        this.onPlayerDisconnected = null;
        this.onTileDestroyed = null;
        this.onUnplaceableConfirm = null;
        this.onUnplaceableHandled = null;
        this.onUnplaceableRedraw  = null;
        this.onYourTurn           = null;
        this.onDeckReshuffled = null;
        // ✨ NOUVEAU — Extension Tour
        this.onTowerFloorPlaced     = null;
        this.onTowerCaptureExecuted = null;
    }

    /**
     * Initialiser les listeners pour les messages réseau
     */
    init() {
        // Utiliser le handler original sauvegardé, sinon l'actuel
        const previousHandler = this.originalHandler || this.multiplayer.onDataReceived;
        
        this.multiplayer.onDataReceived = (data, from) => {
            // D'abord essayer de gérer comme message de jeu
            if (this._isGameMessage(data.type)) {
                this._handleGameMessage(data, from);
            } else if (previousHandler) {
                // Sinon appeler l'ancien handler (pour game-starting, etc.)
                previousHandler(data, from);
            }
        };
    }
    
    /**
     * Vérifier si un message est un message de jeu (géré par GameSync)
     */
    _isGameMessage(type) {
        const gameMessages = [
            'game-start', 'tile-rotated', 'tile-placed', 'turn-ended',
            'tile-drawn', 'meeple-placed', 'meeple-count-update', 'score-update',
            'turn-undo', 'game-ended', 'tile-destroyed', 'deck-reshuffled', 'player-disconnected',
            'game-paused', 'game-resumed', 'full-state-sync', 'rejoin-accepted', 'rejoin-rejected',
            'abbe-recalled', 'abbe-recalled-undo',
            'turn-end-request', 'unplaceable-confirm', 'unplaceable-redraw', 'unplaceable-handled',
            'turn-undo-request', 'your-turn', 'tile-placed-request', 'meeple-placed-request',
            'dragon-state-update', 'dragon-move-request', 'fairy-placed-sync',
            'dragon-premature-tile', 'dragon-end-turn-request', 'princess-ejected', 'princess-eject-request',
            'portal-meeple-placed', 'portal-meeple-request',
            'tower-floor-placed', 'tower-capture-executed' // ✨ NOUVEAU
            // NOTE: 'return-to-lobby', 'player-order-update' et 'game-starting' 
            //       sont gérés par le lobby handler
        ];
        return gameMessages.includes(type);
    }

    /**
     * [HÔTE] Démarrer la partie et envoyer la pioche à tous
     */
    startGame(deck) {
        if (!this.isHost) return;

        const deckData = {
            tiles: deck.tiles,
            currentIndex: deck.currentIndex,
            totalTiles: deck.totalTiles
        };

        console.log('🎮 [HÔTE] Envoi de la pioche aux joueurs...');
        
        this.multiplayer.broadcast({
            type: 'game-start',
            deck: deckData,
            gameState: this.gameState.serialize()
        });
    }

    /**
     * Synchroniser la rotation d'une tuile
     */
    syncTileRotation(rotation) {
        console.log('🔄 Sync rotation:', rotation);
        this.multiplayer.broadcast({
            type: 'tile-rotated',
            rotation: rotation,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Invité → hôte : demande de placement de tuile (étape 2 architecture réactive)
     */
    syncTilePlacementRequest(x, y, tile) {
        console.log('📍 [INVITÉ] Demande placement:', x, y, tile.id, tile.rotation);
        const hostConn = this.multiplayer.connections[0];
        if (hostConn && hostConn.open) {
            hostConn.send({
                type: 'tile-placed-request',
                x, y,
                tileId: tile.id,
                rotation: tile.rotation,
                playerId: this.multiplayer.playerId
            });
        }
    }

    /**
     * Synchroniser le placement d'une tuile (hôte → tous)
     */
    syncTilePlacement(x, y, tile, zoneMerger) {
        console.log('📍 Sync placement:', x, y, tile.id, tile.rotation);
        this.multiplayer.broadcast({
            type: 'tile-placed',
            x: x,
            y: y,
            tileId: tile.id,
            rotation: tile.rotation,
            playerId: this.multiplayer.playerId,
            zoneRegistry: zoneMerger ? zoneMerger.registry.serialize() : null,
            tileToZone:   zoneMerger ? Array.from(zoneMerger.tileToZone.entries()) : null
        });
    }

    /**
     * Synchroniser la fin du tour
     */
    syncTurnEnd(isBonusTurn = false, nextTileId = null) {
        console.log('⏭️ Sync fin de tour — isBonusTurn:', isBonusTurn, 'nextTileId:', nextTileId);

        this.multiplayer.broadcast({
            type: 'turn-ended',
            playerId: this.multiplayer.playerId,
            nextPlayerIndex: this.gameState.currentPlayerIndex,
            gameState: this.gameState.serialize(),
            isBonusTurn: isBonusTurn,
            nextTileId: nextTileId
        });

        return true;
    }

    /**
     * Invité → hôte : demande de fin de tour
     */
    syncTurnEndRequest(isBonusTurn = false) {
        console.log('⏭️ [INVITÉ] Demande fin de tour — isBonusTurn:', isBonusTurn);
        const hostConn = this.multiplayer.connections[0];
        if (hostConn && hostConn.open) {
            hostConn.send({
                type: 'turn-end-request',
                playerId: this.multiplayer.playerId,
                nextPlayerIndex: this.gameState.currentPlayerIndex,
                gameState: this.gameState.serialize(),
                isBonusTurn: isBonusTurn
            });
        }
    }

    /**
     * Invité → hôte : confirme une tuile implaçable
     */
    syncUnplaceableConfirm(tileId) {
        console.log('🚫 [INVITÉ] Tuile implaçable confirmée:', tileId);
        const hostConn = this.multiplayer.connections[0];
        if (hostConn && hostConn.open) {
            hostConn.send({
                type: 'unplaceable-confirm',
                playerId: this.multiplayer.playerId,
                tileId: tileId
            });
        }
    }

    /**
     * Invité → hôte : demande de repiocher après tuile implaçable
     */
    syncUnplaceableRedraw() {
        console.log('🔄 [INVITÉ] Demande repiocher après implaçable');
        const hostConn = this.multiplayer.connections[0];
        if (hostConn && hostConn.open) {
            hostConn.send({
                type: 'unplaceable-redraw',
                playerId: this.multiplayer.playerId
            });
        }
    }

    /**
     * Hôte → tous : une tuile implaçable a été traitée
     * activePeerId = l'invité dont c'était le tour (reçoit en plus un your-turn séparé)
     */
    syncUnplaceableHandled(tileId, playerName, action, isRiver, activePeerId) {
        console.log('🚫 [HÔTE] Broadcast unplaceable-handled:', tileId);
        this.multiplayer.broadcast({
            type: 'unplaceable-handled',
            tileId,
            playerName,
            action,
            isRiver: isRiver ?? false,
            activePeerId,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Synchroniser la pioche d'une nouvelle tuile
     */
    syncTileDraw(tileId, rotation) {
        console.log('🎲 Sync pioche tuile:', tileId);
        this.multiplayer.broadcast({
            type: 'tile-drawn',
            tileId: tileId,
            rotation: rotation,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Invité → hôte : demande de placement meeple (étape 3 architecture réactive)
     */
    syncMeeplePlacementRequest(x, y, position, meepleType) {
        console.log('🎭 [INVITÉ] Demande placement meeple:', x, y, position, meepleType);
        const hostConn = this.multiplayer.connections[0];
        if (hostConn && hostConn.open) {
            hostConn.send({
                type: 'meeple-placed-request',
                x, y, position, meepleType,
                playerId: this.multiplayer.playerId
            });
        }
    }

    /**
     * Synchroniser le placement d'un meeple (hôte → tous)
     */
    syncMeeplePlacement(x, y, position, meepleType, color) {
        console.log('🎭 Sync placement meeple:', x, y, position, meepleType);
        this.multiplayer.broadcast({
            type: 'meeple-placed',
            x: x,
            y: y,
            position: position,
            meepleType: meepleType,
            color: color,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Synchroniser la mise à jour des scores
     */
    syncScoreUpdate(scoringResults, meeplesToReturn, goodsResults = [], zoneMerger = null) {
        console.log('💰 Sync score update:', scoringResults);
        this.multiplayer.broadcast({
            type: 'score-update',
            scoringResults:  scoringResults,
            meeplesToReturn: meeplesToReturn,
            goodsResults:    goodsResults,
            // Registry post-scoring : goods déjà vidés, état cohérent pour l'invité
            zoneRegistry: zoneMerger ? zoneMerger.registry.serialize() : null,
            tileToZone:   zoneMerger ? Array.from(zoneMerger.tileToZone.entries()) : null,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Synchroniser une annulation
     */
    syncAbbeRecall(x, y, key, playerId, points) {
        this.multiplayer.broadcast({
            type: 'abbe-recalled',
            x, y, key, playerId, points
        });
    }

    syncAbbeRecallUndo(x, y, key, playerId) {
        this.multiplayer.broadcast({
            type: 'abbe-recalled-undo',
            x, y, key, playerId
        });
    }

    syncUndo(undoneAction) {
        console.log('⏪ Sync annulation:', undoneAction);
        this.multiplayer.broadcast({
            type: 'turn-undo',
            action: undoneAction,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Invité → hôte : demande d'annulation
     */
    syncUndoRequest() {
        console.log('⏪ [INVITÉ] Demande annulation');
        const hostConn = this.multiplayer.connections[0];
        if (hostConn && hostConn.open) {
            hostConn.send({
                type: 'turn-undo-request',
                playerId: this.multiplayer.playerId
            });
        }
    }

    /**
     * Synchroniser la destruction d'une tuile
     */
    syncTileDestroyed(tileId, playerName, action, count = 1) {
        console.log('🗑️ Sync tile destroyed:', tileId);
        this.multiplayer.broadcast({
            type: 'tile-destroyed',
            tileId: tileId,
            playerName: playerName,
            action: action,
            count: count,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Synchroniser le remélange du deck
     */
    syncDeckReshuffle(tiles, currentIndex) {
        console.log('🔀 Sync deck reshuffle, currentIndex:', currentIndex);
        this.multiplayer.broadcast({
            type: 'deck-reshuffled',
            tiles: tiles,
            currentIndex: currentIndex,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Synchroniser la fin de partie
     */
    syncPlayerDisconnected(peerId, playerName, nextPlayerIndex) {
        console.log('👋 Sync player disconnected:', playerName);
        this.multiplayer.broadcast({
            type: 'player-disconnected',
            peerId,
            playerName,
            nextPlayerIndex,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Broadcaster la pause de partie (joueur déconnecté)
     */
    syncGamePaused(disconnectedName, timeoutMs) {
        this.multiplayer.broadcast({
            type: 'game-paused',
            disconnectedName,
            timeoutMs,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Broadcaster la reprise de partie
     */
    syncGameResumed(reason) {
        this.multiplayer.broadcast({
            type: 'game-resumed',
            reason, // 'reconnected' | 'timeout'
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * Envoyer l'état complet à un nouveau joueur/reconnexion (hôte → invité ciblé)
     */
    syncFullState(targetPeerId, { gameState, deck, plateau, zoneRegistry, tileToZone, placedMeeples, tuileEnMain, tuilePosee, gameConfig, timerElapsed }) {
        this.multiplayer.sendTo(targetPeerId, {
            type: 'full-state-sync',
            gameState:    gameState.serialize(),
            deck:         { tiles: deck.tiles, currentIndex: deck.currentIndex, totalTiles: deck.totalTiles },
            plateau:      plateau.placedTiles,
            zoneRegistry: zoneRegistry.serialize(),
            tileToZone:   Array.from(tileToZone.entries()),
            placedMeeples,
            tuileEnMain:  tuileEnMain ? { id: tuileEnMain.id, rotation: tuileEnMain.rotation } : null,
            tuilePosee:   tuilePosee ?? false,
            gameConfig,
            timerElapsed: timerElapsed ?? 0
        });
    }

    syncGameEnded(detailedScores, destroyedTilesCount = 0) {
        console.log('🏁 Sync game ended:', detailedScores);
        this.multiplayer.broadcast({
            type: 'game-ended',
            scores: detailedScores,
            destroyedTilesCount: destroyedTilesCount,
            playerId: this.multiplayer.playerId
        });
    }

    /**
     * ✨ NOUVEAU — Extension Tour : hôte → tous, pose d'étage appliquée
     */
    syncTowerFloorPlaced(x, y, height, playerId, towerPieces) {
        this.multiplayer.broadcast({
            type: 'tower-floor-placed',
            x, y, height, playerId, towerPieces
        });
    }

    /**
     * ✨ NOUVEAU — Extension Tour : hôte → tous, capture exécutée
     */
    syncTowerCaptureExecuted(meepleKey, playerId, selfCapture) {
        this.multiplayer.broadcast({
            type: 'tower-capture-executed',
            meepleKey, playerId, selfCapture
        });
    }

    /**
     * Gérer les messages reçus
     * @private
     */
    _handleGameMessage(data, from) {
        console.log('📨 [SYNC] Message reçu:', data.type);

        // ✅ RELAIS HÔTE : si on est l'hôte et que le message vient d'un invité,
        // le re-broadcaster aux autres joueurs (topologie étoile, invités non connectés entre eux)
        const relayTypes = [
            'tile-drawn',
            'meeple-count-update', 'score-update',
            'tile-destroyed', 'deck-reshuffled', 'abbe-recalled', 'abbe-recalled-undo',
            'game-ended'
        ];
        if (this.isHost && from && from !== this.multiplayer.playerId && relayTypes.includes(data.type)) {
            console.log(`🔀 [HÔTE] Relais message ${data.type} de ${from} vers les autres`);
            this.multiplayer.broadcastExcept(data, from);
        }
        // tile-rotated : relayé à TOUS y compris l'émetteur (invité purement réactif)
        if (this.isHost && from && from !== this.multiplayer.playerId && data.type === 'tile-rotated') {
            console.log(`🔀 [HÔTE] Relais tile-rotated de ${from} vers tous`);
            this.multiplayer.broadcast(data);
        }
        // tile-placed-request : l'hôte valide et broadcast tile-placed à tous
        if (this.isHost && data.type === 'tile-placed-request' && this.onTilePlacedRequest) {
            this.onTilePlacedRequest(data.x, data.y, data.tileId, data.rotation, data.playerId);
        }
        // meeple-placed-request : l'hôte valide et broadcast meeple-placed à tous
        if (this.isHost && data.type === 'meeple-placed-request' && this.onMeeplePlacedRequest) {
            this.onMeeplePlacedRequest(data.x, data.y, data.position, data.meepleType, data.playerId);
        }

        switch (data.type) {
            case 'game-start':
                if (!this.isHost && this.onGameStarted) {
                    console.log('🎮 [INVITÉ] Réception de la pioche');
                    this.onGameStarted(data.deck, data.gameState);
                }
                break;

            case 'tile-rotated':
                // Hôte : applique si c'est un invité qui a tourné
                // Invité émetteur : applique aussi (l'hôte relaie à tous y compris lui)
                // Invité spectateur : applique si c'est quelqu'un d'autre
                if (this.onTileRotated) {
                    const isEcho = this.isHost && data.playerId === this.multiplayer.playerId;
                    if (!isEcho) {
                        console.log('🔄 [SYNC] Rotation reçue:', data.rotation);
                        this.onTileRotated(data.rotation);
                    }
                }
                break;

            case 'tile-placed':
                // ✅ Étape 2 : invité réactif — applique à la réception du broadcast hôte (y compris echo)
                if (this.onTilePlaced && !this.isHost) {
                    console.log('📍 [SYNC] Placement reçu:', data.x, data.y, data.tileId);
                    this.onTilePlaced(data.x, data.y, data.tileId, data.rotation, data.zoneRegistry, data.tileToZone);
                }
                // Hôte : applique si c'est un autre joueur (cas multi-invités futur)
                if (this.onTilePlaced && this.isHost && data.playerId !== this.multiplayer.playerId) {
                    console.log('📍 [HÔTE] Placement invité reçu:', data.x, data.y, data.tileId);
                    this.onTilePlaced(data.x, data.y, data.tileId, data.rotation, data.zoneRegistry, data.tileToZone);
                }
                break;

            case 'turn-ended':
                if (this.onTurnEnded && data.playerId !== this.multiplayer.playerId) {
                    console.log('⏭️ [SYNC] Fin de tour reçue — nextTileId:', data.nextTileId);
                    this.onTurnEnded(data.nextPlayerIndex, data.gameState, data.isBonusTurn ?? false, data.nextTileId ?? null);
                }
                break;

            case 'turn-end-request':
                // Un invité demande à l'hôte de clore son tour
                if (this.isHost && this.onTurnEndRequest) {
                    console.log('⏭️ [HÔTE] Demande fin de tour reçue de:', data.playerId);
                    this.onTurnEndRequest(data.playerId, data.nextPlayerIndex, data.gameState, data.isBonusTurn ?? false, data.pendingAbbePoints ?? null);
                }
                break;

            case 'unplaceable-confirm':
                // Un invité confirme sa tuile implaçable → l'hôte gère tout
                if (this.isHost && this.onUnplaceableConfirm) {
                    console.log('🚫 [HÔTE] Tuile implaçable confirmée par:', data.playerId);
                    this.onUnplaceableConfirm(data.playerId, data.tileId);
                }
                break;

            case 'unplaceable-handled':
                // L'hôte a traité une tuile implaçable — mettre à jour l'affichage
                if (data.playerId !== this.multiplayer.playerId && this.onUnplaceableHandled) {
                    console.log('🚫 [SYNC] Tuile implaçable traitée reçue:', data.tileId);
                    this.onUnplaceableHandled(data.tileId, data.playerName, data.action, data.isRiver, data.activePeerId);
                }
                break;

            case 'unplaceable-redraw':
                // L'invité demande à repiocher après tuile implaçable
                if (this.isHost && this.onUnplaceableRedraw) {
                    console.log('🔄 [HÔTE] Demande repiocher reçue de:', data.playerId);
                    this.onUnplaceableRedraw(data.playerId);
                }
                break;

            case 'your-turn':
                // L'hôte donne une tuile directement à cet invité
                if (!this.isHost && this.onYourTurn) {
                    console.log('🎲 [INVITÉ] Réception your-turn:', data.tileId);
                    this.onYourTurn(data.tileId);
                }
                break;

            case 'turn-undo-request':
                if (this.isHost && this.onUndoRequest) {
                    console.log('⏪ [HÔTE] Demande annulation reçue de:', data.playerId);
                    this.onUndoRequest(data.playerId);
                }
                break;

            case 'tile-drawn':
                if (this.onTileDrawn && data.playerId !== this.multiplayer.playerId) {
                    console.log('🎲 [SYNC] Pioche tuile reçue:', data.tileId);
                    this.onTileDrawn(data.tileId, data.rotation, data.playerId);
                }
                break;

            case 'meeple-placed':
                // ✅ Étape 3 : invité réactif — applique à la réception (y compris echo)
                // Hôte applique si c'est quelqu'un d'autre
                if (this.onMeeplePlaced && (
                    (!this.isHost) ||
                    (this.isHost && data.playerId !== this.multiplayer.playerId)
                )) {
                    console.log('🎭 [SYNC] Meeple placé reçu:', data.x, data.y, data.position);
                    this.onMeeplePlaced(data.x, data.y, data.position, data.meepleType, data.color, data.playerId);
                }
                break;


            case 'meeple-count-update':
                if (this.onMeepleCountUpdate) {
                    console.log('🎭 [SYNC] Mise à jour compteur meeples:', data.playerId, data.meeples);
                    this.onMeepleCountUpdate(data.playerId, data.meeples, data.hasAbbot, data.hasLargeMeeple, data.hasBuilder, data.hasPig);
                }
                break;
            case 'score-update':
                if (this.onScoreUpdate && data.playerId !== this.multiplayer.playerId) {
                    console.log('💰 [SYNC] Mise à jour des scores reçue');
                    this.onScoreUpdate(data.scoringResults, data.meeplesToReturn, data.goodsResults ?? [], data.zoneRegistry ?? null, data.tileToZone ?? null);
                }
                break;
            
            case 'turn-undo':
                // Toujours appliquer, même si c'est notre propre undo (cas reconnexion :
                // l'invité a posé une tuile, s'est reconnecté, et demande un undo —
                // le broadcast revient à lui mais doit quand même mettre à jour le visuel)
                if (this.onTurnUndo) {
                    console.log('⏪ [SYNC] Annulation reçue:', data.action);
                    this.onTurnUndo(data.action);
                }
                break;
            
            case 'game-ended':
                if (this.onGameEnded && data.playerId !== this.multiplayer.playerId) {
                    console.log('🏁 [SYNC] Fin de partie reçue');
                    this.onGameEnded(data.scores, data.destroyedTilesCount ?? 0);
                }
                break;

            case 'dragon-state-update':
                // Relayé par l'hôte à tous les invités — les invités mettent à jour leur état dragon
                if (!this.isHost) {
                    this.eventBus?.emit('network-dragon-state-update', data);
                }
                break;

            case 'fairy-placed-sync':
                // Invité reçoit depuis l'hôte — ou hôte reçoit depuis un invité
                if (data.ownerId !== this.multiplayer.playerId) {
                    this.eventBus?.emit('network-fairy-placed', data);
                }
                break;

            case 'dragon-premature-tile':
                // Reçu par les invités : modale info "dragon sans volcan"
                console.log('🐉 [GAMESYNC] dragon-premature-tile — isHost:', this.isHost, '| eventBus:', !!this.eventBus);
                if (!this.isHost) {
                    this.eventBus?.emit('network-dragon-premature', data);
                }
                break;

            case 'princess-ejected':
                if (!this.isHost) {
                    this.eventBus?.emit('network-princess-ejected', data);
                }
                break;

            case 'portal-meeple-placed':
                // L'hôte a broadcasté un placement via portail — appliquer chez tous sauf l'émetteur
                if (data.playerId !== this.multiplayer.playerId) {
                    this.eventBus?.emit('network-portal-meeple-placed', data);
                }
                break;

            // ✨ NOUVEAU — Extension Tour
            case 'tower-floor-placed':
                if (this.onTowerFloorPlaced) this.onTowerFloorPlaced(data);
                break;

            case 'tower-capture-executed':
                if (this.onTowerCaptureExecuted) this.onTowerCaptureExecuted(data);
                break;
            
            case 'game-paused':
                if (this.onGamePaused && data.playerId !== this.multiplayer.playerId) {
                    this.onGamePaused(data.disconnectedName, data.timeoutMs);
                }
                break;

            case 'game-resumed':
                if (this.onGameResumed && data.playerId !== this.multiplayer.playerId) {
                    this.onGameResumed(data.reason);
                }
                break;

            case 'full-state-sync':
                if (this.onFullStateSync) {
                    this.onFullStateSync(data);
                }
                break;

            case 'rejoin-accepted':
                if (this.onRejoinAccepted) {
                    this.onRejoinAccepted(data);
                }
                break;

            case 'rejoin-rejected':
                if (this.onRejoinRejected) {
                    this.onRejoinRejected(data.reason);
                }
                break;

            case 'player-disconnected':
                if (this.onPlayerDisconnected && data.playerId !== this.multiplayer.playerId) {
                    console.log('👋 [SYNC] Joueur déconnecté reçu:', data.playerName);
                    this.onPlayerDisconnected(data.peerId, data.playerName, data.nextPlayerIndex);
                }
                break;

            case 'tile-destroyed':
                if (this.onTileDestroyed && data.playerId !== this.multiplayer.playerId) {
                    console.log('🗑️ [SYNC] Tuile détruite reçue:', data.tileId);
                    this.onTileDestroyed(data.tileId, data.playerName, data.action, data.count ?? 1, data.playerId);
                }
                break;
            
            case 'deck-reshuffled':
                if (this.onDeckReshuffled && data.playerId !== this.multiplayer.playerId) {
                    console.log('🔀 [SYNC] Deck remélangé reçu');
                    this.onDeckReshuffled(data.tiles, data.currentIndex);
                }
                break;

            case 'abbe-recalled':
                if (this.onAbbeRecalled && data.playerId !== this.multiplayer.playerId) {
                    console.log('↩️ [SYNC] Rappel Abbé reçu:', data.key);
                    this.onAbbeRecalled(data.x, data.y, data.key, data.playerId, data.points);
                }
                break;

            case 'abbe-recalled-undo':
                if (this.onAbbeRecalledUndo && data.playerId !== this.multiplayer.playerId) {
                    console.log('↩️ [SYNC] Undo rappel Abbé reçu');
                    this.onAbbeRecalledUndo(data.x, data.y, data.key, data.playerId);
                }
                break;
        }
    }
}
