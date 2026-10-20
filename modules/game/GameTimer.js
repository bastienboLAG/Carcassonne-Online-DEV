/**
 * GameTimer — Gestion du chronomètre de partie
 */

let _timerInterval = null;
let _timerStart    = null;
// ✅ FIX : instant d'arrêt du chrono. Auparavant stopGameTimer() ne faisait que couper l'intervalle :
// getElapsedSeconds() continuait de croître après la fin de la partie, donc un joueur qui revenait
// après l'écran des scores recevait une durée fausse (full-state-sync → timerElapsed).
let _timerEnd      = null;

function _updateEls(text) {
    ['game-timer', 'mobile-game-timer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    });
}

function _showEls() {
    ['game-timer', 'mobile-game-timer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
    });
}

function _format(elapsed) {
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    return h > 0
        ? `⏱ ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
        : `⏱ ${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function _startInterval() {
    clearInterval(_timerInterval);
    _timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - _timerStart) / 1000);
        _updateEls(_format(elapsed));
    }, 1000);
}

export function startGameTimer() {
    _timerStart = Date.now();
    _timerEnd   = null;
    _showEls();
    _startInterval();
}

export function startGameTimerFrom(elapsedSeconds) {
    _timerStart = Date.now() - (elapsedSeconds * 1000);
    _timerEnd   = null;
    _showEls();
    // ✨ NOUVEAU : afficher tout de suite la durée (sinon le texte reste vide/périmé jusqu'au premier
    // tick, et la modale des scores finaux restaurée à la reconnexion lirait une durée fausse)
    _updateEls(_format(Math.floor(elapsedSeconds)));
    _startInterval();
}

export function stopGameTimer() {
    clearInterval(_timerInterval);
    _timerInterval = null;
    if (_timerStart && _timerEnd === null) _timerEnd = Date.now(); // ✅ FIX : fige la durée
}

/** Retourne le nombre de secondes écoulées depuis le début (figé après l'arrêt), ou 0 si pas démarré */
export function getElapsedSeconds() {
    return _timerStart ? Math.floor(((_timerEnd ?? Date.now()) - _timerStart) / 1000) : 0;
}
