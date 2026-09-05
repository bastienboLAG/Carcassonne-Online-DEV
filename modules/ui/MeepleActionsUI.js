/**
 * MeepleActionsUI — UI des actions meeple sur le plateau
 * (rappel abbé, fée, princesse, portail magique, tour)
 *
 * Dépendances injectées via initMeepleActionsUI()
 */

import {
    clearTowerCursors, showTowerCursors, showPendingTowerCaptureIfAny,
    applyFloorPlaced, applyCaptureExecuted,
} from '../game/TowerUI.js'; // ✨ NOUVEAU

let _deps = null;

export function initMeepleActionsUI(deps) {
    _deps = deps;
}

// ── Helpers internes ───────────────────────────────────────────────────────

function _gs()            { return _deps.getGameState(); }
function _mp()            { return _deps.getMultiplayer(); }
function _pm()            { return _deps.getPlacedMeeples(); }
function _plateau()       { return _deps.getPlateau(); }
function _isMyTurn()      { return _deps.getIsMyTurn(); }

// ── Curseurs d'action meeple ───────────────────────────────────────────────

export function showMeepleActionCursors() {
    document.querySelectorAll('.meeple-action-cursor, .meeple-action-overlay').forEach(el => el.remove());
    clearTowerCursors(); // ✨ NOUVEAU

    const gameState = _gs();
    const multiplayer = _mp();
    const placedMeeples = _pm();
    const gameConfig  = _deps.getGameConfig();
    const undoManager = _deps.getUndoManager();
    const dragonRules = _deps.getDragonRules();
    const gameSync    = _deps.getGameSync();
    const isHost      = _deps.getIsHost();

    if (!gameState || !_deps.getMeepleCursorsUI()) return;
    const boardEl = document.getElementById('board');
    if (!boardEl) return;

    // ✨ NOUVEAU — Extension Tour : indépendant des autres actions ci-dessous,
    // toujours évalué (pose d'étage + capture en attente éventuelle)
    showTowerCursors();
    showPendingTowerCaptureIfAny();

    const currentFairyKey   = gameState.fairyState?.meepleKey ?? null;
    const pendingPrincess   = gameState._pendingPrincessTile ?? null;
    const princessTargetSet = new Set(pendingPrincess?.targets ?? []);
    console.log(`👸 [showMeepleActionCursors] pendingPrincess:`, pendingPrincess, '| princessTargets:', [...princessTargetSet], '| placedMeeples:', Object.keys(placedMeeples));

    const actionsByKey = {};

    // 1. Rappel abbé
    if (gameConfig?.extensions?.abbot && !undoManager?.abbeRecalledThisTurn) {
        Object.entries(placedMeeples).forEach(([key, meeple]) => {
            if (meeple.type?.toLowerCase() !== 'abbot' || meeple.playerId !== multiplayer.playerId) return;
            actionsByKey[key] = actionsByKey[key] ?? [];
            actionsByKey[key].push({ type: 'abbe-recall', meeple });
        });
    }

    // 2. Attacher la fée
    const _fairyEnabled = dragonRules && (
        gameConfig?.extensions?.fairyProtection
     || gameConfig?.extensions?.fairyScoreTurn
     || gameConfig?.extensions?.fairyScoreZone
    );
    if (_fairyEnabled && !undoManager?.meeplePlacedThisTurn) {
        const fairyTargets = dragonRules.getFairyTargets(multiplayer.playerId);
        fairyTargets.forEach(({ key, meeple }) => {
            if (key === currentFairyKey) return;
            actionsByKey[key] = actionsByKey[key] ?? [];
            actionsByKey[key].push({ type: 'fairy', meeple });
        });
    }

    // 3. Éjection princesse
    if (pendingPrincess) {
        princessTargetSet.forEach(key => {
            const meeple = placedMeeples[key];
            if (!meeple) return;
            actionsByKey[key] = actionsByKey[key] ?? [];
            actionsByKey[key].push({ type: 'princess', meeple });
        });
    }

    // 4. Portail magique
    const pendingPortal = gameState._pendingPortalTile ?? null;
    if (pendingPortal && !undoManager?.meeplePlacedThisTurn && dragonRules) {
        const portalKey = `${pendingPortal.x},${pendingPortal.y},${pendingPortal.position}`;
        actionsByKey[portalKey] = actionsByKey[portalKey] ?? [];
        actionsByKey[portalKey].push({ type: 'portal', meeple: null, isPortalZone: true });
    }

    if (Object.keys(actionsByKey).length === 0) {
        if (pendingPrincess && princessTargetSet.size === 0) gameState._pendingPrincessTile = null;
        gameState._pendingPortalTile = null;
        return;
    }

    Object.entries(actionsByKey).forEach(([key, actions]) => {
        const meeple = placedMeeples[key];
        const isPortalEntry = actions.some(a => a.type === 'portal' && a.isPortalZone);
        if (!meeple && !isPortalEntry) return;
        const parts   = key.split(',');
        const mx      = Number(parts[0]), my = Number(parts[1]), mp = Number(parts[2]);
        const row     = Math.floor((mp - 1) / 5);
        const col     = (mp - 1) % 5;
        const offsetX = 20.8 + col * 41.6;
        const offsetY = 20.8 + row * 41.6;

        const overlay = document.createElement('div');
        overlay.className        = 'meeple-action-overlay';
        overlay.style.gridColumn = mx;
        overlay.style.gridRow    = my;
        overlay.style.cssText   += 'position:relative;width:208px;height:208px;pointer-events:none;z-index:101;';

        const btn = document.createElement('div');
        btn.className = 'meeple-action-cursor';
        btn.dataset.key = key;
        btn.style.cssText = `position:absolute;left:${offsetX}px;top:${offsetY}px;width:32px;height:32px;border-radius:50%;border:3px solid rgb(200,0,175);box-shadow:0 0 8px 2px rgba(200,0,175,0.7),inset 0 0 4px rgba(0,0,0,0.8);cursor:pointer;pointer-events:auto;transform:translate(-50%,-50%);animation:abbeRecallPulse 1.2s ease-in-out infinite;`;

        const openSelector = (clientX, clientY) => {
            const oldSel = document.getElementById('meeple-selector');
            if (oldSel) oldSel.remove();

            const selector = document.createElement('div');
            selector.id = 'meeple-selector';
            selector.style.cssText = `position:fixed;left:${clientX}px;top:${clientY - 80}px;transform:translateX(-50%);z-index:1000;display:flex;align-items:flex-end;gap:0;padding:2px;background:rgba(44,62,80,0.5);border-radius:8px;border:2px solid gold;box-shadow:0 4px 20px rgba(0,0,0,0.5);`;

            const targetColor = meeple ? meeple.color.charAt(0).toUpperCase() + meeple.color.slice(1) : '';

            actions.forEach(action => {
                const option = document.createElement('div');
                option.style.cssText = 'cursor:pointer;padding:4px;border-radius:5px;position:relative;';

                let imgSrc, overlayEmoji, isEmoji = false;
                if (action.type === 'abbe-recall') {
                    const myColor = (gameState.players.find(p => p.id === multiplayer.playerId)?.color ?? 'blue');
                    imgSrc = `./assets/Meeples/${myColor.charAt(0).toUpperCase()+myColor.slice(1)}/Abbot.png`;
                    overlayEmoji = '↩️';
                } else if (action.type === 'fairy') {
                    imgSrc = `./assets/Meeples/Fairy.png`;
                    overlayEmoji = null;
                } else if (action.type === 'portal') {
                    isEmoji = true;
                } else {
                    imgSrc = `./assets/Meeples/${targetColor}/${meeple.type}.png`;
                    overlayEmoji = '↩️';
                }

                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'position:relative;display:inline-block;';

                if (isEmoji) {
                    const emoji = document.createElement('span');
                    emoji.textContent = '🌌';
                    emoji.style.cssText = 'font-size:32px;display:flex;align-items:center;justify-content:center;width:40px;height:40px;';
                    wrapper.appendChild(emoji);
                } else {
                    const img = document.createElement('img');
                    img.src = imgSrc; img.style.cssText = 'width:40px;height:40px;display:block;';
                    wrapper.appendChild(img);
                    if (overlayEmoji) {
                        const badge = document.createElement('span');
                        badge.textContent = overlayEmoji;
                        badge.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:14px;line-height:1;pointer-events:none;text-shadow:0 0 3px rgba(0,0,0,0.8);';
                        wrapper.appendChild(badge);
                    }
                }
                option.appendChild(wrapper);
                option.onmouseenter = () => { option.style.background = 'rgba(255,215,0,0.2)'; };
                option.onmouseleave = () => { option.style.background = 'transparent'; };
                option.onclick = (e) => {
                    e.stopPropagation(); selector.remove();
                    if (action.type === 'abbe-recall') {
                        const [ax, ay] = key.split(',').map(Number);
                        handleAbbeRecall(ax, ay, key, meeple);
                    } else if (action.type === 'fairy') {
                        handleFairyPlacement(key);
                    } else if (action.type === 'portal') {
                        _deps.onHandlePortalActivate();
                    } else {
                        if (isHost) {
                            _deps.onHandlePrincessEject(key);
                        } else {
                            const hostConn = gameSync?.multiplayer?.connections?.[0];
                            if (hostConn?.open) {
                                hostConn.send({ type: 'princess-eject-request', meepleKey: key, playerId: multiplayer.playerId });
                            }
                            hideAllCursors();
                            document.querySelectorAll('.meeple-action-cursor, .meeple-action-overlay').forEach(el => el.remove());
                            gameState._pendingPrincessTile = null;
                            gameState._pendingPortalTile = null;
                            if (undoManager) { undoManager.meeplePlacedThisTurn = true; undoManager.lastMeeplePlaced = null; }
                        }
                    }
                };
                selector.appendChild(option);
            });

            document.body.appendChild(selector);
            setTimeout(() => {
                const close = (e) => { if (!selector.contains(e.target)) { selector.remove(); document.removeEventListener('click', close); } };
                document.addEventListener('click', close);
            }, 0);
        };

        btn.addEventListener('click',    (e) => { e.stopPropagation(); openSelector(e.clientX, e.clientY); });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); openSelector(e.changedTouches[0].clientX, e.changedTouches[0].clientY); }, { passive: false });

        overlay.appendChild(btn);
        boardEl.appendChild(overlay);
    });
}


export function clearFairyCursors() {
    document.querySelectorAll('.fairy-cursor,.fairy-cursor-overlay,.meeple-action-cursor,.meeple-action-overlay').forEach(el => el.remove());
}

export function hideAllCursors() {
    _deps.getMeepleCursorsUI()?.hideCursors();
    clearFairyCursors();
    clearTowerCursors(); // ✨ NOUVEAU
}

export function showFairyTargets() {
    showMeepleActionCursors();
}

// ── Placement fée ──────────────────────────────────────────────────────────

export function handleFairyPlacement(meepleKey) {
    clearFairyCursors();
    const dragonRules = _deps.getDragonRules();
    if (!dragonRules) return;

    const multiplayer = _mp();
    dragonRules.placeFairy(multiplayer.playerId, meepleKey);
    _deps.renderFairyPiece(meepleKey);
    const undoManager = _deps.getUndoManager();
    if (undoManager) undoManager.markFairyPlaced();

    const gameSync = _deps.getGameSync();
    if (gameSync) {
        multiplayer.broadcast({
            type: 'fairy-placed-sync',
            ownerId:   multiplayer.playerId,
            meepleKey,
        });
    }

    hideAllCursors();
    _deps.updateTurnDisplay();
}


export function countAbbePoints(x, y) {
    let count = 1;
    const dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    dirs.forEach(([dx, dy]) => {
        if (_plateau().placedTiles[`${x+dx},${y+dy}`]) count++;
    });
    return count;
}

// ── Rappel abbé ────────────────────────────────────────────────────────────

export function handleAbbeRecall(x, y, key, meeple) {
    console.log('↩️ Rappel Abbé:', key);

    const points       = countAbbePoints(x, y);
    const placedMeeples = _pm();
    const gameState    = _gs();
    const eventBus     = _deps.getEventBus();
    const undoManager  = _deps.getUndoManager();
    const gameSync     = _deps.getGameSync();

    // Retirer l'Abbé du plateau visuellement
    document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());

    // Mettre à jour placedMeeples
    delete placedMeeples[key];
    _deps.releaseFairyIfDetached(key);

    // Rendre l'Abbé au joueur
    const player = gameState.players.find(p => p.id === meeple.playerId);
    if (player) {
        player.hasAbbot = true;
        eventBus.emit('meeple-count-updated', { playerId: meeple.playerId });
    }

    // Cacher les overlays
    _deps.hideAllCursors();

    // Marquer dans UndoManager
    if (undoManager) undoManager.markAbbeRecalled(x, y, key, meeple.playerId, points);

    // Stocker les points à ajouter en fin de tour
    _deps.setPendingAbbePoints({ playerId: meeple.playerId, points });

    // Sync réseau
    if (gameSync) gameSync.syncAbbeRecall(x, y, key, meeple.playerId, points);

    _deps.updateTurnDisplay();
    _deps.updateMobileButtons();
    eventBus.emit('score-updated');
}

// ── Portail magique ────────────────────────────────────────────────────────

export function handlePortalActivate() {
    const gameState   = _gs();
    const dragonRules = _deps.getDragonRules();
    if (!dragonRules || !gameState._pendingPortalTile) return;

    hideAllCursors();
    document.querySelectorAll('.meeple-action-cursor, .meeple-action-overlay').forEach(el => el.remove());

    const boardEl = document.getElementById('board');
    if (!boardEl) return;

    const plateau       = _plateau();
    const placedMeeples = _pm();
    const targets       = dragonRules.getPortalTargets(_deps.getZoneMerger(), plateau.placedTiles);
    const pendingPortal = gameState._pendingPortalTile;
    const meepleCursorsUI  = _deps.getMeepleCursorsUI();
    const meepleSelectorUI = _deps.getMeepleSelectorUI();

    const { x: px, y: py, position: ppos } = pendingPortal;
    const cancelOverlay = document.createElement('div');
    cancelOverlay.className = 'meeple-action-overlay portal-cancel-overlay';
    cancelOverlay.style.cssText = `position:relative;width:208px;height:208px;pointer-events:none;z-index:102;grid-column:${px};grid-row:${py};`;
    const prow = Math.floor((ppos - 1) / 5);
    const pcol = (ppos - 1) % 5;
    const cancelBtn = document.createElement('div');
    cancelBtn.className = 'meeple-action-cursor portal-cancel-btn';
    cancelBtn.style.cssText = `position:absolute;left:${20.8 + pcol * 41.6}px;top:${20.8 + prow * 41.6}px;width:32px;height:32px;border-radius:50%;border:3px solid #e74c3c;box-shadow:0 0 8px 2px rgba(231,76,60,0.7);background:rgba(231,76,60,0.2);cursor:pointer;pointer-events:auto;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;font-size:16px;color:white;font-weight:bold;z-index:102;`;
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Annuler le portail';
    const cancelAction = (e) => {
        e.stopPropagation();
        document.querySelectorAll('.portal-target-overlay, .portal-cancel-overlay').forEach(el => el.remove());
        const lastPlacedTile = _deps.getLastPlacedTile();
        if (lastPlacedTile && meepleCursorsUI) {
            const _undoTile = plateau.placedTiles[`${lastPlacedTile.x},${lastPlacedTile.y}`];
            if (_undoTile) meepleCursorsUI.showCursors(lastPlacedTile.x, lastPlacedTile.y, gameState, placedMeeples, afficherSelecteurMeeple);
        }
        showMeepleActionCursors();
    };
    cancelBtn.addEventListener('click', cancelAction);
    cancelBtn.addEventListener('touchend', (e) => { e.preventDefault(); cancelAction(e); }, { passive: false });
    cancelOverlay.appendChild(cancelBtn);
    boardEl.appendChild(cancelOverlay);

    targets.forEach(({ x, y, position, zoneType }) => {
        const overlay = document.createElement('div');
        overlay.className = 'meeple-action-overlay portal-target-overlay';
        overlay.style.cssText = `position:relative;width:208px;height:208px;pointer-events:none;z-index:101;grid-column:${x};grid-row:${y};`;
        const row = Math.floor((position - 1) / 5);
        const col = (position - 1) % 5;
        const btn = document.createElement('div');
        btn.className = 'meeple-action-cursor';
        btn.style.cssText = `position:absolute;left:${20.8 + col * 41.6}px;top:${20.8 + row * 41.6}px;width:32px;height:32px;border-radius:50%;border:3px solid #8e44ad;box-shadow:0 0 8px 2px rgba(142,68,173,0.7),inset 0 0 4px rgba(0,0,0,0.8);cursor:pointer;pointer-events:auto;transform:translate(-50%,-50%);z-index:101;`;
        const openPortalSelector = (clientX, clientY) => {
            document.getElementById('meeple-selector')?.remove();
            meepleSelectorUI.showPortal(x, y, position, zoneType, clientX, clientY, (sx, sy, spos, meepleType) => {
                document.querySelectorAll('.portal-target-overlay, .portal-cancel-overlay').forEach(el => el.remove());
                placeMeepleViaPortal(sx, sy, spos, meepleType);
            });
        };
        btn.addEventListener('click',    (e) => { e.stopPropagation(); openPortalSelector(e.clientX, e.clientY); });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); openPortalSelector(e.changedTouches[0].clientX, e.changedTouches[0].clientY); }, { passive: false });
        overlay.appendChild(btn);
        boardEl.appendChild(overlay);
    });

    if (targets.length === 0) {
        const lastPlacedTile = _deps.getLastPlacedTile();
        if (lastPlacedTile && meepleCursorsUI) {
            const _undoTile = plateau.placedTiles[`${lastPlacedTile.x},${lastPlacedTile.y}`];
            if (_undoTile) meepleCursorsUI.showCursors(lastPlacedTile.x, lastPlacedTile.y, gameState, placedMeeples, afficherSelecteurMeeple);
        }
        showMeepleActionCursors();
    }
}

export function placeMeepleViaPortal(x, y, position, meepleType) {
    const gameState     = _gs();
    const multiplayer   = _mp();
    const placedMeeples = _pm();
    const gameSync      = _deps.getGameSync();
    const undoManager   = _deps.getUndoManager();
    const eventBus      = _deps.getEventBus();
    const isHost        = _deps.getIsHost();

    gameState._pendingPortalTile = null;

    const player = gameState.players.find(p => p.id === multiplayer.playerId);
    if (!player) return;

    const playerColor = player.color.charAt(0).toUpperCase() + player.color.slice(1);
    const meepleKey = `${x},${y},${position}`;

    if (gameSync && !isHost) {
        placedMeeples[meepleKey] = { type: meepleType, color: playerColor, playerId: multiplayer.playerId };
        if (meepleType === 'Abbot')       { player.hasAbbot = false; }
        else if (meepleType === 'Large' || meepleType === 'Large-Farmer') { player.hasLargeMeeple = false; }
        else                              { if (player.meeples > 0) player.meeples--; }
        const meepleDisplayUI = _deps.getMeepleDisplayUI();
        if (meepleDisplayUI) meepleDisplayUI.showMeeple(x, y, position, meepleType, playerColor);
        if (undoManager) undoManager.markMeeplePlaced(x, y, position, meepleKey);
        const scorePanelUI = _deps.getScorePanelUI();
        if (scorePanelUI) scorePanelUI.updateMobile();
        eventBus.emit('score-updated');
        const hostConn = gameSync?.multiplayer?.connections?.[0];
        if (hostConn?.open) {
            hostConn.send({ type: 'portal-meeple-request', x, y, position, meepleType, playerId: multiplayer.playerId });
        }
        hideAllCursors();
        _deps.updateMobileButtons();
        return;
    }

    const meeplePlacement = _deps.getMeeplePlacement();
    const success = meeplePlacement.placeMeeple(x, y, position, meepleType, multiplayer.playerId);
    if (!success) return;

    if (meepleType === 'Abbot')       { player.hasAbbot = false; }
    else if (meepleType === 'Large' || meepleType === 'Large-Farmer') { player.hasLargeMeeple = false; }

    placedMeeples[meepleKey] = { type: meepleType, color: playerColor, playerId: multiplayer.playerId };
    if (undoManager) undoManager.markMeeplePlaced(x, y, position, meepleKey);

    if (gameSync) {
        gameSync.multiplayer.broadcast({
            type: 'portal-meeple-placed',
            x, y, position, meepleType,
            playerId: multiplayer.playerId,
            color: playerColor
        });
    }

    eventBus.emit('meeple-count-updated', { playerId: multiplayer.playerId });
    hideAllCursors();
    _deps.updateMobileButtons();
}

// ── Éjection princesse ─────────────────────────────────────────────────────

export function handlePrincessEject(meepleKey) {
    const gameState     = _gs();
    const multiplayer   = _mp();
    const placedMeeples = _pm();
    const dragonRules   = _deps.getDragonRules();
    const undoManager   = _deps.getUndoManager();
    const gameSync      = _deps.getGameSync();
    const zoneMerger    = _deps.getZoneMerger();
    const eventBus      = _deps.getEventBus();

    hideAllCursors();
    document.querySelectorAll('.meeple-action-cursor, .meeple-action-overlay').forEach(el => el.remove());
    gameState._pendingPrincessTile = null;
    gameState._pendingPortalTile   = null;

    if (!dragonRules) return;
    dragonRules.executePrincess(meepleKey);

    if (undoManager) {
        undoManager.meeplePlacedThisTurn = true;
        undoManager.lastMeeplePlaced     = null;
    }

    document.querySelectorAll(`.meeple[data-key="${meepleKey}"]`).forEach(el => el.remove());
    const meeple = placedMeeples[meepleKey];
    if (meeple) {
        const player = gameState.players.find(p => p.id === meeple.playerId);
        if (player) {
            if (meeple.type === 'Abbot') player.hasAbbot = true;
            else if (meeple.type === 'Large' || meeple.type === 'Large-Farmer') player.hasLargeMeeple = true;
            else if (meeple.type === 'Builder') player.hasBuilder = true;
            else if (meeple.type === 'Pig') player.hasPig = true;
            else if (player.meeples < 7) player.meeples++;
        }
        delete placedMeeples[meepleKey];
    }

    const orphanKeys = [];
    if (zoneMerger) {
        for (const [key, m] of Object.entries(placedMeeples)) {
            if (m.type !== 'Builder') continue;
            const parts = key.split(',');
            const bx = Number(parts[0]), by = Number(parts[1]), bp = Number(parts[2]);
            const zoneId = zoneMerger.findMergedZoneForPosition(bx, by, bp)?.id;
            if (zoneId == null) continue;
            const hasNormalMeeple = Object.entries(placedMeeples).some(([k2, m2]) => {
                if (k2 === key) return false;
                if (m2.playerId !== m.playerId) return false;
                if (m2.type === 'Builder' || m2.type === 'Pig') return false;
                const [x2, y2, p2] = k2.split(',').map(Number);
                return zoneMerger.findMergedZoneForPosition(x2, y2, p2)?.id === zoneId;
            });
            if (!hasNormalMeeple) orphanKeys.push(key);
        }
        orphanKeys.forEach(key => {
            const m = placedMeeples[key];
            const p = gameState.players.find(pl => pl.id === m.playerId);
            if (p) p.hasBuilder = true;
            delete placedMeeples[key];
            document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
        });
    }

    if (gameSync) {
        gameSync.multiplayer.broadcast({
            type: 'princess-ejected',
            meepleKey,
            orphanKeys,
            playerId: multiplayer.playerId
        });
        gameSync.syncScoreUpdate([], [], [], zoneMerger);
    }

    eventBus.emit('meeple-count-updated', {});
    eventBus.emit('score-updated');
}

// ── Sélecteur meeple & placement ───────────────────────────────────────────

export function afficherSelecteurMeeple(x, y, position, zoneType, mouseX, mouseY) {
    _deps.getMeepleSelectorUI().show(x, y, position, zoneType, mouseX, mouseY, placerMeeple);
}

export function placerMeeple(x, y, position, meepleType) {
    const gameState   = _gs();
    const multiplayer = _mp();
    if (!gameState || !multiplayer) return;

    const gameSync  = _deps.getGameSync();
    const isHost    = _deps.getIsHost();

    if (gameSync && !isHost) {
        // ✅ Étape 3 : invité purement réactif — envoie request, attend echo hôte
        hideAllCursors();
        gameSync.syncMeeplePlacementRequest(x, y, position, meepleType);
        return;
    }

    // Hôte ou solo : applique localement
    const meeplePlacement = _deps.getMeeplePlacement();
    const eventBus        = _deps.getEventBus();
    const undoManager     = _deps.getUndoManager();

    const success = meeplePlacement.placeMeeple(x, y, position, meepleType, multiplayer.playerId);
    if (!success) return;

    console.log('🎭 placerMeeple — type:', meepleType, '— zone:', x, y, position);

    if (meepleType === 'Abbot') {
        const player = gameState.players.find(p => p.id === multiplayer.playerId);
        if (player) player.hasAbbot = false;
        eventBus.emit('meeple-count-updated', { playerId: multiplayer.playerId });
    }
    if (meepleType === 'Large' || meepleType === 'Large-Farmer') {
        const player = gameState.players.find(p => p.id === multiplayer.playerId);
        if (player) player.hasLargeMeeple = false;
        eventBus.emit('meeple-count-updated', { playerId: multiplayer.playerId });
    }
    if (meepleType === 'Builder') {
        const player = gameState.players.find(p => p.id === multiplayer.playerId);
        if (player) player.hasBuilder = false;
        eventBus.emit('meeple-count-updated', { playerId: multiplayer.playerId });
    }
    if (meepleType === 'Pig') {
        const player = gameState.players.find(p => p.id === multiplayer.playerId);
        if (player) player.hasPig = false;
        eventBus.emit('meeple-count-updated', { playerId: multiplayer.playerId });
    }

    if (undoManager && (_isMyTurn() || isHost)) {
        undoManager.markMeeplePlaced(x, y, position, `${x},${y},${position}`);
    }
    hideAllCursors();
}

// ── Listeners réseau (portail, princesse, tour) ─────────────────────────────

export function initNetworkMeepleListeners(eventBus) {
    // Portail Magique : réception d'un placement via portail
    eventBus.on('network-portal-meeple-placed', (data) => {
        // L'hôte a déjà appliqué le placement via portal-meeple-request — ignorer
        if (_deps.getIsHost()) return;

        const { x, y, position, meepleType, playerId, color } = data;
        const key = `${x},${y},${position}`;
        const placedMeeples = _pm();
        placedMeeples[key] = { type: meepleType, color, playerId };

        const player = _gs().players.find(p => p.id === playerId);
        if (player) {
            if (meepleType === 'Abbot')                                          { player.hasAbbot = false; }
            else if (meepleType === 'Large' || meepleType === 'Large-Farmer')    { player.hasLargeMeeple = false; }
            else                                                                  { if (player.meeples > 0) player.meeples--; }
        }

        // Rendu visuel via meeple-placed
        eventBus.emit('meeple-placed', {
            x, y, position, meepleType, playerColor: color, playerId,
            key, fromNetwork: true, skipSync: true
        });
        eventBus.emit('meeple-count-updated', { playerId });
    });

    // Éjection princesse reçue du réseau
    eventBus.on('network-princess-ejected', (data) => {
        // L'hôte applique si c'est un invité qui a éjecté (pas lui-même)
        // L'invité applique toujours (broadcast de l'hôte)
        const isHost      = _deps.getIsHost();
        const multiplayer = _mp();
        if (isHost && data.playerId === multiplayer.playerId) return;

        const { meepleKey, orphanKeys = [] } = data;
        const placedMeeples = _pm();
        const gameState     = _gs();
        const undoManager   = _deps.getUndoManager();

        // Retirer le meeple éjecté
        document.querySelectorAll(`.meeple[data-key="${meepleKey}"]`).forEach(el => el.remove());
        const meeple = placedMeeples[meepleKey];
        if (meeple) {
            const player = gameState.players.find(p => p.id === meeple.playerId);
            if (player) {
                if (meeple.type === 'Abbot')                                         player.hasAbbot = true;
                else if (meeple.type === 'Large' || meeple.type === 'Large-Farmer') player.hasLargeMeeple = true;
                else if (meeple.type === 'Builder')                                  player.hasBuilder = true;
                else if (meeple.type === 'Pig')                                      player.hasPig = true;
                else if (player.meeples < 7)                                         player.meeples++;
            }
            delete placedMeeples[meepleKey];
        }

        // Retirer les bâtisseurs orphelins
        orphanKeys.forEach(key => {
            const m = placedMeeples[key];
            if (!m) return;
            const p = gameState.players.find(pl => pl.id === m.playerId);
            if (p) p.hasBuilder = true;
            delete placedMeeples[key];
            document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
        });

        // L'hôte met aussi à jour undoManager pour que l'undo fonctionne côté hôte
        if (isHost && undoManager) {
            undoManager.meeplePlacedThisTurn = true;
            undoManager.lastMeeplePlaced     = null;
        }

        eventBus.emit('meeple-count-updated', {});
        eventBus.emit('score-updated');
    });

    // ✨ NOUVEAU — Extension Tour : pose d'étage et capture reçues du réseau (invités)
    eventBus.on('network-tower-floor-placed', (data) => {
        applyFloorPlaced(data.x, data.y, data.height, data.playerId, data.towerPieces);
    });
    eventBus.on('network-tower-capture-executed', (data) => {
        applyCaptureExecuted(data.meepleKey);
        eventBus.emit('score-updated');
    });
}
