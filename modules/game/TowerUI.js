/**
 * TowerUI — UI et orchestration de l'extension Tour
 *
 * Dépendances injectées via init() :
 *   getGameState()      → GameState
 *   getGameConfig()     → gameConfig
 *   getMultiplayer()    → multiplayer
 *   getGameSync()       → gameSync
 *   getTowerRules()     → towerRules
 *   getZoneMerger()     → zoneMerger
 *   getPlacedMeeples()  → placedMeeples (objet partagé par référence)
 *   getPlateau()        → plateau
 *   getUndoManager()    → undoManager
 *   getIsHost()         → boolean
 *   getIsMyTurn()       → boolean
 *   onUpdateTurnDisplay() → callback
 */

let _deps = null;

function gs()   { return _deps.getGameState(); }
function cfg()  { return _deps.getGameConfig(); }
function mp()   { return _deps.getMultiplayer(); }
function sync() { return _deps.getGameSync(); }
function tr()   { return _deps.getTowerRules(); }

export function initTowerUI(deps) {
    _deps = deps;
}

// ── Helpers tuile ──────────────────────────────────────────────────────────

export function tileHasTowerZone(tileData) {
    return tileData?.zones?.some(z => z.type === 'tower') ?? false;
}

// ── Curseurs de pose d'étage ─────────────────────────────────────────────

export function clearTowerCursors() {
    document.querySelectorAll('.tower-floor-cursor-overlay, .tower-capture-cursor-overlay').forEach(el => el.remove());
}

/**
 * Affiche un curseur "poser un étage" sur chaque tuile tower éligible du plateau,
 * uniquement pour le joueur actif, s'il lui reste des pièces et n'a pas encore
 * utilisé sa phase meeple ce tour-ci.
 */
export function showTowerCursors() {
    const gameConfig = cfg();
    if (!gameConfig?.tileGroups?.tower || !gameConfig?.extensions?.tower) return;
    if (!_deps.getIsMyTurn()) return;

    const undoManager = _deps.getUndoManager();
    if (undoManager?.meeplePlacedThisTurn) return;

    const gameState  = gs();
    const player     = gameState.players.find(p => p.id === mp().playerId);
    if (!player || (player.towerPieces ?? 0) <= 0) return;

    const towerRules = tr();
    if (!towerRules) return;

    const eligible = towerRules.getEligibleTowerTiles();
    if (eligible.length === 0) return;

    const zoneMerger = _deps.getZoneMerger();
    const plateau    = _deps.getPlateau();
    const boardEl    = document.getElementById('board');
    if (!boardEl) return;

    eligible.forEach(({ x, y, zoneIndex }) => {
        const tile = plateau.placedTiles[`${x},${y}`];
        const zone = tile?.zones?.[zoneIndex];
        if (!zone || zone.meeplePosition == null) return;

        const rawPos = Array.isArray(zone.meeplePosition) ? zone.meeplePosition[0] : zone.meeplePosition;
        const pos    = zoneMerger ? zoneMerger._rotatePosition(rawPos, tile.rotation) : Number(rawPos);
        const row    = Math.floor((pos - 1) / 5);
        const col    = (pos - 1) % 5;
        const offsetX = 20.8 + col * 41.6;
        const offsetY = 20.8 + row * 41.6;

        const overlay = document.createElement('div');
        overlay.className = 'tower-floor-cursor-overlay';
        overlay.style.cssText = `grid-column:${x};grid-row:${y};position:relative;width:208px;height:208px;pointer-events:none;z-index:101;`;

        const btn = document.createElement('div');
        btn.className = 'tower-floor-cursor';
        btn.style.cssText = `position:absolute;left:${offsetX}px;top:${offsetY}px;width:38px;height:38px;border-radius:50%;border:3px solid #8e44ad;box-shadow:0 0 10px 3px rgba(142,68,173,0.7),inset 0 0 4px rgba(0,0,0,0.8);cursor:pointer;pointer-events:auto;transform:translate(-50%,-50%);animation:abbeRecallPulse 1.2s ease-in-out infinite;`;
        btn.title = 'Poser un étage de tour';

        btn.addEventListener('click', (e) => { e.stopPropagation(); onTowerFloorConfirm(x, y); });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); onTowerFloorConfirm(x, y); }, { passive: false });

        overlay.appendChild(btn);
        boardEl.appendChild(overlay);
    });
}

// ── Pose d'étage ───────────────────────────────────────────────────────────

export function onTowerFloorConfirm(x, y) {
    clearTowerCursors();
    if (_deps.getIsHost()) {
        executeAddFloorHost(x, y, mp().playerId);
    } else {
        const hostConn = sync()?.multiplayer?.connections?.[0];
        if (hostConn?.open) {
            hostConn.send({ type: 'tower-floor-request', x, y, playerId: mp().playerId });
        }
    }
}

/**
 * [HÔTE] Applique la pose d'étage, calcule les cibles, broadcast à tous.
 */
export function executeAddFloorHost(x, y, playerId) {
    const towerRules = tr();
    const newHeight = towerRules.addFloor(x, y, playerId);
    if (newHeight === -1) return;

    const gameState = gs();
    const player = gameState.players.find(p => p.id === playerId);
    const towerPieces = player?.towerPieces ?? 0;

    applyFloorPlaced(x, y, newHeight, playerId, towerPieces);

    if (sync()) {
        sync().syncTowerFloorPlaced(x, y, newHeight, playerId, towerPieces);
    }
}

/**
 * Applique localement une pose d'étage reçue du réseau (ou en solo).
 * Rendu visuel + calcul des cibles de capture pour le joueur qui vient de poser l'étage.
 */
export function applyFloorPlaced(x, y, height, playerId, towerPieces) {
    const gameState = gs();
    const key = `${x},${y}`;
    if (!gameState.towers[key]) gameState.towers[key] = { height: 0, lockedBy: null, contributions: {} };
    gameState.towers[key].height = height;

    const player = gameState.players.find(p => p.id === playerId);
    if (player) player.towerPieces = towerPieces;

    renderTowerHeight(x, y, height);

    // Le joueur qui vient de poser l'étage calcule localement ses cibles de capture
    if (playerId === mp().playerId) {
        const undoManager = _deps.getUndoManager();
        if (undoManager) undoManager.markMeeplePlaced(x, y, -1, null); // consomme la phase meeple

        const towerRules = tr();
        const targets = towerRules.getCaptureTargets(x, y, _deps.getPlacedMeeples());
        if (targets.length > 0) {
            gameState._pendingTowerCapture = { x, y, targets: targets.map(t => t.key) };
            showTowerCaptureCursors(targets);
        }
        _deps.onUpdateTurnDisplay();
    }
}

/**
 * Rendu visuel de la tour à la hauteur donnée.
 * Utilise les assets ./assets/Meeples/TowerXX.png (01 à 10).
 */
export function renderTowerHeight(x, y, height) {
    const boardEl = document.getElementById('board');
    if (!boardEl || height <= 0) return;

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

    container.querySelector('.tower-piece')?.remove();

    const clampedHeight = Math.min(height, 10);
    const img = document.createElement('img');
    img.className = 'tower-piece';
    img.src = `./assets/Meeples/Tower${String(clampedHeight).padStart(2, '0')}.png`;
    img.style.position  = 'absolute';
    img.style.left      = '104px';
    img.style.top       = '104px';
    img.style.transform = 'translate(-50%, -50%)';
    img.style.width     = '90px';
    img.style.height    = 'auto';
    img.style.zIndex    = '55';
    img.style.opacity   = '0.85'; // légère transparence pour limiter le masquage du plateau
    img.style.pointerEvents = 'none';

    container.appendChild(img);
}

// ── Capture ──────────────────────────────────────────────────────────────

/**
 * Affiche un curseur (même style que les abbés récupérables) sur chaque meeple capturable.
 */
export function showTowerCaptureCursors(targets) {
    const boardEl = document.getElementById('board');
    if (!boardEl) return;

    targets.forEach(({ key }) => {
        const parts = key.split(',');
        const mx = Number(parts[0]), my = Number(parts[1]), mp2 = Number(parts[2]);
        const row = Math.floor((mp2 - 1) / 5);
        const col = (mp2 - 1) % 5;
        const offsetX = 20.8 + col * 41.6;
        const offsetY = 20.8 + row * 41.6;

        const overlay = document.createElement('div');
        overlay.className = 'tower-capture-cursor-overlay';
        overlay.style.cssText = `grid-column:${mx};grid-row:${my};position:relative;width:208px;height:208px;pointer-events:none;z-index:102;`;

        const btn = document.createElement('div');
        btn.className = 'tower-capture-cursor';
        btn.style.cssText = `position:absolute;left:${offsetX}px;top:${offsetY}px;width:32px;height:32px;border-radius:50%;border:3px solid rgb(200,0,175);box-shadow:0 0 8px 2px rgba(200,0,175,0.7),inset 0 0 4px rgba(0,0,0,0.8);cursor:pointer;pointer-events:auto;transform:translate(-50%,-50%);animation:abbeRecallPulse 1.2s ease-in-out infinite;`;
        btn.title = 'Capturer ce meeple';

        btn.addEventListener('click', (e) => { e.stopPropagation(); handleTowerCapture(key); });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); handleTowerCapture(key); }, { passive: false });

        overlay.appendChild(btn);
        boardEl.appendChild(overlay);
    });
}

/**
 * Ré-affiche les curseurs de capture en attente (ex: après un rafraîchissement d'UI),
 * en reconstruisant les cibles depuis gameState._pendingTowerCapture.
 */
export function showPendingTowerCaptureIfAny() {
    const gameState = gs();
    const pending = gameState._pendingTowerCapture;
    if (!pending) return;

    const placedMeeples = _deps.getPlacedMeeples();
    const targets = pending.targets
        .map(key => ({ key, meeple: placedMeeples[key] }))
        .filter(t => t.meeple);

    if (targets.length === 0) { gameState._pendingTowerCapture = null; return; }
    showTowerCaptureCursors(targets);
}

export function handleTowerCapture(meepleKey) {
    clearTowerCursors();
    const gameState = gs();
    gameState._pendingTowerCapture = null;

    if (_deps.getIsHost()) {
        executeTowerCaptureHost(meepleKey, mp().playerId);
    } else {
        const hostConn = sync()?.multiplayer?.connections?.[0];
        if (hostConn?.open) {
            hostConn.send({ type: 'tower-capture-request', meepleKey, playerId: mp().playerId });
        }
    }
}

/**
 * [HÔTE] Exécute la capture, broadcast à tous.
 */
export function executeTowerCaptureHost(meepleKey, playerId) {
    const towerRules = tr();
    const result = towerRules.executeCapture(meepleKey, playerId, _deps.getPlacedMeeples());
    if (!result) return;

    if (sync()) {
        sync().syncTowerCaptureExecuted(meepleKey, playerId, result.selfCapture);
    } else {
        applyCaptureExecuted(meepleKey);
    }
    _deps.onUpdateTurnDisplay();
}

/**
 * Applique localement le retrait visuel d'un meeple capturé (reçu du réseau ou en solo).
 */
export function applyCaptureExecuted(meepleKey) {
    document.querySelectorAll(`.meeple[data-key="${meepleKey}"]`).forEach(el => el.remove());
    clearTowerCursors();
}
