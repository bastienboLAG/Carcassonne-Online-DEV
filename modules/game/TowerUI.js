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
 *   getScorePanelUI()   → scorePanelUI — ✨ NOUVEAU (échange automatique de prisonniers)
 */

// ✅ FIX : tailles pion tour / meeple de verrouillage désormais pilotées par MeepleConfig.js
// (au lieu de valeurs en dur), pour être ajustables et cohérentes avec les autres meeples.
import { getMeepleSize } from '../MeepleConfig.js';
import { PRISONER_BUYBACK_COST } from '../rules/TowerConfig.js'; // ✨ NOUVEAU — Rachat de prisonnier

let _deps = null;

function gs()   { return _deps.getGameState(); }
function cfg()  { return _deps.getGameConfig(); }
function mp()   { return _deps.getMultiplayer(); }
function sync() { return _deps.getGameSync(); }
function tr()   { return _deps.getTowerRules(); }

export function initTowerUI(deps) {
    _deps = deps;
    setupPrisonerBuyback(); // ✨ NOUVEAU — enregistre le gestionnaire de rachat auprès de ScorePanelUI
}

// ── Helpers tuile ──────────────────────────────────────────────────────────

export function tileHasTowerZone(tileData) {
    return tileData?.zones?.some(z => z.type === 'tower') ?? false;
}

/**
 * Calcule l'ancrage visuel (left/bottom en px, relatif au conteneur 208×208)
 * de la zone tower d'une tuile, en tenant compte de sa rotation actuelle.
 * Reprend exactement le même calcul que showTowerCursors() (offsetX/offsetY
 * depuis le haut), converti en repère "bottom" (depuis le bas) puisque le
 * pion de tour grandit vers le haut à partir de ce point.
 * @returns {{ left: number, bottom: number }} — fallback centre (104,104) si zone introuvable
 * @private
 */
function _getTowerAnchor(x, y) {
    // ✅ FIX : le curseur "poser un étage" (.tower-floor-cursor) fait 38px de diamètre
    // et est centré sur la position via translate(-50%,-50%) — sans ce décalage, la tour
    // s'ancrait au CENTRE du curseur au lieu de son BAS. On descend donc du rayon (19px).
    const FLOOR_CURSOR_RADIUS = 19;

    const plateau    = _deps.getPlateau();
    const zoneMerger = _deps.getZoneMerger();
    const tile = plateau?.placedTiles?.[`${x},${y}`];
    const towerZoneIndex = tile?.zones?.findIndex(z => z.type === 'tower') ?? -1;

    if (tile && towerZoneIndex !== -1) {
        const zone = tile.zones[towerZoneIndex];
        const rawPos = Array.isArray(zone.meeplePosition) ? zone.meeplePosition[0] : zone.meeplePosition;
        if (rawPos != null) {
            const pos = zoneMerger ? zoneMerger._rotatePosition(rawPos, tile.rotation) : Number(rawPos);
            const row = Math.floor((pos - 1) / 5);
            const col = (pos - 1) % 5;
            const offsetX = 20.8 + col * 41.6;
            const offsetY = 20.8 + row * 41.6;
            return { left: offsetX, bottom: 208 - offsetY - FLOOR_CURSOR_RADIUS };
        }
    }
    // Fallback : centre de la tuile (ancien comportement, si zone introuvable)
    return { left: 104, bottom: 104 - FLOOR_CURSOR_RADIUS };
}

/**
 * ✨ NOUVEAU : ancrage visuel (left/top en px, repère 'top') du meeple qui verrouille
 * une tour, pour y placer précisément le curseur de capture. Lit directement la position
 * déjà calculée et appliquée par _positionLockMeepleOverTower() sur l'image rendue
 * (.tower-lock-meeple), pour rester correct quelle que soit la hauteur/rotation de la tour.
 * @returns {{ left: number, top: number }}
 * @private
 */
function _getTowerLockMeepleAnchor(x, y) {
    const boardEl = document.getElementById('board');
    const lockImg = boardEl?.querySelector(`.meeple-container[data-pos="${x},${y}"] .tower-lock-meeple`);
    if (lockImg) {
        const left     = parseFloat(lockImg.style.left)   || 104;
        const bottomPx = parseFloat(lockImg.style.bottom) || 104;
        const h        = lockImg.offsetHeight || 60;
        // Centre vertical du pion (repère 'bottom' → 'top')
        const top = 208 - bottomPx - (h / 2);
        return { left, top };
    }
    // Fallback : approximation au sommet de la tour si l'image n'est pas encore rendue
    const anchor = _getTowerAnchor(x, y);
    return { left: anchor.left, top: 208 - anchor.bottom - 30 };
}

// ── Curseurs de pose d'étage ─────────────────────────────────────────────

export function clearTowerCursors() {
    document.querySelectorAll('.tower-floor-cursor-overlay, .tower-capture-cursor-overlay').forEach(el => el.remove());
}

/**
 * Affiche un curseur "poser un étage" / "verrouiller" sur chaque tuile tower
 * éligible du plateau, uniquement pour le joueur actif.
 *
 * ✅ FIX : le curseur ne doit plus disparaître totalement dès que le joueur
 * n'a plus de pièce de tour — il doit rester possible de verrouiller une tour
 * déjà commencée (hauteur ≥ 1, non verrouillée) tant qu'il reste un meeple
 * normal ou un grand meeple posable. Le curseur ne disparaît complètement que
 * si le joueur n'a NI pièce de tour NI meeple posable pour un verrouillage.
 */
export function showTowerCursors() {
    const gameConfig = cfg();
    if (!gameConfig?.tileGroups?.tower || !gameConfig?.extensions?.tower) return;
    if (!_deps.getIsMyTurn()) return;

    const undoManager = _deps.getUndoManager();
    if (undoManager?.meeplePlacedThisTurn) return;

    const gameState  = gs();
    const player     = gameState.players.find(p => p.id === mp().playerId);
    if (!player) return;

    // ✅ FIX : calculer séparément les deux actions possibles (poser un étage / verrouiller)
    const hasFloorPieces    = (player.towerPieces ?? 0) > 0;
    const hasLockableMeeple = (player.meeples ?? 0) > 0 || player.hasLargeMeeple === true;
    if (!hasFloorPieces && !hasLockableMeeple) return;

    const towerRules = tr();
    if (!towerRules) return;

    const eligible = towerRules.getEligibleTowerTiles();
    if (eligible.length === 0) return;

    const zoneMerger = _deps.getZoneMerger();
    const plateau    = _deps.getPlateau();
    const boardEl    = document.getElementById('board');
    if (!boardEl) return;

    eligible.forEach(({ x, y, height, zoneIndex }) => {
        // ✅ FIX : n'afficher le curseur sur cette tuile que si une action y est réellement
        // possible — poser un étage (pièces dispo) ou verrouiller (tour déjà commencée + meeple dispo).
        const canAddFloorHere = hasFloorPieces;
        const canLockHere     = height >= 1 && hasLockableMeeple;
        if (!canAddFloorHere && !canLockHere) return;

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

        btn.addEventListener('click', (e) => { e.stopPropagation(); _openTowerFloorSelector(x, y, height, e.clientX, e.clientY); });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); _openTowerFloorSelector(x, y, height, e.changedTouches[0].clientX, e.changedTouches[0].clientY); }, { passive: false });

        overlay.appendChild(btn);
        boardEl.appendChild(overlay);
    });
}

// ── Pose d'étage ───────────────────────────────────────────────────────────

/**
 * Ouvre un mini-sélecteur avec l'icône de tour, pour confirmer explicitement
 * l'intention de poser un étage (même pattern que le sélecteur abbé/fée).
 *
 * ✅ FIX : l'option "poser un étage" n'est proposée que si le joueur a encore
 * des pièces de tour disponibles — sinon elle échouerait silencieusement côté
 * hôte (TowerRules.canAddFloor renvoie false). Le verrouillage reste proposé
 * indépendamment tant que la tour a au moins 1 étage et qu'un meeple est dispo.
 *
 * ✅ FIX : les icônes (tour, meeple normal, grand meeple) utilisent désormais
 * getMeepleSize() par type au lieu d'un "width:40px" unique pour tout le monde —
 * corrige le bug où le meeple normal et le grand meeple (avec cadenas) étaient
 * affichés à la même taille dans ce sélecteur.
 */
function _openTowerFloorSelector(x, y, height, clientX, clientY) {
    document.getElementById('meeple-selector')?.remove();

    const selector = document.createElement('div');
    selector.id = 'meeple-selector';
    selector.style.cssText = `position:fixed;left:${clientX}px;top:${clientY - 80}px;transform:translateX(-50%);z-index:1000;display:flex;align-items:flex-end;gap:0;padding:2px;background:rgba(44,62,80,0.5);border-radius:8px;border:2px solid #8e44ad;box-shadow:0 4px 20px rgba(0,0,0,0.5);`;

    const player = gs().players.find(p => p.id === mp().playerId);
    const hasFloorPieces = (player?.towerPieces ?? 0) > 0;

    // ✅ FIX : icône "poser un étage" uniquement si des pièces sont encore disponibles,
    // taille issue de MeepleConfig ('Tower', 'selector') au lieu de 40px fixe
    if (hasFloorPieces) {
        const option = document.createElement('div');
        option.style.cssText = 'cursor:pointer;padding:4px;border-radius:5px;';
        const img = document.createElement('img');
        img.src = './assets/Meeples/Tower01.png';
        const { width: towerSelWidth } = getMeepleSize('Tower', 'selector');
        img.style.cssText = `width:${towerSelWidth};height:auto;display:block;`;
        option.appendChild(img);
        option.onmouseenter = () => { option.style.background = 'rgba(142,68,173,0.2)'; };
        option.onmouseleave = () => { option.style.background = 'transparent'; };
        option.onclick = (e) => {
            e.stopPropagation();
            selector.remove();
            onTowerFloorConfirm(x, y);
        };
        selector.appendChild(option);
    }

    // Verrouillage : proposé uniquement si une tour existe déjà (au moins 1 étage)
    if (height >= 1 && player) {
        const colorCap = player.color.charAt(0).toUpperCase() + player.color.slice(1);
        const lockOptions = [];
        if ((player.meeples ?? 0) > 0) lockOptions.push({ type: 'Normal', src: `./assets/Meeples/${colorCap}/Normal.png` });
        if (player.hasLargeMeeple)     lockOptions.push({ type: 'Large',  src: `./assets/Meeples/${colorCap}/Large.png`  });

        lockOptions.forEach(({ type, src }) => {
            const lockOpt = document.createElement('div');
            lockOpt.style.cssText = 'cursor:pointer;padding:4px;border-radius:5px;position:relative;';
            const lockImg = document.createElement('img');
            lockImg.src = src;
            // ✅ FIX : taille propre à chaque type (Normal vs Large) au lieu de 40px pour les deux
            const { width: lockWidth, height: lockHeight } = getMeepleSize(type, 'selector');
            lockImg.style.cssText = `width:${lockWidth};height:${lockHeight};display:block;`;
            lockOpt.appendChild(lockImg);
            const badge = document.createElement('span');
            badge.textContent = '🔒';
            badge.style.cssText = 'position:absolute;top:-4px;right:-4px;font-size:12px;text-shadow:0 0 3px rgba(0,0,0,0.8);';
            lockOpt.appendChild(badge);
            lockOpt.title = 'Verrouiller la tour avec ce meeple';
            lockOpt.onmouseenter = () => { lockOpt.style.background = 'rgba(142,68,173,0.2)'; };
            lockOpt.onmouseleave = () => { lockOpt.style.background = 'transparent'; };
            lockOpt.onclick = (e) => {
                e.stopPropagation();
                selector.remove();
                onTowerLockConfirm(x, y, type);
            };
            selector.appendChild(lockOpt);
        });
    }

    // Si aucune option n'a pu être ajoutée (cas limite), ne rien afficher
    if (!selector.hasChildNodes()) return;

    document.body.appendChild(selector);
    setTimeout(() => {
        const close = (e) => { if (!selector.contains(e.target)) { selector.remove(); document.removeEventListener('click', close); } };
        document.addEventListener('click', close);
    }, 0);
}

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

        // ✅ FIX : nettoyer TOUS les curseurs (meeple classique, fée, tour...) — pas seulement
        // ceux de la tour — sinon ils restent affichés jusqu'à la fin du tour.
        _deps.hideAllCursors?.();

        const towerRules = tr();
        // ✨ NOUVEAU : getCaptureTargets inclut désormais les gardes verrouillant une tour
        // (clé spéciale "tower-lock:x,y"), en plus des meeples classiques de placedMeeples.
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
 * ✅ FIX : ancré sur la position réelle (rotée) de la zone tower de la tuile,
 * au lieu du centre fixe — sinon le pion "saute" par rapport au curseur de pose
 * dès que la zone tower n'est pas en position 13 ou que la tuile est tournée.
 * L'ancrage reste en "bottom" pour que la tour grandisse toujours vers le haut.
 * ✅ FIX : largeur issue de MeepleConfig ('Tower', 'plate') au lieu de 90px fixe —
 * rend la taille du pion tour ajustable via le fichier de config, comme les autres
 * meeples. La hauteur reste en 'auto' pour préserver le ratio propre à chaque
 * image de niveau (Tower01..Tower10 n'ont pas toutes le même ratio).
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

    // ✅ FIX : position réelle de la zone tower (rotée) au lieu du centre fixe 104/104
    const { left: anchorX, bottom: anchorBottom } = _getTowerAnchor(x, y);

    const clampedHeight = Math.min(height, 10);
    const img = document.createElement('img');
    img.className = 'tower-piece';
    img.src = `./assets/Meeples/Tower${String(clampedHeight).padStart(2, '0')}.png`;
    img.style.position  = 'absolute';
    img.style.left      = `${anchorX}px`;
    img.style.bottom    = `${anchorBottom}px`; // ✅ FIX : ancré au point réel de la zone, grandit vers le haut
    img.style.transform = 'translateX(-50%)'; // centrage horizontal uniquement — le vertical est géré par "bottom"
    const { width: towerPlateWidth } = getMeepleSize('Tower', 'plate'); // ✅ FIX : taille ajustable via MeepleConfig
    img.style.width     = towerPlateWidth;
    img.style.height    = 'auto'; // préserve le ratio propre à chaque image de niveau
    img.style.zIndex    = '55';
    img.style.opacity   = '0.85'; // légère transparence pour limiter le masquage du plateau
    img.style.pointerEvents = 'none';

    container.appendChild(img);

    // Repositionner le meeple de verrouillage (s'il existe) une fois la hauteur réelle de l'image connue
    const reposition = () => _positionLockMeepleOverTower(container, img);
    if (img.complete) reposition();
    else img.addEventListener('load', reposition);
}

/**
 * Positionne le meeple de verrouillage juste au-dessus du sommet réel de l'image de tour.
 * ✅ FIX : se cale sur l'ancrage réel du pion de tour (left/bottom lus directement sur
 * l'image, désormais variables selon la zone/rotation) au lieu de la constante 104 en dur.
 * @private
 */
function _positionLockMeepleOverTower(container, towerImg) {
    const lockImg = container.querySelector('.tower-lock-meeple');
    if (!lockImg || !towerImg) return;
    const h = towerImg.offsetHeight || 90;
    const towerLeft   = parseFloat(towerImg.style.left)   || 104;
    const towerBottom = parseFloat(towerImg.style.bottom) || 104;
    // ✅ FIX : descendu de 10px supplémentaires (chevauchement 6px → 16px) pour que
    // le meeple de verrouillage colle mieux au sommet visuel de la tour.
    const LOCK_MEEPLE_DROP = 10;
    lockImg.style.left   = `${towerLeft}px`;
    lockImg.style.bottom = `${towerBottom + h - 6 - LOCK_MEEPLE_DROP}px`;
}

/**
 * Rend le meeple de verrouillage au sommet de la tour.
 * ✅ FIX : taille issue de MeepleConfig(type, 'plate') au lieu de 40px fixe pour tous les
 * types — rend la taille ajustable et cohérente avec celle du meeple partout ailleurs
 * (un grand meeple de verrouillage est maintenant visiblement plus grand qu'un normal).
 */
export function renderTowerLockMeeple(x, y, type, color) {
    const boardEl = document.getElementById('board');
    const container = boardEl?.querySelector(`.meeple-container[data-pos="${x},${y}"]`);
    if (!container) return;

    container.querySelector('.tower-lock-meeple')?.remove();

    // ✅ FIX : le meeple de verrouillage et son cadenas sont regroupés dans un wrapper
    // positionné en absolu — permet de centrer le badge 🔒 sur le meeple quelle que soit
    // sa taille (Normal/Large), et de repositionner les deux ensemble via
    // _positionLockMeepleOverTower (qui continue de cibler la classe .tower-lock-meeple).
    const wrapper = document.createElement('div');
    wrapper.className = 'tower-lock-meeple';
    wrapper.style.position  = 'absolute';
    wrapper.style.left      = '104px';
    wrapper.style.bottom    = '104px'; // repositionné précisément par _positionLockMeepleOverTower
    wrapper.style.transform = 'translateX(-50%)';
    wrapper.style.zIndex    = '56';
    wrapper.style.pointerEvents = 'none';

    const { width: lockWidth, height: lockHeight } = getMeepleSize(type, 'plate'); // ✅ FIX : taille ajustable par type
    wrapper.style.width  = lockWidth;
    wrapper.style.height = lockHeight;

    const img = document.createElement('img');
    img.className = 'tower-lock-meeple-img';
    img.src = `./assets/Meeples/${color}/${type}.png`;
    img.style.display = 'block';
    img.style.width   = '100%';
    img.style.height  = '100%';
    // ✨ NOUVEAU : même transparence que le pion de tour (0.85), pour cohérence visuelle
    img.style.opacity = '0.85';
    wrapper.appendChild(img);

    // ✨ NOUVEAU : cadenas centré sur le meeple (même transparence), pour bien le
    // différencier visuellement d'un meeple posé normalement sur une zone.
    const badge = document.createElement('span');
    badge.className   = 'tower-lock-badge';
    badge.textContent = '🔒';
    badge.style.position   = 'absolute';
    badge.style.top        = '50%';
    badge.style.left       = '50%';
    badge.style.transform  = 'translate(-50%, -50%)';
    badge.style.fontSize   = '14px';
    badge.style.lineHeight = '1';
    badge.style.opacity    = '0.85';
    badge.style.pointerEvents = 'none';
    badge.style.textShadow = '0 0 3px rgba(0,0,0,0.8)';
    wrapper.appendChild(badge);

    container.appendChild(wrapper);

    const towerImg = container.querySelector('.tower-piece');
    if (towerImg) _positionLockMeepleOverTower(container, towerImg);
}

// ── Verrouillage ─────────────────────────────────────────────────────────

export function onTowerLockConfirm(x, y, meepleType) {
    clearTowerCursors();
    if (_deps.getIsHost()) {
        executeLockHost(x, y, mp().playerId, meepleType);
    } else {
        const hostConn = sync()?.multiplayer?.connections?.[0];
        if (hostConn?.open) {
            hostConn.send({ type: 'tower-lock-request', x, y, meepleType, playerId: mp().playerId });
        }
    }
}

/**
 * [HÔTE] Applique le verrouillage, broadcast à tous.
 */
export function executeLockHost(x, y, playerId, meepleType) {
    const towerRules = tr();
    const ok = towerRules.lockTower(x, y, playerId, meepleType);
    if (!ok) return;

    const gameState = gs();
    const player = gameState.players.find(p => p.id === playerId);
    const color  = player.color.charAt(0).toUpperCase() + player.color.slice(1);

    applyLockExecuted(x, y, playerId, meepleType, color, player.meeples, player.hasLargeMeeple);

    if (sync()) {
        sync().syncTowerLockExecuted(x, y, playerId, meepleType, color, player.meeples, player.hasLargeMeeple);
    }
    _deps.onUpdateTurnDisplay();
}

/**
 * Applique localement un verrouillage reçu du réseau (ou en solo).
 */
export function applyLockExecuted(x, y, playerId, meepleType, color, meeples, hasLargeMeeple) {
    const gameState = gs();
    const key = `${x},${y}`;
    if (!gameState.towers[key]) gameState.towers[key] = { height: 0, lockedBy: null, contributions: {} };
    gameState.towers[key].lockedBy        = playerId;
    gameState.towers[key].lockMeepleType  = meepleType;
    gameState.towers[key].lockMeepleColor = color;

    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        player.meeples        = meeples;
        player.hasLargeMeeple = hasLargeMeeple;
    }

    renderTowerLockMeeple(x, y, meepleType, color);

    if (playerId === mp().playerId) {
        const undoManager = _deps.getUndoManager();
        if (undoManager) undoManager.markMeeplePlaced(x, y, -1, null);
    }
    _deps.onUpdateTurnDisplay();
}

// ── Capture ──────────────────────────────────────────────────────────────

/**
 * Affiche un curseur (même style que les abbés récupérables) sur chaque meeple capturable.
 * ✨ NOUVEAU : sait positionner le curseur sur un garde verrouillant une tour (clé "tower-lock:x,y"),
 * en s'ancrant sur la position réelle déjà rendue par renderTowerLockMeeple(), quelle que soit
 * la hauteur ou la rotation de la tour concernée.
 */
export function showTowerCaptureCursors(targets) {
    const boardEl = document.getElementById('board');
    if (!boardEl) return;

    targets.forEach(({ key, meeple }) => {
        const isTowerLock = key.startsWith('tower-lock:');
        let mx, my, offsetX, offsetY;

        if (isTowerLock) {
            // ✨ NOUVEAU : clé "tower-lock:x,y" — coordonnées après le préfixe
            const coords = key.slice('tower-lock:'.length);
            [mx, my] = coords.split(',').map(Number);
            const anchor = _getTowerLockMeepleAnchor(mx, my);
            offsetX = anchor.left;
            offsetY = anchor.top;
        } else {
            const parts = key.split(',');
            mx = Number(parts[0]);
            my = Number(parts[1]);
            const mp2 = Number(parts[2]);
            const row = Math.floor((mp2 - 1) / 5);
            const col = (mp2 - 1) % 5;
            offsetX = 20.8 + col * 41.6;
            offsetY = 20.8 + row * 41.6;
        }

        const overlay = document.createElement('div');
        overlay.className = 'tower-capture-cursor-overlay';
        overlay.style.cssText = `grid-column:${mx};grid-row:${my};position:relative;width:208px;height:208px;pointer-events:none;z-index:102;`;

        const btn = document.createElement('div');
        btn.className = 'tower-capture-cursor';
        btn.style.cssText = `position:absolute;left:${offsetX}px;top:${offsetY}px;width:32px;height:32px;border-radius:50%;border:3px solid rgb(200,0,175);box-shadow:0 0 8px 2px rgba(200,0,175,0.7),inset 0 0 4px rgba(0,0,0,0.8);cursor:pointer;pointer-events:auto;transform:translate(-50%,-50%);animation:abbeRecallPulse 1.2s ease-in-out infinite;`;
        btn.title = 'Capturer ce meeple';

        btn.addEventListener('click', (e) => { e.stopPropagation(); _openTowerCaptureSelector(key, meeple, e.clientX, e.clientY); });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); _openTowerCaptureSelector(key, meeple, e.changedTouches[0].clientX, e.changedTouches[0].clientY); }, { passive: false });

        overlay.appendChild(btn);
        boardEl.appendChild(overlay);
    });
}

/**
 * Sélecteur de confirmation de capture — montre le meeple derrière des barreaux
 * pour prévisualiser qu'il deviendra prisonnier.
 * ✅ FIX : taille issue de MeepleConfig(meeple.type, 'selector') au lieu de 40px fixe.
 */
function _openTowerCaptureSelector(key, meeple, clientX, clientY) {
    document.getElementById('meeple-selector')?.remove();

    const selector = document.createElement('div');
    selector.id = 'meeple-selector';
    selector.style.cssText = `position:fixed;left:${clientX}px;top:${clientY - 80}px;transform:translateX(-50%);z-index:1000;display:flex;align-items:flex-end;gap:0;padding:2px;background:rgba(44,62,80,0.5);border-radius:8px;border:2px solid rgb(200,0,175);box-shadow:0 4px 20px rgba(0,0,0,0.5);`;

    const option = document.createElement('div');
    option.style.cssText = 'cursor:pointer;padding:4px;border-radius:5px;';
    const { width: captureWidth, height: captureHeight } = getMeepleSize(meeple.type, 'selector'); // ✅ FIX : taille par type
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `position:relative;width:${captureWidth};height:${captureHeight};`;
    const img = document.createElement('img');
    img.src = `./assets/Meeples/${meeple.color}/${meeple.type}.png`;
    img.style.cssText = `width:${captureWidth};height:${captureHeight};object-fit:contain;display:block;`;
    wrapper.appendChild(img);
    const bars = document.createElement('div');
    bars.style.cssText = 'position:absolute;inset:0;background:repeating-linear-gradient(90deg, rgba(0,0,0,0.9) 0 2px, transparent 2px 8px);pointer-events:none;';
    wrapper.appendChild(bars);
    option.appendChild(wrapper);
    option.onmouseenter = () => { option.style.background = 'rgba(200,0,175,0.2)'; };
    option.onmouseleave = () => { option.style.background = 'transparent'; };
    option.onclick = (e) => { e.stopPropagation(); selector.remove(); handleTowerCapture(key); };
    selector.appendChild(option);

    document.body.appendChild(selector);
    setTimeout(() => {
        const close = (e) => { if (!selector.contains(e.target)) { selector.remove(); document.removeEventListener('click', close); } };
        document.addEventListener('click', close);
    }, 0);
}

/**
 * Ré-affiche les curseurs de capture en attente (ex: après un rafraîchissement d'UI),
 * en reconstruisant les cibles depuis gameState._pendingTowerCapture.
 * ✨ NOUVEAU : sait résoudre une cible "tower-lock:x,y" (absente de placedMeeples)
 * en relisant l'état du verrouillage dans gameState.towers.
 */
export function showPendingTowerCaptureIfAny() {
    const gameState = gs();
    const pending = gameState._pendingTowerCapture;
    if (!pending) return;

    const placedMeeples = _deps.getPlacedMeeples();
    const targets = pending.targets
        .map(key => ({ key, meeple: _resolveCaptureTargetMeeple(key, placedMeeples) }))
        .filter(t => t.meeple);

    if (targets.length === 0) { gameState._pendingTowerCapture = null; return; }
    showTowerCaptureCursors(targets);
}

/**
 * ✨ NOUVEAU : résout le meeple correspondant à une clé de cible de capture, qu'il s'agisse
 * d'un meeple classique (placedMeeples) ou d'un garde verrouillant une tour (gameState.towers).
 * @private
 */
function _resolveCaptureTargetMeeple(key, placedMeeples) {
    if (key.startsWith('tower-lock:')) {
        const coords = key.slice('tower-lock:'.length);
        const tower  = gs().towers[coords];
        if (!tower?.lockedBy) return null;
        return { type: tower.lockMeepleType, color: tower.lockMeepleColor, playerId: tower.lockedBy };
    }
    return placedMeeples[key] ?? null;
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
 * [HÔTE] Exécute la capture, broadcast à tous, puis vérifie si cette capture crée
 * une situation d'échange automatique de prisonniers (✨ NOUVEAU, voir plus bas).
 */
export function executeTowerCaptureHost(meepleKey, playerId) {
    const towerRules = tr();
    const result = towerRules.executeCapture(meepleKey, playerId, _deps.getPlacedMeeples());
    if (!result) return;

    applyCaptureExecuted(meepleKey, playerId, result.selfCapture, result.meeple.type, result.meeple.playerId);

    if (sync()) {
        sync().syncTowerCaptureExecuted(meepleKey, playerId, result.selfCapture, result.meeple.type, result.meeple.playerId);
    }

    // ✨ NOUVEAU : Échange automatique de prisonniers — vérifier la réciprocité juste après
    // la capture. Une auto-capture (selfCapture) ne peut jamais créer de réciprocité puisque
    // le capturant et le propriétaire capturé sont la même personne.
    if (!result.selfCapture) {
        _checkAndHandleReciprocalExchange(playerId, result.meeple.playerId);
    }

    _deps.onUpdateTurnDisplay();
}

/**
 * Applique la capture de façon identique côté hôte ET invités : retrait du plateau,
 * mutation de gameState.prisoners (ou retour réserve si auto-capture), retrait visuel.
 * ⚠️ C'est ici et uniquement ici que la mutation a lieu — appelé par le hôte directement
 * et par les invités via le listener réseau, pour que gameState.prisoners soit cohérent partout.
 *
 * ✨ NOUVEAU : si la clé capturée est un garde verrouillant une tour ("tower-lock:x,y"),
 * la tour est déverrouillée (lockedBy/lockMeepleType/lockMeepleColor réinitialisés) et le
 * pion visuel de verrouillage est retiré, au lieu de toucher placedMeeples.
 */
export function applyCaptureExecuted(meepleKey, capturingPlayerId, selfCapture, meepleType, ownerId) {
    const gameState     = gs();
    const placedMeeples = _deps.getPlacedMeeples();

    if (selfCapture) {
        const player = gameState.players.find(p => p.id === capturingPlayerId);
        if (player) _returnCapturedMeeple(player, meepleType);
    } else if (capturingPlayerId) {
        if (!gameState.prisoners[capturingPlayerId]) gameState.prisoners[capturingPlayerId] = [];
        gameState.prisoners[capturingPlayerId].push({ type: meepleType, ownerId });

        // ✨ NOUVEAU : marque cette capture comme "fraîche" (pas encore validée par la fin du
        // tour du détenteur) — bloque temporairement son rachat, cf. GameState._freshCaptures.
        if (!gameState._freshCaptures) gameState._freshCaptures = [];
        gameState._freshCaptures.push({ holderId: capturingPlayerId, ownerId, type: meepleType });
    }

    // ✨ NOUVEAU : capture d'un garde verrouillant une tour — déverrouille la tour
    // et retire le pion visuel au lieu de manipuler placedMeeples.
    if (meepleKey.startsWith('tower-lock:')) {
        const coords = meepleKey.slice('tower-lock:'.length);
        const tower  = gameState.towers[coords];
        if (tower) {
            tower.lockedBy        = null;
            tower.lockMeepleType  = null;
            tower.lockMeepleColor = null;
        }
        const [tx, ty] = coords.split(',');
        document.querySelector(`.meeple-container[data-pos="${tx},${ty}"] .tower-lock-meeple`)?.remove();
        clearTowerCursors();
        return;
    }

    if (gameState.fairyState?.meepleKey === meepleKey) {
        gameState.removeFairy();
    }

    delete placedMeeples[meepleKey];
    document.querySelectorAll(`.meeple[data-key="${meepleKey}"]`).forEach(el => el.remove());

    // ✅ FIX : la capture Tour n'avait pas le nettoyage des Bâtisseurs/Cochons orphelins
    // que le Dragon possède déjà (cf. DragonUI.executeDragonMoveHost, "Fix 5"). Si le
    // meeple capturé était le dernier meeple normal/grand meeple de SON propriétaire dans
    // une zone où ce même propriétaire avait aussi un Bâtisseur ou un Cochon, ce dernier
    // restait bloqué sur le plateau indéfiniment (hasBuilder/hasPig jamais remis à true).
    // Reprend exactement le même algorithme que DragonUI : on rebalaye tous les
    // Bâtisseurs/Cochons du plateau et on vérifie, pour chacun, si son propriétaire a
    // encore un meeple "porteur" dans la même zone fusionnée.
    const zoneMerger = _deps.getZoneMerger?.();
    if (zoneMerger) {
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
            const orphan = placedMeeples[key];
            const orphanPlayer = gameState.players.find(p => p.id === orphan.playerId);
            if (orphanPlayer) {
                if (orphan.type === 'Builder') orphanPlayer.hasBuilder = true;
                else if (orphan.type === 'Pig') orphanPlayer.hasPig = true;
            }
            delete placedMeeples[key];
            document.querySelectorAll(`.meeple[data-key="${key}"]`).forEach(el => el.remove());
            console.log(`🗼 [FIX] Builder/Cochon orphelin rendu après capture Tour: ${key}`);
        });
    }

    clearTowerCursors();
}

// ── ✨ NOUVEAU — Échange automatique de prisonniers ─────────────────────────
//
// Règle : si le joueur qui vient de capturer (X) détient désormais un prisonnier
// du propriétaire capturé (Y), ET que Y détenait déjà un ou plusieurs prisonniers
// de X, alors il y a réciprocité :
//   - le meeple fraîchement capturé par X retourne TOUJOURS automatiquement à Y
//     (géré ci-dessous, en "annulant" partiellement ce que applyCaptureExecuted
//     vient de faire pour X) ;
//   - si Y ne détient qu'UN SEUL type de meeple de X, ce type revient
//     automatiquement à X (aucune ambiguïté possible) ;
//   - si Y détient PLUSIEURS types distincts de meeples de X, X doit choisir
//     lequel récupérer (modale + sélection dans le panel de Y).
// Comme il ne peut y avoir qu'une seule capture par tour de jeu, le joueur qui
// capture (X) ne peut jamais avoir plus d'UN prisonnier de Y au moment de la
// réciprocité — c'est donc toujours X (le joueur actif) qui, le cas échéant,
// doit choisir, jamais Y.

/**
 * [HÔTE] Vérifie la réciprocité juste après une capture et déclenche la résolution
 * automatique (un seul type possible) ou la demande de choix (plusieurs types).
 * @private
 */
function _checkAndHandleReciprocalExchange(capturingPlayerId, capturedOwnerId) {
    const towerRules = tr();
    if (!towerRules) return;

    const distinctTypes = towerRules.checkReciprocalCapture(capturingPlayerId, capturedOwnerId);
    if (distinctTypes.length === 0) return; // pas de réciprocité, rien à faire

    if (distinctTypes.length === 1) {
        // Un seul type possible chez l'adversaire : résolution immédiate sans ambiguïté
        applyPrisonerExchangeResolved(capturedOwnerId, capturingPlayerId, distinctTypes[0]);
        if (sync()) sync().syncPrisonerExchangeResolved(capturedOwnerId, capturingPlayerId, distinctTypes[0]);
    } else {
        // Plusieurs types possibles : le joueur qui capture doit choisir lequel récupérer
        applyPrisonerExchangePending(capturedOwnerId, capturingPlayerId, distinctTypes);
        if (sync()) sync().syncPrisonerExchangePending(capturedOwnerId, capturingPlayerId, distinctTypes);
    }
}

/**
 * ✨ NOUVEAU — Échange automatique de prisonniers
 * Applique la résolution de façon identique côté hôte ET invités (même principe que
 * applyCaptureExecuted) : retire UNE entrée du type choisi appartenant à `chooserId` dans
 * les prisonniers de `opponentId`, et la rend à la réserve de `chooserId`. Affiche ensuite
 * la modale informative (bouton "Fermer" pour tous, y compris le joueur qui a choisi).
 */
export function applyPrisonerExchangeResolved(opponentId, chooserId, chosenType) {
    const gameState = gs();
    const held = gameState.prisoners[opponentId] ?? [];
    const idx = held.findIndex(p => p.ownerId === chooserId && p.type === chosenType);
    if (idx !== -1) held.splice(idx, 1);

    const player = gameState.players.find(p => p.id === chooserId);
    if (player) _returnCapturedMeeple(player, chosenType);

    gameState._pendingPrisonerExchange = null;
    _closePrisonerSelectionUI();

    showPrisonerExchangeModal({ needsChoice: false, chooserId, opponentId, chosenType });
    _deps.onUpdateTurnDisplay();
}

/**
 * ✨ NOUVEAU — Échange automatique de prisonniers
 * Affiche l'état "en attente de choix" de façon identique côté hôte ET invités : pose
 * gameState._pendingPrisonerExchange (transitoire, non sérialisé) et ouvre la modale
 * adaptée au rôle du joueur local (bouton "Choisir" pour le joueur concerné, "Fermer"
 * pour tous les autres).
 */
export function applyPrisonerExchangePending(opponentId, chooserId, availableTypes) {
    gs()._pendingPrisonerExchange = { chooserId, opponentId, availableTypes };

    const isChooser = chooserId === mp().playerId;
    showPrisonerExchangeModal({ needsChoice: isChooser, chooserId, opponentId, availableTypes });
}

/**
 * ✨ NOUVEAU — Échange automatique de prisonniers
 * [HÔTE] Valide et applique le choix du joueur concerné, puis broadcast la résolution.
 */
export function executePrisonerChoiceHost(chosenType, playerId) {
    const gameState = gs();
    const pending = gameState._pendingPrisonerExchange;
    if (!pending || pending.chooserId !== playerId) return;
    if (!pending.availableTypes.includes(chosenType)) return;

    applyPrisonerExchangeResolved(pending.opponentId, pending.chooserId, chosenType);
    if (sync()) sync().syncPrisonerExchangeResolved(pending.opponentId, pending.chooserId, chosenType);
}

/**
 * ✨ NOUVEAU — Échange automatique de prisonniers
 * Appelée quand le joueur concerné clique sur un de ses prisonniers sélectionnables
 * dans le panel adverse (voir _openPrisonerSelectionUI / ScorePanelUI.enablePrisonerSelection).
 * Envoie la requête à l'hôte, ou résout directement si hôte/solo.
 * @private
 */
function handlePrisonerChoiceConfirm(chosenType) {
    const gameState = gs();
    const pending = gameState._pendingPrisonerExchange;
    if (!pending) return;

    if (_deps.getIsHost()) {
        executePrisonerChoiceHost(chosenType, mp().playerId);
    } else {
        const hostConn = sync()?.multiplayer?.connections?.[0];
        if (hostConn?.open) {
            hostConn.send({ type: 'prisoner-exchange-choice-request', chosenType, playerId: mp().playerId });
        }
    }
}

/**
 * ✨ NOUVEAU — Échange automatique de prisonniers
 * Libellés français courts pour les types de meeples, utilisés dans le texte de la modale.
 * @private
 */
const _MEEPLE_LABELS = {
    Normal: 'meeple',
    Farmer: 'fermier',
    Large: 'grand meeple',
    'Large-Farmer': 'grand fermier',
    Abbot: 'abbé',
};
function _meepleLabel(type) {
    return _MEEPLE_LABELS[type] ?? type;
}

/**
 * ✨ NOUVEAU — Échange automatique de prisonniers
 * Affiche la modale d'échange, adaptée selon le rôle du joueur local :
 *   - chosenType fourni : échange déjà résolu, message informatif, bouton "Fermer" pour tous.
 *   - needsChoice=true (uniquement chez le joueur qui doit choisir) : bouton "Choisir".
 *   - needsChoice=false sans chosenType (les autres joueurs pendant que quelqu'un choisit) :
 *     bouton "Fermer".
 * @private
 */
function showPrisonerExchangeModal({ needsChoice, chooserId, opponentId, chosenType = null, availableTypes = null }) {
    const modal     = document.getElementById('prisoner-exchange-modal');
    const text      = document.getElementById('prisoner-exchange-text');
    const chooseBtn = document.getElementById('prisoner-exchange-choose-btn');
    const closeBtn  = document.getElementById('prisoner-exchange-close-btn');
    if (!modal || !text || !chooseBtn || !closeBtn) return;

    const gameState    = gs();
    const chooserName  = gameState.players.find(p => p.id === chooserId)?.name  ?? '?';
    const opponentName = gameState.players.find(p => p.id === opponentId)?.name ?? '?';

    if (chosenType) {
        text.textContent = `Échange de prisonniers : ${chooserName} récupère son ${_meepleLabel(chosenType)} auprès de ${opponentName}.`;
    } else {
        text.textContent = `Échange de prisonniers : ${chooserName} doit choisir lequel de ses meeples récupérer auprès de ${opponentName}.`;
    }

    chooseBtn.style.display = needsChoice ? '' : 'none';
    closeBtn.style.display  = needsChoice ? 'none' : '';

    chooseBtn.onclick = () => {
        modal.style.display = 'none';
        _openPrisonerSelectionUI(opponentId, chooserId, availableTypes);
    };
    closeBtn.onclick = () => { modal.style.display = 'none'; };

    modal.style.display = 'flex';
}

/**
 * ✨ NOUVEAU — Échange automatique de prisonniers
 * Ouvre le voile gris + force l'ouverture du panel du joueur adverse concerné, en rendant
 * sélectionnables uniquement ses prisonniers appartenant au joueur qui doit choisir.
 *
 * Le mécanisme de sélection lui-même (ScorePanelUI.enablePrisonerSelection) est générique —
 * prévu pour être réutilisé plus tard par le rachat de prisonnier (probablement sans modale
 * ni voile gris dans ce futur cas d'usage, à la charge de l'appelant à ce moment-là).
 * @private
 */
function _openPrisonerSelectionUI(opponentId, chooserId, availableTypes) {
    const overlay = document.getElementById('prisoner-selection-overlay');
    if (overlay) overlay.style.display = 'block';

    const scorePanelUI = _deps.getScorePanelUI?.();
    if (!scorePanelUI) return;

    scorePanelUI.forceOpenPlayerPanel(opponentId);
    scorePanelUI.enablePrisonerSelection({
        playerId: opponentId,
        isSelectable: (entry) => entry.ownerId === chooserId && availableTypes.includes(entry.type),
        onSelect: (entry) => handlePrisonerChoiceConfirm(entry.type),
    });
}

/**
 * ✨ NOUVEAU — Échange automatique de prisonniers
 * Referme le voile gris et désactive la sélection de prisonniers.
 * @private
 */
function _closePrisonerSelectionUI() {
    const overlay = document.getElementById('prisoner-selection-overlay');
    if (overlay) overlay.style.display = 'none';

    const scorePanelUI = _deps.getScorePanelUI?.();
    if (scorePanelUI) scorePanelUI.disablePrisonerSelection();
}

// ── ✨ NOUVEAU — Rachat de prisonnier ───────────────────────────────────────
//
// Contrairement à l'échange automatique (déclenché par une capture, résolu
// uniquement au moment où elle survient), le rachat est disponible à tout
// moment de la partie, pour n'importe quel joueur, dès qu'il ouvre le panel
// d'un adversaire qui détient un de ses prisonniers. Coût fixe
// (PRISONER_BUYBACK_COST) : les points vont directement au joueur qui détient
// le prisonnier (le capturant, propriétaire du panel) — c'est une vraie
// transaction entre les deux joueurs, pas une dépense dans une réserve neutre.
//
// Réutilise le mécanisme générique de sélection de ScorePanelUI, exactement
// comme prévu lors de sa conception pour l'échange automatique — mais via
// setBuybackHandler(), un gestionnaire PERMANENT appliqué à TOUS les panels
// (contrairement à enablePrisonerSelection(), qui cible un seul panel pour la
// durée d'un échange précis). Le rachat est automatiquement désactivé tant
// qu'un échange automatique attend sa résolution (gameState._pendingPrisonerExchange),
// pour éviter tout conflit de mutation entre les deux mécanismes sur les mêmes
// prisonniers (fenêtre entre l'annonce de l'échange et le choix du joueur concerné).

/**
 * Enregistre le gestionnaire de rachat auprès de ScorePanelUI. Appelé une fois
 * à l'initialisation de TowerUI (scorePanelUI existe déjà à ce moment).
 * @private
 */
function setupPrisonerBuyback() {
    const scorePanelUI = _deps.getScorePanelUI?.();
    if (!scorePanelUI) return;

    scorePanelUI.setBuybackHandler({
        isSelectable: (entry, panelPlayerId) => {
            const gameState = gs();
            // Aucun rachat tant qu'un échange automatique attend sa résolution —
            // évite tout conflit de mutation sur les mêmes prisonniers.
            if (gameState._pendingPrisonerExchange) return false;
            // ✨ NOUVEAU : aucun rachat pour une capture effectuée pendant le tour EN COURS
            // du détenteur (panelPlayerId) — tant que ce tour n'est pas terminé, il pourrait
            // encore être annulé (une fois l'annulation adaptée à l'extension Tour). Ne
            // concerne jamais les prisonniers de tours précédents (liste vidée à chaque
            // 'turn-changed', cf. home.js).
            const isFreshThisTurn = (gameState._freshCaptures ?? []).some(
                c => c.holderId === panelPlayerId && c.ownerId === entry.ownerId && c.type === entry.type
            );
            if (isFreshThisTurn) return false;
            const localId = mp().playerId;
            if (entry.ownerId !== localId) return false; // uniquement ses propres meeples
            const player = gameState.players.find(p => p.id === localId);
            return (player?.score ?? 0) >= PRISONER_BUYBACK_COST;
        },
        onSelect: (entry, panelPlayerId) => {
            _openBuybackConfirmModal(panelPlayerId, entry.type);
        },
    });
}

/**
 * Affiche la modale de confirmation d'achat (modale bloquante avec boutons
 * Confirmer/Annuler, vu l'enjeu de perdre des points par erreur).
 * @private
 */
function _openBuybackConfirmModal(opponentId, meepleType) {
    const modal      = document.getElementById('prisoner-buyback-modal');
    const text       = document.getElementById('prisoner-buyback-text');
    const confirmBtn = document.getElementById('prisoner-buyback-confirm-btn');
    const cancelBtn  = document.getElementById('prisoner-buyback-cancel-btn');
    if (!modal || !text || !confirmBtn || !cancelBtn) return;

    const opponentName = gs().players.find(p => p.id === opponentId)?.name ?? '?';
    text.textContent = `Racheter votre ${_meepleLabel(meepleType)} auprès de ${opponentName} coûte ${PRISONER_BUYBACK_COST} points (versés à ${opponentName}).`;

    confirmBtn.onclick = () => { modal.style.display = 'none'; _confirmBuyback(opponentId, meepleType); };
    cancelBtn.onclick  = () => { modal.style.display = 'none'; };

    modal.style.display = 'flex';
}

/**
 * Envoie la demande de rachat à l'hôte, ou l'exécute directement si hôte/solo.
 * @private
 */
function _confirmBuyback(opponentId, meepleType) {
    if (_deps.getIsHost()) {
        executePrisonerBuybackHost(opponentId, meepleType, mp().playerId);
    } else {
        const hostConn = sync()?.multiplayer?.connections?.[0];
        if (hostConn?.open) {
            hostConn.send({ type: 'prisoner-buyback-request', opponentId, meepleType, playerId: mp().playerId });
        }
    }
}

/**
 * [HÔTE] Valide (score suffisant, prisonnier toujours détenu, pas d'échange
 * automatique en attente) puis applique le rachat, et broadcast le résultat.
 */
export function executePrisonerBuybackHost(opponentId, meepleType, buyerId) {
    const gameState = gs();
    if (gameState._pendingPrisonerExchange) return; // sécurité : pas de rachat pendant un échange en cours

    // ✨ NOUVEAU : revalidation côté hôte — aucun rachat tant que la capture concernée n'a pas
    // été validée par la fin du tour du détenteur (défense en profondeur, cf. setupPrisonerBuyback).
    const isFreshThisTurn = (gameState._freshCaptures ?? []).some(
        c => c.holderId === opponentId && c.ownerId === buyerId && c.type === meepleType
    );
    if (isFreshThisTurn) return;

    const buyer = gameState.players.find(p => p.id === buyerId);
    if (!buyer || (buyer.score ?? 0) < PRISONER_BUYBACK_COST) return;

    const held = gameState.prisoners[opponentId] ?? [];
    const stillHeld = held.some(p => p.ownerId === buyerId && p.type === meepleType);
    if (!stillHeld) return; // déjà racheté entre-temps (double-clic / course réseau)

    applyPrisonerBuybackExecuted(buyerId, opponentId, meepleType);
    if (sync()) sync().syncPrisonerBuybackExecuted(buyerId, opponentId, meepleType);
}

/**
 * Applique le rachat de façon identique côté hôte ET invités : retire une
 * entrée du type demandé appartenant à `buyerId` dans les prisonniers de
 * `opponentId`, rend le meeple à la réserve de l'acheteur, transfère
 * PRISONER_BUYBACK_COST points de l'acheteur vers le capturant (`opponentId`),
 * et informe tous les joueurs via un toast générique.
 */
export function applyPrisonerBuybackExecuted(buyerId, opponentId, meepleType) {
    const gameState = gs();
    const held = gameState.prisoners[opponentId] ?? [];
    const idx = held.findIndex(p => p.ownerId === buyerId && p.type === meepleType);
    if (idx !== -1) held.splice(idx, 1);

    const buyer    = gameState.players.find(p => p.id === buyerId);
    const capturer = gameState.players.find(p => p.id === opponentId);

    if (buyer) {
        _returnCapturedMeeple(buyer, meepleType);
        buyer.score -= PRISONER_BUYBACK_COST;
        buyer.scoreDetail = buyer.scoreDetail || {};
        buyer.scoreDetail.buybacks = (buyer.scoreDetail.buybacks || 0) - PRISONER_BUYBACK_COST;
    }
    if (capturer) {
        capturer.score += PRISONER_BUYBACK_COST;
        capturer.scoreDetail = capturer.scoreDetail || {};
        capturer.scoreDetail.buybacks = (capturer.scoreDetail.buybacks || 0) + PRISONER_BUYBACK_COST;
    }
    // Marque la partie comme ayant eu au moins un rachat — utilisé par
    // FinalScoresManager pour n'afficher la colonne "Rachats" que si pertinent.
    gameState.hasPrisonerBuybacks = true;

    const buyerName    = buyer?.name    ?? '?';
    const capturerName = capturer?.name ?? '?';
    _deps.afficherToast?.(`🔓 ${buyerName} a racheté un ${_meepleLabel(meepleType)} auprès de ${capturerName} (-${PRISONER_BUYBACK_COST} points).`, 'info');

    _deps.onUpdateTurnDisplay(); // déclenche aussi l'émission de 'score-updated' (cf. TurnUI.updateTurnDisplay)
}

/**
 * Rend un meeple capturé (auto-capture) à son propriétaire — même logique que TowerRules,
 * dupliquée ici volontairement pour que host et invités appliquent la même mutation locale
 * sans dépendre d'une instance TowerRules (les invités n'en ont pas forcément une active).
 * @private
 */
function _returnCapturedMeeple(player, type) {
    switch (type) {
        case 'Abbot':        player.hasAbbot       = true; break;
        case 'Large':
        case 'Large-Farmer': player.hasLargeMeeple = true; break;
        case 'Builder':      player.hasBuilder     = true; break;
        case 'Pig':          player.hasPig         = true; break;
        default:             if (player.meeples < 7) player.meeples++; break;
    }
}