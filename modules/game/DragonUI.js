/**
 * DragonUI — UI et orchestration des extensions Dragon, Fée, Princesse
 *
 * Dépendances injectées via init() :
 *   getGameState()      → GameState
 *   getGameConfig()     → gameConfig
 *   getMultiplayer()    → multiplayer
 *   getGameSync()       → gameSync
 *   getDragonRules()    → dragonRules
 *   getUndoManager()    → undoManager
 *   getZoneMerger()     → zoneMerger
 *   getPlacedMeeples()  → placedMeeples (objet partagé par référence)
 *   getMeepleSelectorUI() → meepleSelectorUI
 *   getDeck()           → deck
 *   getTurnManager()    → turnManager
 *   getFinalScoresManager() → finalScoresManager
 *   getIsHost()         → boolean
 *   getMeepleSize()     → fonction(type, style)
 *   onUpdateTurnDisplay() → callback
 *   onHostDrawAndSend() → callback → tile | null
 */

let _deps = null;

function gs()   { return _deps.getGameState(); }
function cfg()  { return _deps.getGameConfig(); }
function mp()   { return _deps.getMultiplayer(); }
function sync() { return _deps.getGameSync(); }

// ── Helpers tuile ──────────────────────────────────────────────────────────

export function tileHasDragonZone(tileData) {
    return tileData?.zones?.some(z => z.type === 'dragon') ?? false;
}

export function tileHasVolcanoZone(tileData) {
    return tileData?.zones?.some(z => z.type === 'volcano') ?? false;
}

export function tileHasPortalZone(tileData) {
    return tileData?.zones?.some(z => z.type === 'portal') ?? false;
}

// ── Réseau ─────────────────────────────────────────────────────────────────

export function broadcastDragonState(eatenKeys = []) {
    if (!sync()) return;
    mp().broadcast({
        type: 'dragon-state-update',
        dragonPos:   gs().dragonPos,
        dragonPhase: gs().dragonPhase,
        fairyState:  gs().fairyState,
        eatenKeys,
        players: gs().players.map(p => ({
            id: p.id, meeples: p.meeples, hasAbbot: p.hasAbbot,
            hasLargeMeeple: p.hasLargeMeeple, hasBuilder: p.hasBuilder,
            hasPig: p.hasPig, score: p.score
        }))
    });
}

// ── Overlay phase dragon ───────────────────────────────────────────────────

export function updateDragonOverlay() {
    const phase = gs().dragonPhase;
    if (!phase.active) {
        const overlay = document.getElementById('dragon-phase-overlay');
        if (overlay) overlay.style.display = 'none';
        return;
    }
    const mover = gs().players[phase.moverIndex];
    let overlay = document.getElementById('dragon-phase-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dragon-phase-overlay';
        overlay.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);' +
            'background:rgba(180,30,30,0.92);color:#fff;padding:8px 20px;border-radius:8px;' +
            'font-weight:bold;z-index:1000;pointer-events:none;text-align:center;';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';
    const isMyDragonTurn = mover?.id === mp().playerId;
    if (isMyDragonTurn) {
        overlay.textContent = `🐉 À vous de déplacer le dragon ! (${phase.movesRemaining} déplacements restants)`;
    } else {
        overlay.textContent = `🐉 ${mover?.name ?? '?'} déplace le dragon… (${phase.movesRemaining} restants)`;
    }
}

// ── Curseurs déplacement dragon ────────────────────────────────────────────

export function clearDragonCursors() {
    document.querySelectorAll('.dragon-move-cursor, .dragon-move-cursor-overlay').forEach(el => el.remove());
    clearDragonVisitedOverlays();
}

export function clearDragonVisitedOverlays() {
    document.querySelectorAll('.dragon-visited-overlay').forEach(el => el.remove());
}

/**
 * Affiche un overlay rouge + 🐾 sur chaque tuile déjà visitée par le dragon
 * (sauf la position actuelle du dragon — il peut encore la quitter).
 */
export function showDragonVisitedTiles(visitedTiles, currentPos) {
    clearDragonVisitedOverlays();
    const boardEl = document.getElementById('board');
    if (!boardEl || !visitedTiles?.length) return;

    // Toutes les tuiles visitées sauf la position actuelle du dragon
    const overlays = visitedTiles.filter(([vx, vy]) =>
        !(currentPos && vx === currentPos.x && vy === currentPos.y)
    );

    overlays.forEach(([x, y]) => {
        const overlay = document.createElement('div');
        overlay.className = 'dragon-visited-overlay';
        overlay.style.cssText = [
            'position:relative',
            'pointer-events:none',
            'z-index:90',
            `grid-column:${x}`,
            `grid-row:${y}`,
            'width:208px',
            'height:208px',
            'background:rgba(180,0,0,0.45)',
            'display:flex',
            'align-items:center',
            'justify-content:center',
        ].join(';');

        const paw = document.createElement('span');
        paw.textContent = '🐾';
        paw.style.cssText = 'font-size:120px;line-height:1;pointer-events:none;';
        overlay.appendChild(paw);
        boardEl.appendChild(overlay);
    });
}

export function showDragonMoveCursors(validMoves) {
    clearDragonCursors();
    const boardEl = document.getElementById('board');
    if (!boardEl) return;

    const pos = 13;
    const row = Math.floor((pos - 1) / 5);
    const col = (pos - 1) % 5;
    const offsetX = 20.8 + col * 41.6;
    const offsetY = 20.8 + row * 41.6;

    validMoves.forEach(({ x, y }) => {
        const overlay = document.createElement('div');
        overlay.className = 'dragon-move-cursor-overlay';
        overlay.style.cssText = `grid-column:${x};grid-row:${y};position:relative;` +
            'width:208px;height:208px;pointer-events:none;z-index:101;';

        const btn = document.createElement('div');
        btn.className = 'dragon-move-cursor';
        btn.dataset.dx = x;
        btn.dataset.dy = y;
        btn.style.cssText = `position:absolute;left:${offsetX}px;top:${offsetY}px;` +
            'width:42px;height:42px;border-radius:50%;' +
            'border:3px solid #c83200;box-shadow:0 0 10px 3px rgba(200,50,0,0.7);' +
            'background:rgba(200,50,0,0.25);cursor:pointer;pointer-events:auto;' +
            'transform:translate(-50%,-50%);display:flex;align-items:center;' +
            'justify-content:center;font-size:22px;animation:abbeRecallPulse 1.2s ease-in-out infinite;';
        btn.textContent = '🐉';

        const openSelector = (clientX, clientY) => {
            const meepleSelectorUI = _deps.getMeepleSelectorUI();
            if (!meepleSelectorUI) { onDragonMoveConfirm(x, y); return; }
            meepleSelectorUI.show(x, y, pos, 'dragon-move', clientX, clientY,
                (_sx, _sy, _spos, meepleType) => {
                    if (meepleType === 'Dragon') onDragonMoveConfirm(x, y);
                }
            );
        };

        btn.addEventListener('click', (e) => { e.stopPropagation(); openSelector(e.clientX, e.clientY); });
        btn.addEventListener('touchend', (e) => {
            e.preventDefault(); e.stopPropagation();
            openSelector(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
        }, { passive: false });

        overlay.appendChild(btn);
        boardEl.appendChild(overlay);
    });
}

// ── Tour dragon UI ─────────────────────────────────────────────────────────

export function startDragonTurnUI() {
    const phase = gs().dragonPhase;
    console.log('🐉 [startDragonTurnUI] phase.active:', phase.active, '| moverIndex:', phase.moverIndex, '| movesRemaining:', phase.movesRemaining);
    if (!phase.active) return;

    // Effacer tout toast actif (ex: toast du tour bonus bâtisseur)
    if (_deps.hideToast) _deps.hideToast();

    const mover = gs().players[phase.moverIndex];
    const isMyDragonTurn = mover?.id === mp().playerId;
    console.log('🐉 [startDragonTurnUI] mover:', mover?.name, '| isMyDragonTurn:', isMyDragonTurn, '| dragonPos:', JSON.stringify(gs().dragonPos));

    updateDragonOverlay();
    _deps.onUpdateTurnDisplay();

    const dragonRules = _deps.getDragonRules();
    if (isMyDragonTurn && dragonRules) {
        const validMoves = dragonRules.getValidDragonMoves();
        console.log('🐉 [startDragonTurnUI] validMoves:', JSON.stringify(validMoves));
        if (validMoves.length === 0) {
            const undoManager = _deps.getUndoManager();
            if (undoManager) undoManager.dragonMovePlacedThisTurn = true;
            updateDragonOverlay();
            _deps.onUpdateTurnDisplay();
        } else {
            showDragonMoveCursors(validMoves);
        }
    }

    // Toujours afficher APRÈS showDragonMoveCursors (qui appelle clearDragonCursors en interne)
    showDragonVisitedTiles(phase.visitedTiles, gs().dragonPos);
}

// ── Déplacement dragon ─────────────────────────────────────────────────────

export function onDragonMoveConfirm(x, y) {
    const dragonRules = _deps.getDragonRules();
    if (!dragonRules || !gs().dragonPhase.active) return;
    const mover = gs().players[gs().dragonPhase.moverIndex];
    if (mover?.id !== mp().playerId) return;

    clearDragonCursors();

    if (_deps.getIsHost()) {
        executeDragonMoveHost(x, y);
    } else {
        const hostConn = sync()?.getHostConnection?.() ?? sync()?.multiplayer?.connections?.[0];
        if (hostConn?.open) {
            hostConn.send({ type: 'dragon-move-request', x, y, playerId: mp().playerId });
        }
    }
}

export function executeDragonMoveHost(x, y) {
    const undoManager    = _deps.getUndoManager();
    const dragonRules    = _deps.getDragonRules();
    const zoneMerger     = _deps.getZoneMerger();
    const placedMeeples  = _deps.getPlacedMeeples();

    if (undoManager) undoManager.saveDragonMove(placedMeeples);

    const { eaten, blocked } = dragonRules.executeDragonMove(x, y);

    eaten.forEach(({ key }) => {
        // ✅ FIX : un garde verrouillant une tour n'est pas dans placedMeeples — sa clé
        // spéciale "tower-lock:x,y" (posée par DragonRules._eatMeeplesAt) désigne le pion
        // visuel .tower-lock-meeple du conteneur de cette tuile, pas un .meeple[data-key].
        // La mutation d'état (déverrouillage) est déjà faite côté DragonRules ; ici on ne
        // retire que le rendu visuel.
        if (key.startsWith('tower-lock:')) {
            const coords = key.slice('tower-lock:'.length);
            document.querySelector(`.meeple-container[data-pos="${coords}"] .tower-lock-meeple`)?.remove();
            return;
        }
        document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
        releaseFairyIfDetached(key);
    });

    // Fix 5 — Builder/Cochon orphelins
    if (eaten.length > 0 && zoneMerger) {
        const orphanKeys = [];
        for (const [key, meeple] of Object.entries(placedMeeples)) {
            if (meeple.type !== 'Builder' && meeple.type !== 'Pig') continue;
            const parts = key.split(',');
            const bx = Number(parts[0]), by = Number(parts[1]), bp = Number(parts[2]);
            const zoneId = zoneMerger.findMergedZoneForPosition(bx, by, bp)?.id;
            if (zoneId == null) continue;
            const hasNormalMeeple = Object.entries(placedMeeples).some(([k2, m2]) => {
                if (k2 === key) return false;
                if (m2.playerId !== meeple.playerId) return false;
                if (m2.type === 'Builder' || m2.type === 'Pig') return false;
                const [x2, y2, p2] = k2.split(',').map(Number);
                return zoneMerger.findMergedZoneForPosition(x2, y2, p2)?.id === zoneId;
            });
            if (!hasNormalMeeple) orphanKeys.push(key);
        }
        orphanKeys.forEach(key => {
            const meeple = placedMeeples[key];
            const player = gs().players.find(p => p.id === meeple.playerId);
            if (player) {
                if (meeple.type === 'Builder') player.hasBuilder = true;
                else if (meeple.type === 'Pig') player.hasPig = true;
            }
            delete placedMeeples[key];
            document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
            eaten.push({ key, meeple });
            console.log(`🐉 [Fix5] Builder/Cochon orphelin rendu: ${key}`);
        });
    }

    broadcastDragonState(eaten.map(e => e.key));

    if (!gs().dragonPhase.active) {
        onDragonPhaseEnded();
    } else {
        clearDragonCursors();
        showDragonVisitedTiles(gs().dragonPhase.visitedTiles, gs().dragonPos);
        updateDragonOverlay();
        _deps.onUpdateTurnDisplay();
    }
}

export function onDragonPhaseEnded() {
    clearDragonCursors();
    updateDragonOverlay();

    if (!_deps.getIsHost()) return;

    const deck = _deps.getDeck();
    if (deck.remaining() <= 0) {
        if (sync()) sync().syncTurnEnd();
        _deps.getFinalScoresManager().computeAndApply(_deps.getPlacedMeeples());
        return;
    }
    const turnManager = _deps.getTurnManager();
    const builderBonus = !!gs()._pendingBuilderBonus;
    gs()._pendingBuilderBonus = false;

    if (builderBonus) {
        // Tour bonus bâtisseur acquis avant la phase dragon — le déclencher maintenant
        if (turnManager) turnManager.endTurnRemote(true);
        const _bonusTile = _deps.onHostDrawAndSend();
        if (_bonusTile && turnManager) turnManager.receiveYourTurn(_bonusTile.id);
        if (sync()) sync().syncTurnEnd(true, _bonusTile?.id ?? null);
        _deps.getRuleRegistry?.()?.rules?.get('builders')?.resetLastPlacedTile?.();
        _deps.afficherToast?.('⭐ Tour bonus ! Votre bâtisseur vous offre un tour supplémentaire.', 'bonus');
    } else {
        if (turnManager) turnManager.endTurnRemote(false);
        const _nextTile = _deps.onHostDrawAndSend();
        if (_nextTile && turnManager) turnManager.receiveYourTurn(_nextTile.id);
        if (sync()) sync().syncTurnEnd(false, _nextTile?.id ?? null);
    }
    _deps.onUpdateTurnDisplay();
}

export function advanceDragonTurnHost() {
    const dragonRules = _deps.getDragonRules();
    if (!dragonRules || !gs().dragonPhase.active) return;

    const undoManager = _deps.getUndoManager();
    if (undoManager) { undoManager.dragonMoveSnapshot = null; undoManager.dragonMovePlacedThisTurn = false; }

    if (gs().dragonPhase.movesRemaining <= 0) {
        gs().endDragonPhase();
        broadcastDragonState();
        onDragonPhaseEnded();
        return;
    }

    const activePlayers = gs().players.filter(p =>
        p.color !== 'spectator' && !p.disconnected && !p.kicked
    ).length;

    for (let attempts = 0; attempts < activePlayers; attempts++) {
        gs().advanceDragonMover();
        const validMoves = dragonRules.getValidDragonMoves();
        if (validMoves.length > 0) {
            broadcastDragonState();
            startDragonTurnUI();
            _deps.onUpdateTurnDisplay();
            return;
        }
        console.log(`🐉 [Dragon] ${gs().players[gs().dragonPhase.moverIndex]?.name} bloqué, tour sauté`);
    }

    gs().endDragonPhase();
    broadcastDragonState();
    onDragonPhaseEnded();
}

// ── Rendu pion Dragon ──────────────────────────────────────────────────────

export function renderDragonPiece(x, y) {
    if (x == null || y == null) return;
    const boardEl = document.getElementById('board');
    if (!boardEl) return;

    const existing = document.getElementById('dragon-piece');
    if (existing) existing.remove();

    let container = boardEl.querySelector(`.meeple-container[data-pos="${x},${y}"]`);
    if (!container) {
        container = document.createElement('div');
        container.className = 'meeple-container';
        container.dataset.pos = `${x},${y}`;
        container.style.gridColumn = x;
        container.style.gridRow    = y;
        container.style.position   = 'relative';
        container.style.width      = '208px';
        container.style.height     = '208px';
        container.style.pointerEvents = 'none';
        container.style.zIndex     = '50';
        boardEl.appendChild(container);
    }

    const img = document.createElement('img');
    img.id  = 'dragon-piece';
    img.src = './assets/Meeples/Dragon.png';
    img.style.position  = 'absolute';
    img.style.left      = '104px';
    img.style.top       = '104px';
    img.style.transform = 'translate(-50%, -50%)';
    const { width: dw, height: dh } = _deps.getMeepleSize('Dragon', 'plate');
    img.style.width     = dw;
    img.style.height    = dh;
    img.style.zIndex    = '60';
    img.style.pointerEvents = 'none';

    container.appendChild(img);
}

// ── Rendu pion Fée ─────────────────────────────────────────────────────────

export function renderFairyPiece(meepleKey) {
    removeFairyPiece();
    if (!meepleKey) return;

    const boardEl = document.getElementById('board');
    if (!boardEl) return;

    const parts = meepleKey.split(',');
    const mx = Number(parts[0]);
    const my = Number(parts[1]);
    const pos = Number(parts[2]);

    const row = Math.floor((pos - 1) / 5);
    const col = (pos - 1) % 5;
    const baseX = 20.8 + col * 41.6;
    const baseY = 20.8 + row * 41.6;
    const fairyX = baseX - 18;
    const fairyY = baseY - 20;

    let container = boardEl.querySelector(`.meeple-container[data-pos="${mx},${my}"]`);
    if (!container) {
        container = document.createElement('div');
        container.className = 'meeple-container';
        container.dataset.pos = `${mx},${my}`;
        container.style.gridColumn = mx;
        container.style.gridRow    = my;
        container.style.position   = 'relative';
        container.style.width      = '208px';
        container.style.height     = '208px';
        container.style.pointerEvents = 'none';
        container.style.zIndex     = '50';
        boardEl.appendChild(container);
    }

    const img = document.createElement('img');
    img.id  = 'fairy-piece';
    img.src = './assets/Meeples/Fairy.png';
    img.style.position  = 'absolute';
    img.style.left      = `${fairyX}px`;
    img.style.top       = `${fairyY}px`;
    img.style.transform = 'translate(-50%, -50%)';
    img.style.width     = '39px';
    img.style.height    = '62px';
    img.style.zIndex    = '61';
    img.style.pointerEvents = 'none';

    container.appendChild(img);
}

export function removeFairyPiece() {
    document.getElementById('fairy-piece')?.remove();
}

export function releaseFairyIfDetached(removedKey) {
    const gameState = gs();
    if (!gameState.fairyState) return;
    if (gameState.fairyState.meepleKey !== removedKey) return;
    gameState.fairyState.ownerId = null;
    gameState.players.forEach(p => { p.hasFairy = false; });
}

// ── Init ───────────────────────────────────────────────────────────────────

export function initDragonUI(deps) {
    _deps = deps;
}
