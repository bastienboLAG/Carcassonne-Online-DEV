/**
 * TurnUI — Affichage du tour, boutons, mobile, toasts
 *
 * Dépendances injectées via initTurnUI() :
 *   getGameState()          → GameState | null
 *   getGameConfig()         → gameConfig | null
 *   getMultiplayer()        → multiplayer
 *   getTurnManager()        → turnManager | null
 *   getUndoManager()        → undoManager | null
 *   getFinalScoresManager() → finalScoresManager | null
 *   getScorePanelUI()       → scorePanelUI | null
 *   getDeck()               → deck | null
 *   getIsHost()             → boolean
 *   getIsMyTurn()           → boolean
 *   setIsMyTurn(v)          → void
 *   getIsSpectator()        → boolean
 *   getWaitingToRedraw()    → boolean
 *   getTuilePosee()         → boolean
 *   getTuileEnMain()        → Tile | null
 *   getEventBus()           → EventBus
 *   isMobile()              → boolean
 */

let _deps = null;

export function initTurnUI(deps) {
    _deps = deps;
}

// ── Helpers internes ───────────────────────────────────────────────────────

function _gs()  { return _deps.getGameState(); }
function _cfg() { return _deps.getGameConfig(); }
function _mp()  { return _deps.getMultiplayer(); }

function _isDragonPhase() {
    return !!(_cfg()?.extensions?.dragon && _gs()?.dragonPhase?.active);
}

function _dragonMover() {
    if (!_isDragonPhase()) return null;
    return _gs().players[_gs().dragonPhase.moverIndex];
}

function _isMyDragonTurn() {
    const mover = _dragonMover();
    return !!(_isDragonPhase() && mover?.id === _mp().playerId);
}

// ── Mobile bonus style ─────────────────────────────────────────────────────

function _updateMobileActiveBonusStyle(isBonusTurn, isDragonTurn = false) {
    if (!_deps.isMobile()) return;
    const currentPlayer = _gs()?.getCurrentPlayer();
    if (!currentPlayer) return;
    document.querySelectorAll('.mobile-player-card').forEach(card => {
        card.classList.remove('active-bonus', 'active-dragon');
        if (card.dataset.playerId === currentPlayer.id) {
            if (isDragonTurn)     card.classList.add('active-dragon');
            else if (isBonusTurn) card.classList.add('active-bonus');
        }
    });
}

// ── Preview tuile mobile ───────────────────────────────────────────────────

export function updateMobileTilePreview() {
    if (!_deps.isMobile()) return;
    const preview = document.getElementById('mobile-tile-preview');
    const counter = document.getElementById('mobile-tile-counter');
    if (!preview) return;

    const tuileEnMain     = _deps.getTuileEnMain();
    const tilePreviewUI   = _deps.getTilePreviewUI();
    const isBackside      = tilePreviewUI?.isShowingBackside ?? false;

    if (tuileEnMain && !isBackside) {
        preview.innerHTML = `<img id="mobile-tile-img" src="${tuileEnMain.imagePath}" style="transform: rotate(${tuileEnMain.rotation}deg);">`;
    } else {
        preview.innerHTML = '<img src="./assets/verso.png">';
    }

    const deck = _deps.getDeck();
    if (counter && deck) {
        counter.textContent = `${deck.remaining()} / ${deck.total()}`;
    }
}

// ── Boutons mobile ─────────────────────────────────────────────────────────

export function updateMobileButtons() {
    if (!_deps.isMobile()) return;

    const endBtn  = document.getElementById('mobile-end-turn-btn');
    const undoBtn = document.getElementById('mobile-undo-btn');
    const finalScoresManager = _deps.getFinalScoresManager();
    const undoManager        = _deps.getUndoManager();
    const isMyTurn           = _deps.getIsMyTurn();
    const tuilePosee         = _deps.getTuilePosee();
    const waitingToRedraw    = _deps.getWaitingToRedraw();

    if (endBtn) {
        if (finalScoresManager?.gameEnded) {
            endBtn.textContent = '📊 Scores';
            endBtn.disabled = false;
        } else if (waitingToRedraw && isMyTurn) {
            endBtn.textContent = '🎲 Repiocher';
            endBtn.disabled = false;
        } else {
            endBtn.textContent = 'Terminer mon tour';
            const isDragonPhase = _isDragonPhase();
            const canEnd = isMyTurn && tuilePosee && !isDragonPhase ||
                           _isMyDragonTurn() && !!undoManager?.dragonMovePlacedThisTurn;
            endBtn.disabled = !canEnd;
        }
        endBtn.style.opacity = endBtn.disabled ? '0.4' : '1';
    }

    if (undoBtn) {
        const isDragonPhase = _isDragonPhase();
        const canUndo = !finalScoresManager?.gameEnded && (
            _isMyDragonTurn() && !!undoManager?.dragonMovePlacedThisTurn ||
            !isDragonPhase && _deps.getIsMyTurn() &&
                (_deps.getIsHost() ? !!undoManager?.canUndo() : !!tuilePosee)
        );
        undoBtn.disabled = !canUndo;
        undoBtn.style.opacity = canUndo ? '1' : '0.4';
    }
}

// ── updateTurnDisplay ──────────────────────────────────────────────────────

export function updateTurnDisplay() {
    const gameState = _gs();
    if (!gameState || gameState.players.length === 0) {
        _deps.setIsMyTurn(false);
        const endTurnBtn = document.getElementById('end-turn-btn');
        if (endTurnBtn) {
            endTurnBtn.textContent = 'Terminer mon tour';
            endTurnBtn.disabled = true;
            endTurnBtn.style.opacity    = '0.5';
            endTurnBtn.style.cursor     = 'not-allowed';
            endTurnBtn.style.background = '';
            endTurnBtn.style.color      = '';
        }
        return;
    }

    const currentPlayer = gameState.getCurrentPlayer();
    _deps.setIsMyTurn(currentPlayer.id === _mp().playerId && !_deps.getIsSpectator());
    const isMyTurn = _deps.getIsMyTurn();

    const finalScoresManager = _deps.getFinalScoresManager();
    const undoManager        = _deps.getUndoManager();
    const tuilePosee         = _deps.getTuilePosee();
    const waitingToRedraw    = _deps.getWaitingToRedraw();

    // ✨ NOUVEAU : fin de partie RESTAURÉE (reconnexion après l'écran des scores, via full-state-sync) →
    // ouvrir la modale des scores automatiquement, une seule fois. Les chemins normaux
    // (computeAndApply / receiveFromNetwork) ouvrent eux-mêmes la modale et posent autoModalDone.
    if (finalScoresManager?.gameEnded && !finalScoresManager.autoModalDone) {
        finalScoresManager.autoModalDone = true;
        finalScoresManager.showModal(finalScoresManager.finalScoresData);
    }

    const endTurnBtn = document.getElementById('end-turn-btn');
    if (endTurnBtn) {
        if (finalScoresManager?.gameEnded) {
            endTurnBtn.textContent = '📊 Détails des scores';
            endTurnBtn.disabled   = false;
            endTurnBtn.style.opacity = '1';
            endTurnBtn.style.cursor  = 'pointer';
            endTurnBtn.classList.add('final-score-btn');
        } else if (waitingToRedraw && isMyTurn) {
            endTurnBtn.textContent = '🎲 Repiocher';
            endTurnBtn.disabled   = false;
            endTurnBtn.style.opacity = '1';
            endTurnBtn.style.cursor  = 'pointer';
            endTurnBtn.classList.remove('final-score-btn');
        } else {
            endTurnBtn.textContent = 'Terminer mon tour';
            endTurnBtn.classList.remove('final-score-btn');
            const isDragonPhase = _isDragonPhase();
            const canEnd = isMyTurn && tuilePosee && !isDragonPhase ||
                           _isMyDragonTurn() && !!undoManager?.dragonMovePlacedThisTurn;
            endTurnBtn.disabled = !canEnd;
            endTurnBtn.style.opacity = canEnd ? '1' : '0.5';
            endTurnBtn.style.cursor  = canEnd ? 'pointer' : 'not-allowed';
            endTurnBtn.style.background = canEnd ? '#2ecc71' : '';
            endTurnBtn.style.color      = canEnd ? '#000' : '';
        }
    }

    const undoBtn = document.getElementById('undo-btn');
    if (undoBtn) {
        const isDragonPhase = _isDragonPhase();
        const canUndo = !finalScoresManager?.gameEnded && (
            _isMyDragonTurn() && !!undoManager?.dragonMovePlacedThisTurn ||
            !isDragonPhase && isMyTurn &&
                (_deps.getIsHost() ? !!undoManager?.canUndo() : !!tuilePosee)
        );
        undoBtn.disabled = !canUndo;
        undoBtn.style.opacity    = canUndo ? '1' : '0.5';
        undoBtn.style.cursor     = canUndo ? 'pointer' : 'not-allowed';
        undoBtn.style.background = canUndo ? '#f1c40f' : '';
        undoBtn.style.color      = canUndo ? '#000' : '';
    }

    const scorePanelUI = _deps.getScorePanelUI();
    scorePanelUI?.updateMobile();

    const isBonusTurn  = _deps.getTurnManager()?.isBonusTurn ?? false;
    const isDragonTurn = _isDragonPhase();
    console.log('🐉 [updateTurnDisplay] isDragonTurn:', isDragonTurn, '| dragonPhase.active:', gameState?.dragonPhase?.active, '| isBonusTurn:', isBonusTurn);
    if (scorePanelUI) scorePanelUI.onTurnChanged(isBonusTurn, isDragonTurn);
    _updateMobileActiveBonusStyle(isBonusTurn, isDragonTurn);

    updateMobileButtons();
    _deps.getEventBus().emit('score-updated');

    // Fermer le toast du tour bonus dès qu'il se termine ou qu'une phase dragon démarre
    if (!isBonusTurn || isDragonTurn) {
        const toast = document.getElementById('disconnect-toast');
        if (toast && toast.dataset.isBonusToast === 'true') {
            toast.style.opacity = '0';
            setTimeout(() => { if (toast) toast.style.display = 'none'; }, 400);
            delete toast.dataset.isBonusToast;
        }
    }
}

// ── Messages & Toasts ──────────────────────────────────────────────────────

export function afficherMessage(msg) {
    document.getElementById('tile-preview').innerHTML =
        `<p style="text-align: center; color: white;">${msg}</p>`;
}

export function hideToast() {
    const toast = document.getElementById('disconnect-toast');
    if (!toast || toast.style.display === 'none') return;
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 400);
}

export function afficherToast(msg, type = 'error') {
    const borderColor = type === 'bonus'   ? 'gold'
                      : type === 'success' ? '#2ecc71'
                      : type === 'info'    ? '#3498db'
                      :                      '#e74c3c';
    let toast = document.getElementById('disconnect-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'disconnect-toast';
        document.body.appendChild(toast);
    }
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(30,30,30,0.92);
        color: white;
        padding: 12px 20px 12px 24px;
        border-radius: 10px;
        border-left: 4px solid ${borderColor};
        font-size: 15px;
        font-weight: bold;
        z-index: 9999;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        gap: 16px;
        transition: opacity 0.4s;
    `;

    toast.innerHTML = '';

    const text = document.createElement('span');
    text.textContent = msg;
    toast.appendChild(text);

    const close = document.createElement('span');
    close.textContent = '✕';
    close.style.cssText = `
        cursor: pointer;
        font-size: 14px;
        opacity: 0.7;
        flex-shrink: 0;
    `;
    close.onmouseenter = () => close.style.opacity = '1';
    close.onmouseleave = () => close.style.opacity = '0.7';
    close.onclick = () => {
        toast.style.opacity = '0';
        setTimeout(() => { toast.style.display = 'none'; }, 400);
    };
    toast.appendChild(close);

    toast.style.opacity = '1';
    toast.style.display = 'flex';
}
