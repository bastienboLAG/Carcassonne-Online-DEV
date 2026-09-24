/**
 * UndoManager - Gère l'annulation des actions pendant un tour
 * Permet d'annuler la pose de meeple, puis la pose de tuile
 */
export class UndoManager {
    constructor(eventBus, gameState, plateau, zoneMerger) {
        this.eventBus = eventBus;
        this.gameState = gameState;
        this.plateau = plateau;
        this.zoneMerger = zoneMerger;
        this.zoneRegistry = zoneMerger.registry;
        
        // Snapshots pour l'annulation
        this.turnStartSnapshot = null;    // État au début du tour
        this.afterTilePlacedSnapshot = null; // État après pose de tuile
        
        // État du tour
        this.tilePlacedThisTurn = false;
        this.meeplePlacedThisTurn = false;
        this.lastTilePlaced = null; // {x, y, tile}
        this.lastPlacedTileBeforeTurn = null; // {x, y} — pour restaurer l'épingle après annulation
        this.lastMeeplePlaced = null; // {x, y, position, key}

        // État abbé
        this.abbeRecalledThisTurn = false;
        this.lastAbbeRecalled = null; // {x, y, key, playerId, points}

        // État phase dragon
        this.dragonMoveSnapshot = null;
        this.dragonMovePlacedThisTurn = false;
    }

    /**
     * Sauvegarder l'état au début du tour
     */
    saveTurnStart(placedMeeples) {
        console.log('📸 Sauvegarde snapshot début de tour');

        // ✅ Nettoyage préventif : purger les zones qui référencent des tuiles absentes du plateau
        for (const [zoneId, zone] of this.zoneRegistry.zones) {
            const before = zone.tiles.length;
            zone.tiles = zone.tiles.filter(({ x, y }) =>
                this.plateau.placedTiles[`${x},${y}`] !== undefined
            );
            if (zone.tiles.length === 0 && before > 0) {
                this.zoneRegistry.zones.delete(zoneId);
                console.log(`    🧹 [saveTurnStart] Zone vide purgée: ${zoneId}`);
            } else if (zone.tiles.length !== before) {
                console.log(`    🧹 [saveTurnStart] Fantômes retirés de ${zoneId}: ${before} → ${zone.tiles.length} tuiles`);
            }
        }

        this.turnStartSnapshot = {
            placedTileKeys: Object.keys(this.plateau.placedTiles), // Seulement les clés
            zones: this.deepCopy(this.zoneRegistry.serialize()), // ✅ COPIE PROFONDE
            tileToZone: new Map(this.zoneMerger.tileToZone), // Copie de la map
            placedMeeples: this.deepCopy(placedMeeples),
            playerMeeples: this.gameState.players.map(p => ({
                id: p.id, name: p.name, color: p.color,
                meeples: p.meeples,
                hasAbbot: p.hasAbbot,
                hasLargeMeeple: p.hasLargeMeeple,
                hasBuilder: p.hasBuilder,
                hasPig:     p.hasPig,
                towerPieces: p.towerPieces // ✨ NOUVEAU
            })),
            lastPlacedTile: this.lastPlacedTileBeforeTurn, // épingle avant ce tour
            fairyState: this.deepCopy(this.gameState.fairyState ?? { ownerId: null, meepleKey: null }),
            // ✨ NOUVEAU : état persistant des extensions (towers/prisoners, et futures
            // structures — moutons, granges, ponts, forteresses, cf. ARCHITECTURE.md).
            // Copié en bloc, restauré génériquement par restoreExtraState() — aucune extension
            // future n'a besoin de toucher ce fichier pour être prise en compte par l'undo.
            extraState: this.deepCopy(this.gameState.extraState)
        };
        
        // Reset état du tour
        this.tilePlacedThisTurn = false;
        this.meeplePlacedThisTurn = false;
        this.lastTilePlaced = null;
        this.lastMeeplePlaced = null;
        this.afterTilePlacedSnapshot = null;
    }

    /**
     * Sauvegarder l'état après placement de tuile
     */
    saveAfterTilePlaced(x, y, tile, placedMeeples) {
        console.log('📸 Sauvegarde snapshot après pose tuile');

        // ✅ Nettoyage préventif identique
        for (const [zoneId, zone] of this.zoneRegistry.zones) {
            const before = zone.tiles.length;
            zone.tiles = zone.tiles.filter(({ x: tx, y: ty }) =>
                this.plateau.placedTiles[`${tx},${ty}`] !== undefined
            );
            if (zone.tiles.length === 0 && before > 0) {
                this.zoneRegistry.zones.delete(zoneId);
                console.log(`    🧹 [saveAfterTile] Zone vide purgée: ${zoneId}`);
            } else if (zone.tiles.length !== before) {
                console.log(`    🧹 [saveAfterTile] Fantômes retirés de ${zoneId}: ${before} → ${zone.tiles.length} tuiles`);
            }
        }

        this.afterTilePlacedSnapshot = {
            placedTileKeys: Object.keys(this.plateau.placedTiles), // Seulement les clés
            zones: this.deepCopy(this.zoneRegistry.serialize()), // ✅ COPIE PROFONDE
            tileToZone: new Map(this.zoneMerger.tileToZone), // Copie de la map
            placedMeeples: this.deepCopy(placedMeeples),
            playerMeeples: this.gameState.players.map(p => ({
                id: p.id, name: p.name, color: p.color,
                meeples: p.meeples,
                hasAbbot: p.hasAbbot,
                hasLargeMeeple: p.hasLargeMeeple,
                hasBuilder: p.hasBuilder,
                hasPig:     p.hasPig,
                towerPieces: p.towerPieces // ✨ NOUVEAU
            })),
            fairyState: this.deepCopy(this.gameState.fairyState ?? { ownerId: null, meepleKey: null }),
            pendingPortalTile: this.gameState._pendingPortalTile
                ? JSON.parse(JSON.stringify(this.gameState._pendingPortalTile))
                : null,
            // ✨ NOUVEAU : voir saveTurnStart — même conteneur générique
            extraState: this.deepCopy(this.gameState.extraState)
        };
        
        this.tilePlacedThisTurn = true;
        this.lastTilePlaced = { x, y, tile };
    }

    /**
     * Marquer qu'un meeple a été placé
     */
    markMeeplePlaced(x, y, position, key) {
        console.log('🎭 Meeple placé ce tour:', key);
        this.meeplePlacedThisTurn = true;
        this.lastMeeplePlaced = { x, y, position, key };
    }

    /**
     * Marquer que la fée a été déplacée ce tour (pour que l'undo revienne à afterTilePlacedSnapshot)
     */
    markFairyPlaced() {
        this.meeplePlacedThisTurn = true;
        this.lastMeeplePlaced = null; // pas de meeple à retirer physiquement, le snapshot suffit
    }

    /**
     * Sauvegarder un snapshot avant un déplacement dragon.
     * Appelé une fois par tour dragon (par joueur).
     */
    saveDragonMove(placedMeeples) {
        this.dragonMoveSnapshot = {
            placedMeeples: this.deepCopy(placedMeeples),
            dragonPos:   this.deepCopy(this.gameState.dragonPos),
            dragonPhase: this.deepCopy(this.gameState.dragonPhase),
            fairyState:  this.deepCopy(this.gameState.fairyState ?? { ownerId: null, meepleKey: null }),
            // ✨ NOUVEAU : un déplacement du dragon peut manger un garde verrouillant une
            // tour (cf. DragonRules._eatMeeplesAt) — l'annulation doit pouvoir le restaurer.
            extraState:  this.deepCopy(this.gameState.extraState),
            playerMeeples: this.gameState.players.map(p => ({
                id: p.id, meeples: p.meeples, hasAbbot: p.hasAbbot,
                hasLargeMeeple: p.hasLargeMeeple, hasBuilder: p.hasBuilder,
                hasPig: p.hasPig, hasFairy: p.hasFairy,
                towerPieces: p.towerPieces // ✨ NOUVEAU
            }))
        };
        this.dragonMovePlacedThisTurn = true;
    }

    /**
     * Annuler le dernier déplacement dragon.
     * @returns {Object|null} snapshot restauré ou null
     */
    undoDragonMove(placedMeeples) {
        if (!this.dragonMoveSnapshot) return null;
        const snap = this.dragonMoveSnapshot;

        // Restaurer placedMeeples
        Object.keys(placedMeeples).forEach(k => delete placedMeeples[k]);
        Object.assign(placedMeeples, this.deepCopy(snap.placedMeeples));

        // Restaurer dragonPos et dragonPhase
        this.gameState.dragonPos   = this.deepCopy(snap.dragonPos);
        this.gameState.dragonPhase = this.deepCopy(snap.dragonPhase);
        this.gameState.fairyState  = this.deepCopy(snap.fairyState);

        // ✨ NOUVEAU : restaurer extraState (towers/prisoners — un garde de tour mangé par
        // le dragon pendant ce déplacement doit être reverrouillé)
        this.restoreExtraState(snap.extraState);

        // Restaurer les meeples des joueurs
        snap.playerMeeples.forEach(pm => {
            const p = this.gameState.players.find(pl => pl.id === pm.id);
            if (p) Object.assign(p, pm);
        });

        this.dragonMoveSnapshot = null;
        this.dragonMovePlacedThisTurn = false;
        return snap;
    }

    /**
     * Marquer qu'un Abbé a été rappelé
     */
    markAbbeRecalled(x, y, key, playerId, points) {
        this.abbeRecalledThisTurn = true;
        this.lastAbbeRecalled = { x, y, key, playerId, points };
    }

    /**
     * Annuler la dernière action
     * @returns {Object|null} - Info sur ce qui a été annulé, ou null si rien à annuler
     */
    undo(placedMeeples) {
        console.log('🔍 État avant annulation:', {
            meeplePlacedThisTurn: this.meeplePlacedThisTurn,
            tilePlacedThisTurn: this.tilePlacedThisTurn,
            dragonMovePlacedThisTurn: this.dragonMovePlacedThisTurn,
            hasAfterTilePlacedSnapshot: !!this.afterTilePlacedSnapshot,
            hasTurnStartSnapshot: !!this.turnStartSnapshot
        });

        // Cas dragon : annuler un déplacement dragon
        if (this.dragonMovePlacedThisTurn && this.dragonMoveSnapshot) {
            console.log('⏪ Annulation : déplacement dragon');
            const snap = this.undoDragonMove(placedMeeples);
            return {
                type: 'dragon-move-undo',
                snap
            };
        }

        // Cas 0 : Annuler le rappel de l'Abbé
        if (this.abbeRecalledThisTurn && this.afterTilePlacedSnapshot) {
            console.log('⏪ Annulation : remise en place de l\'Abbé');
            this.restoreSnapshot(this.afterTilePlacedSnapshot, placedMeeples);
            const undoneAction = {
                type: 'abbe-recalled-undo',
                abbe: this.lastAbbeRecalled
            };
            this.abbeRecalledThisTurn = false;
            this.lastAbbeRecalled = null;
            return undoneAction;
        }

        // Cas 1 : Annuler la pose de meeple
        if (this.meeplePlacedThisTurn && this.afterTilePlacedSnapshot) {
            console.log('⏪ Annulation : retrait du meeple');
            
            // Restaurer l'état après placement de tuile (avant meeple)
            this.restoreSnapshot(this.afterTilePlacedSnapshot, placedMeeples);
            
            const undoneAction = {
                type: 'meeple',
                meeple: this.lastMeeplePlaced
            };
            
            this.meeplePlacedThisTurn = false;
            this.lastMeeplePlaced = null;
            
            return undoneAction;
        }
        
        // Cas 2 : Annuler la pose de tuile
        if (this.tilePlacedThisTurn && this.turnStartSnapshot) {
            console.log('⏪ Annulation : retrait de la tuile');
            
            // Restaurer l'état au début du tour
            this.restoreSnapshot(this.turnStartSnapshot, placedMeeples);
            
            const undoneAction = {
                type: 'tile',
                tile: this.lastTilePlaced,
                restoredLastPlacedTile: this.turnStartSnapshot.lastPlacedTile ?? null
            };
            
            this.tilePlacedThisTurn = false;
            this.lastTilePlaced = null;
            this.afterTilePlacedSnapshot = null;
            
            return undoneAction;
        }
        
        // Rien à annuler
        console.log('⚠️ Rien à annuler');
        return null;
    }

    /**
     * Mettre à jour la dernière tuile posée avant ce tour (pour restauration après annulation)
     */
    setLastPlacedTileBeforeTurn(tile) {
        this.lastPlacedTileBeforeTurn = tile ? { x: tile.x, y: tile.y } : null;
    }

    /**
     * ✨ NOUVEAU : restaure gameState.extraState de façon générique, sans connaître la liste
     * des sous-structures qu'il contient (towers, prisoners, et toute future structure
     * d'extension type moutons/granges/ponts/forteresses — cf. ARCHITECTURE.md, section
     * "Ajouter une extension avec pièces/état persistant"). Préserve l'identité des objets
     * (vidage + réassignation) plutôt que de remplacer la référence, par cohérence avec le
     * traitement de placedMeeples ailleurs dans ce fichier.
     * @param {object} source - extraState sauvegardé (depuis un snapshot local ou reçu du réseau)
     */
    restoreExtraState(source) {
        if (!source) return;
        Object.keys(this.gameState.extraState).forEach(subKey => {
            const target = this.gameState.extraState[subKey];
            if (!target || typeof target !== 'object') return;
            Object.keys(target).forEach(k => delete target[k]);
            Object.assign(target, this.deepCopy(source[subKey] ?? {}));
        });
    }

    /**
     * Restaurer un snapshot
     */
    restoreSnapshot(snapshot, placedMeeples) {
        // Restaurer plateau : retirer les tuiles qui ne devraient pas être là
        const currentKeys = Object.keys(this.plateau.placedTiles);
        const savedKeys = snapshot.placedTileKeys;
        
        // Supprimer les tuiles ajoutées depuis le snapshot
        currentKeys.forEach(key => {
            if (!savedKeys.includes(key)) {
                delete this.plateau.placedTiles[key];
                console.log(`  🗑️ Tuile retirée: ${key}`);
            }
        });
        
        // Restaurer zones
        this.zoneRegistry.deserialize(snapshot.zones);
        
        // 🧹 Nettoyer les références fantômes : retirer les tuiles qui n'existent plus
        for (const [zoneId, zone] of this.zoneRegistry.zones) {
            const originalLength = zone.tiles.length;
            zone.tiles = zone.tiles.filter(({x, y}) => {
                const key = `${x},${y}`;
                const exists = this.plateau.placedTiles[key] !== undefined;
                if (!exists) {
                    console.log(`    🗑️ Référence fantôme retirée: (${x},${y}) de ${zoneId}`);
                }
                return exists;
            });
            
            // Si zone devient vide, la supprimer
            if (zone.tiles.length === 0 && originalLength > 0) {
                this.zoneRegistry.zones.delete(zoneId);
                console.log(`    🗑️ Zone vide supprimée: ${zoneId}`);
            }
        }
        
        // Restaurer tileToZone map dans ZoneMerger
        this.zoneMerger.tileToZone = new Map(snapshot.tileToZone);
        console.log(`  🔄 Zones et tileToZone restaurés`);
        
        // Restaurer meeples placés (vider l'objet et le remplir)
        Object.keys(placedMeeples).forEach(key => delete placedMeeples[key]);
        Object.assign(placedMeeples, this.deepCopy(snapshot.placedMeeples));
        
        // Restaurer fairyState si présent dans le snapshot
        if (snapshot.fairyState !== undefined && this.gameState.fairyState) {
            this.gameState.fairyState.ownerId   = snapshot.fairyState.ownerId;
            this.gameState.fairyState.meepleKey = snapshot.fairyState.meepleKey;
            this.gameState.players.forEach(p => { p.hasFairy = false; });
            const fairyOwner = this.gameState.players.find(p => p.id === snapshot.fairyState.ownerId);
            if (fairyOwner) fairyOwner.hasFairy = true;
        }

        // ✨ NOUVEAU : restaurer extraState (towers/prisoners, et futures structures
        // d'extension — générique, cf. restoreExtraState).
        this.restoreExtraState(snapshot.extraState);

        // ✨ NOUVEAU : champs transitoires liés à l'extension Tour, non couverts par
        // extraState car turn-scoped et jamais sérialisés — doivent être explicitement
        // réinitialisés ici, sinon une capture/pose d'étage annulée laisserait une
        // vérification ou une cible de capture fantôme se déclencher plus tard dans le tour.
        // gameState._freshCaptures peut contenir des entrées obsolètes après restauration ;
        // c'est sans conséquence, car ScorePanelUI ne peut plus les atteindre (le prisonnier
        // qu'elles référencent n'existe plus une fois extraState.prisoners restauré ci-dessus).
        this.gameState._pendingTowerCapture    = null;
        this.gameState._pendingReciprocalCheck = null;

        // Restaurer compteur de meeples des joueurs
        snapshot.playerMeeples.forEach(saved => {
            // Chercher par id d'abord, puis par nom+couleur (fallback reconnexion : peerId change)
            const player = this.gameState.players.find(p => p.id === saved.id)
                        || this.gameState.players.find(p => p.name === saved.name && p.color === saved.color);
            if (player) {
                player.meeples  = saved.meeples;
                if (saved.hasAbbot       !== undefined) player.hasAbbot       = saved.hasAbbot;
                if (saved.hasLargeMeeple !== undefined) player.hasLargeMeeple = saved.hasLargeMeeple;
                if (saved.hasBuilder     !== undefined) player.hasBuilder     = saved.hasBuilder;
                if (saved.hasPig         !== undefined) player.hasPig         = saved.hasPig;
                if (saved.towerPieces    !== undefined) player.towerPieces    = saved.towerPieces; // ✨ NOUVEAU
            }
        });
    }

    /**
     * Vérifier si on peut annuler
     */
    canUndo() {
        return this.meeplePlacedThisTurn || this.tilePlacedThisTurn || this.abbeRecalledThisTurn || this.dragonMovePlacedThisTurn;
    }

    /**
     * Reset à la fin du tour
     */
    reset() {
        console.log('🔄 UndoManager: reset() appelé');
        this.turnStartSnapshot = null;
        this.afterTilePlacedSnapshot = null;
        this.tilePlacedThisTurn = false;
        this.meeplePlacedThisTurn = false;
        this.lastTilePlaced = null;
        this.lastMeeplePlaced = null;
        this.abbeRecalledThisTurn = false;
        this.lastAbbeRecalled = null;
        this.dragonMoveSnapshot = null;
        this.dragonMovePlacedThisTurn = false;
    }

    /**
     * Deep copy d'un objet
     */
    deepCopy(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    /**
     * Injecter les dépendances visuelles nécessaires à applyLocally / applyRemote.
     * Appelé une fois après instanciation depuis home.js.
     */
    initVisualHandlers(deps) {
        this._vdeps = deps;
    }

    /**
     * Applique visuellement un undo localement (hôte ou invité).
     * Appelé depuis le bouton undo (hôte), onUndoRequest (hôte pour invité), et applyRemote (invités).
     */
    applyLocally(undoneAction) {
        const d             = this._vdeps;
        const gameState     = this.gameState;
        const placedMeeples = d.getPlacedMeeples();
        const gameConfig    = d.getGameConfig();
        const multiplayer   = d.getMultiplayer();
        const plateau       = this.plateau;

        // ✨ NOUVEAU : redessine systématiquement l'état Tour (étages + gardes de
        // verrouillage) depuis gameState.extraState.towers, qui a déjà été restauré à ce
        // stade (par restoreSnapshot ou undoDragonMove, appelés avant applyLocally par
        // undo()/applyRemote()). Plus simple et plus sûr que de traiter chaque branche
        // ci-dessous séparément — une pose d'étage, une capture, un verrouillage ou un
        // déplacement dragon ayant mangé un garde peuvent tous avoir eu lieu dans le même
        // tour qu'une autre action annulée. Coût négligeable si l'extension Tour est inactive.
        d.renderAllTowersFromState?.();

        // Cas dragon : annuler un déplacement dragon
        if (undoneAction.type === 'dragon-move-undo') {
            document.querySelectorAll('.meeple').forEach(el => el.remove());
            Object.entries(placedMeeples).forEach(([key, meeple]) => {
                const [mx, my, mp] = key.split(',').map(Number);
                this.eventBus.emit('meeple-placed', {
                    ...meeple, x: mx, y: my, key, position: mp,
                    meepleType: meeple.type, playerColor: meeple.color,
                    fromUndo: true, skipSync: true
                });
            });
            if (gameState.dragonPos) {
                d.renderDragonPiece(gameState.dragonPos.x, gameState.dragonPos.y);
            }
            if (gameConfig.extensions?.fairyProtection) {
                const fs = gameState.fairyState;
                if (fs?.meepleKey) d.renderFairyPiece(fs.meepleKey);
                else d.removeFairyPiece();
            }
            d.updateDragonOverlay();
            const dragonRules = d.getDragonRules();
            if (dragonRules && gameState.dragonPhase.active) {
                const mover = gameState.players[gameState.dragonPhase.moverIndex];
                if (mover?.id === multiplayer.playerId) {
                    d.showDragonMoveCursors(dragonRules.getValidDragonMoves());
                }
                d.showDragonVisitedTiles(gameState.dragonPhase.visitedTiles, gameState.dragonPos);
            }
            this.eventBus.emit('score-updated');
            d.updateTurnDisplay();
            return;
        }

        if (undoneAction.type === 'abbe-recalled-undo') {
            d.setPendingAbbePoints(null);
            const { playerId } = undoneAction.abbe;
            const player = gameState.players.find(p => p.id === playerId);
            if (player) player.hasAbbot = false;
            const abbeKey  = undoneAction.abbe.key;
            const abbeData = placedMeeples[abbeKey];
            if (abbeData) {
                const [ax, ay] = abbeKey.split(',').map(Number);
                this.eventBus.emit('meeple-placed', {
                    ...abbeData, x: ax, y: ay, key: abbeKey,
                    position: parseInt(abbeKey.split(',')[2]),
                    meepleType: abbeData.type, playerColor: abbeData.color,
                    fromUndo: true, skipSync: true
                });
            }
            const gameSync = d.getGameSync();
            if (gameSync) gameSync.syncAbbeRecallUndo(
                undoneAction.abbe.x, undoneAction.abbe.y, abbeKey, playerId
            );
            const lastPlacedTile = d.getLastPlacedTile();
            const meepleCursorsUI = d.getMeepleCursorsUI();
            if (lastPlacedTile && meepleCursorsUI && d.getIsMyTurn()) {
                const _lastTile  = plateau.placedTiles[`${lastPlacedTile.x},${lastPlacedTile.y}`];
                const _isVolcano = !!(gameConfig.tileGroups?.dragon && gameConfig.extensions?.dragon && d.tileHasVolcanoZone(_lastTile));
                if (!_isVolcano) {
                    meepleCursorsUI.showCursors(lastPlacedTile.x, lastPlacedTile.y, gameState, placedMeeples, d.afficherSelecteurMeeple);
                }
                d.showMeepleActionCursors();
            }
            this.eventBus.emit('score-updated');
            d.updateTurnDisplay();
            return;
        }

        if (undoneAction.type === 'meeple') {
            if (undoneAction.meeple?.key) {
                // Undo placement meeple normal : retirer le meeple DOM
                document.querySelectorAll(`.meeple[data-key="${undoneAction.meeple.key}"]`).forEach(el => el.remove());
            } else {
                // Undo éjection princesse OU pose d'étage/capture Tour : re-rendre tous les
                // meeples du snapshot (le pion de tour a déjà été redessiné plus haut)
                document.querySelectorAll('.meeple').forEach(el => el.remove());
                Object.entries(placedMeeples).forEach(([key, meeple]) => {
                    const [mx, my, mp] = key.split(',').map(Number);
                    this.eventBus.emit('meeple-placed', {
                        ...meeple, x: mx, y: my, key, position: mp,
                        meepleType: meeple.type, playerColor: meeple.color,
                        fromUndo: true, skipSync: true
                    });
                });
                // Re-détecter les cibles princesse pour la tuile posée ce tour
                const lastPlacedTile = d.getLastPlacedTile();
                const dragonRules    = d.getDragonRules();
                if (lastPlacedTile && gameConfig.extensions?.princess && dragonRules && this.zoneMerger) {
                    const _undoTile = plateau.placedTiles[`${lastPlacedTile.x},${lastPlacedTile.y}`];
                    if (_undoTile) {
                        const _hasPrincess = _undoTile.zones?.some(z => z.type === 'city' && z.features?.includes?.('princess'));
                        if (_hasPrincess) {
                            const targets = dragonRules.getPrincessTargets(lastPlacedTile.x, lastPlacedTile.y, _undoTile, multiplayer.playerId, this.zoneMerger);
                            if (targets.length > 0) {
                                gameState._pendingPrincessTile = { x: lastPlacedTile.x, y: lastPlacedTile.y, targets };
                            }
                        }
                    }
                }
            }
            // Restaurer _pendingPortalTile depuis le snapshot afterTilePlaced si disponible
            if (this.afterTilePlacedSnapshot?.pendingPortalTile !== undefined) {
                gameState._pendingPortalTile = this.afterTilePlacedSnapshot.pendingPortalTile;
            }
            // Restaurer le rendu de la fée
            if (gameConfig.extensions?.fairyProtection || gameConfig.extensions?.fairyScoreTurn || gameConfig.extensions?.fairyScoreZone) {
                const fs = gameState.fairyState;
                if (fs?.meepleKey) d.renderFairyPiece(fs.meepleKey);
                else d.removeFairyPiece();
            }
            const lastPlacedTile  = d.getLastPlacedTile();
            const meepleCursorsUI = d.getMeepleCursorsUI();
            if (lastPlacedTile && meepleCursorsUI && d.getIsMyTurn()) {
                const _undoTile      = plateau.placedTiles[`${lastPlacedTile.x},${lastPlacedTile.y}`];
                const _undoIsVolcano = !!(gameConfig.tileGroups?.dragon && gameConfig.extensions?.dragon && d.tileHasVolcanoZone(_undoTile));
                if (!_undoIsVolcano) {
                    meepleCursorsUI.showCursors(lastPlacedTile.x, lastPlacedTile.y, gameState, placedMeeples, d.afficherSelecteurMeeple);
                }
                d.showMeepleActionCursors();
            }

        } else if (undoneAction.type === 'tile') {
            d.setLastPlacedTile(undoneAction.restoredLastPlacedTile ?? null);
            const { x, y } = undoneAction.tile;
            let tileEl = document.querySelector(`.tile[data-pos="${x},${y}"]`);
            if (!tileEl) {
                tileEl = Array.from(document.querySelectorAll('.tile'))
                    .find(el => el.style.gridColumn == x && el.style.gridRow == y);
            }
            if (tileEl) tileEl.remove();

            d.setTuileEnMain(undoneAction.tile.tile);
            d.setTuilePosee(false);

            const slotsUI      = d.getSlotsUI();
            const tilePlacement = d.getTilePlacement();
            if (x === 50 && y === 50) {
                d.setFirstTilePlaced(false);
                if (slotsUI)        { slotsUI.firstTilePlaced = false; slotsUI.currentTile = null; }
                if (tilePlacement)  tilePlacement.firstTilePlaced = false;
            }

            const tilePreviewUI = d.getTilePreviewUI();
            if (tilePreviewUI) tilePreviewUI.showTile(undoneAction.tile.tile);
            if (slotsUI) slotsUI.tileAvailable = true;

            this.eventBus.emit('tile-drawn', {
                tileData: { ...undoneAction.tile.tile, rotation: undoneAction.tile.tile.rotation },
                fromUndo: true
            });

            if (x === 50 && y === 50) {
                document.querySelectorAll('.slot-central').forEach(s => s.remove());
                if (slotsUI) slotsUI.createCentralSlot();
            }

            if (slotsUI && d.getFirstTilePlaced()) slotsUI.refreshAllSlots();
            d.hideAllCursors();
        }
    }

    /**
     * Applique un undo reçu du réseau (côté invité).
     */
    applyRemote(undoneAction) {
        console.log('⏪ [REMOTE] Application annulation distante:', undoneAction.type);
        const d         = this._vdeps;
        const gameState = this.gameState;
        const plateau   = this.plateau;

        // Restaurer l'état post-undo envoyé par l'hôte
        const s = undoneAction.postUndoState;
        if (s) {
            // Plateau : retirer les tuiles non présentes dans le snapshot
            Object.keys(plateau.placedTiles).forEach(key => {
                if (!s.placedTileKeys.includes(key)) delete plateau.placedTiles[key];
            });
            // Zones
            this.zoneMerger.registry.deserialize(s.zones);
            this.zoneMerger.tileToZone = new Map(s.tileToZone);
            // Meeples placés
            const placedMeeples = d.getPlacedMeeples();
            Object.keys(placedMeeples).forEach(k => delete placedMeeples[k]);
            Object.assign(placedMeeples, JSON.parse(JSON.stringify(s.placedMeeples)));
            // Compteurs joueurs
            s.playerMeeples.forEach(saved => {
                const player = gameState.players.find(p => p.id === saved.id);
                if (player) {
                    player.meeples        = saved.meeples;
                    player.hasAbbot       = saved.hasAbbot;
                    player.hasLargeMeeple = saved.hasLargeMeeple;
                    player.hasBuilder     = saved.hasBuilder;
                    player.hasPig         = saved.hasPig;
                    if (saved.towerPieces !== undefined) player.towerPieces = saved.towerPieces; // ✨ NOUVEAU
                }
            });
            // ✨ NOUVEAU : restaurer extraState (towers/prisoners, générique) et les champs
            // transitoires Tour — même traitement que restoreSnapshot() côté hôte.
            if (s.extraState) this.restoreExtraState(s.extraState);
            gameState._pendingTowerCapture    = null;
            gameState._pendingReciprocalCheck = null;
            // Restaurer et afficher la fée
            if (s.fairyState !== undefined && gameState.fairyState) {
                gameState.fairyState.ownerId   = s.fairyState.ownerId;
                gameState.fairyState.meepleKey = s.fairyState.meepleKey;
                gameState.players.forEach(p => { p.hasFairy = false; });
                const fairyOwner = gameState.players.find(p => p.id === s.fairyState.ownerId);
                if (fairyOwner) fairyOwner.hasFairy = true;
                if (s.fairyState.meepleKey) d.renderFairyPiece(s.fairyState.meepleKey);
                else d.removeFairyPiece();
            }
            if (s.dragonPos !== undefined) {
                gameState.dragonPos   = s.dragonPos;
                gameState.dragonPhase = { ...gameState.dragonPhase, ...s.dragonPhase };
                if (gameState.dragonPos) d.renderDragonPiece(gameState.dragonPos.x, gameState.dragonPos.y);
            }
            if ('pendingPortalTile' in s) {
                gameState._pendingPortalTile = s.pendingPortalTile;
            }
        }

        // Synchroniser les flags de l'UndoManager local (côté invité)
        const isMyTurn = d.getIsMyTurn();
        if (undoneAction.type === 'meeple' && isMyTurn) {
            this.meeplePlacedThisTurn = false;
            this.lastMeeplePlaced     = null;
        } else if (undoneAction.type === 'tile' && isMyTurn) {
            this.tilePlacedThisTurn      = false;
            this.meeplePlacedThisTurn    = false;
            this.abbeRecalledThisTurn    = false;
            this.lastTilePlaced          = null;
            this.lastMeeplePlaced        = null;
            this.afterTilePlacedSnapshot = null;
        } else if (undoneAction.type === 'abbe-recalled-undo' && isMyTurn) {
            this.abbeRecalledThisTurn = false;
            this.lastAbbeRecalled     = null;
        } else if (undoneAction.type === 'dragon-move-undo') {
            this.dragonMovePlacedThisTurn = false;
            this.dragonMoveSnapshot       = null;
        }

        // Appliquer visuellement
        this.applyLocally(undoneAction);

        gameState.players.forEach(p => this.eventBus.emit('meeple-count-updated', { playerId: p.id }));
        this.eventBus.emit('score-updated');
        d.updateTurnDisplay();
    }

    /**
     * Détruire le module
     */
    destroy() {
        console.log('🧹 UndoManager: cleanup');
        this.reset();
    }
}
