/**
 * ScorePanelPreview — ⚠️ PROVISOIRE : aperçu visuel des futurs pions/jetons dans les panneaux joueurs.
 *
 * ✨ NOUVEAU : permet de juger l'agencement (4 rangées, retours à la ligne, compteurs) avant que les
 * extensions concernées n'existent. Actif uniquement avec l'option « Mode debug » du lobby.
 * Purement visuel : ne touche ni gameState, ni le réseau, ni l'undo — les pièces fictives sont
 * injectées au rendu par ScorePanelUI._getPieceExtras().
 *
 * Pour retirer ce fichier : le supprimer, puis retirer dans ScorePanelUI.js l'import,
 * l'appel dans le constructeur/destroy() et la ligne dans _getPieceExtras().
 */

// Pièces à compteur (case « actif » + nombre) et pièces uniques (case seule)
const COUNTED = [
    { key: 'mayor',      label: 'Maire' },
    { key: 'wagon',      label: 'Chariot' },
    { key: 'shepherd',   label: 'Berger' },
    { key: 'ringmaster', label: 'Directeur de cirque' },
    { key: 'barn',       label: 'Grange' },
    { key: 'castle',     label: 'Forteresse' },
    { key: 'bridge',     label: 'Pont' },
    { key: 'sheep',      label: 'Mouton' },
];
const UNIQUE = [
    { key: 'king',      label: 'Roi (1er joueur)' },
    { key: 'robber',    label: 'Brigand (1er joueur)' },
    { key: 'monastery', label: 'Tuile monastère (tous)' },
];

// État conservé entre les parties (module-level)
const _state = { counted: {}, unique: {}, prisoners: 0 };
COUNTED.forEach(({ key }) => { _state.counted[key] = { on: false, count: 1 }; });
UNIQUE.forEach(({ key })  => { _state.unique[key]  = false; });

let _onChange = null;
let _btn = null;
let _panel = null;

function _notify() { if (_onChange) _onChange(); }

function _build() {
    _btn = document.createElement('button');
    _btn.textContent = '🎨';
    _btn.title = 'Aperçu visuel des panneaux joueurs (debug)';
    _btn.style.cssText = 'position:fixed;left:10px;top:56px;z-index:99999;width:40px;height:40px;border-radius:50%;padding:0;font-size:18px;background:#fff;border:1px solid #ccc;';
    document.body.appendChild(_btn);

    _panel = document.createElement('div');
    _panel.style.cssText = 'display:none;position:fixed;left:10px;top:102px;z-index:99999;width:230px;max-height:65vh;overflow:auto;background:#1e2d3d;color:#fff;border:1px solid #455a64;border-radius:8px;padding:10px;font-size:12px;box-shadow:0 4px 20px rgba(0,0,0,0.6);';

    const title = document.createElement('div');
    title.textContent = 'Aperçu panneaux (provisoire)';
    title.style.cssText = 'font-weight:bold;margin-bottom:8px;color:gold;';
    _panel.appendChild(title);

    COUNTED.forEach(({ key, label }) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = _state.counted[key].on;
        cb.onchange = () => { _state.counted[key].on = cb.checked; _notify(); };
        const lab = document.createElement('span');
        lab.textContent = label;
        lab.style.flex = '1';
        const num = document.createElement('input');
        num.type = 'number'; num.min = '0'; num.max = '9';
        num.value = _state.counted[key].count;
        num.style.cssText = 'width:42px;';
        num.onchange = () => {
            _state.counted[key].count = Math.max(0, Math.min(9, parseInt(num.value, 10) || 0));
            _notify();
        };
        row.append(cb, lab, num);
        _panel.appendChild(row);
    });

    UNIQUE.forEach(({ key, label }) => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = _state.unique[key];
        cb.onchange = () => { _state.unique[key] = cb.checked; _notify(); };
        const lab = document.createElement('span');
        lab.textContent = label;
        row.append(cb, lab);
        _panel.appendChild(row);
    });

    const prow = document.createElement('div');
    prow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;';
    const plab = document.createElement('span');
    plab.textContent = 'Prisonniers fictifs';
    plab.style.flex = '1';
    const pnum = document.createElement('input');
    pnum.type = 'number'; pnum.min = '0'; pnum.max = '12';
    pnum.value = _state.prisoners;
    pnum.style.cssText = 'width:42px;';
    pnum.onchange = () => {
        _state.prisoners = Math.max(0, Math.min(12, parseInt(pnum.value, 10) || 0));
        _notify();
    };
    prow.append(plab, pnum);
    _panel.appendChild(prow);

    document.body.appendChild(_panel);
    _btn.onclick = () => { _panel.style.display = _panel.style.display === 'none' ? 'block' : 'none'; };
}

/**
 * Installe le bouton + panneau d'aperçu (idempotent). `onChange` redessine les panneaux joueurs.
 */
export function installScorePanelPreview(onChange) {
    _onChange = onChange;
    if (!_btn) _build();
}

/**
 * Retire le bouton + panneau (fin de partie). L'état coché est conservé pour la partie suivante.
 */
export function removeScorePanelPreview() {
    _onChange = null;
    _btn?.remove();   _btn = null;
    _panel?.remove(); _panel = null;
}

/**
 * Pièces fictives à afficher pour un joueur, ou null si l'aperçu n'est pas installé.
 * @param {number} playerIndex — index du joueur (roi et brigand, jetons uniques, ne s'affichent que chez le 1er
 *        joueur ; la tuile monastère, une par joueur, s'affiche chez tous)
 */
export function getScorePanelPreviewExtras(playerIndex) {
    if (!_btn) return null;
    const extras = {};
    COUNTED.forEach(({ key }) => {
        if (_state.counted[key].on) extras[key] = _state.counted[key].count;
    });
    if (_state.unique.king      && playerIndex === 0) extras.king      = true;
    if (_state.unique.robber    && playerIndex === 0) extras.robber    = true;
    if (_state.unique.monastery) extras.monastery = true;
    if (_state.prisoners > 0) extras.fakePrisoners = _state.prisoners;
    return extras;
}
