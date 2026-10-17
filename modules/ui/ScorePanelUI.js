import { getMeepleSize, getGoodsSize } from '../MeepleConfig.js';
// ✨ NOUVEAU : aperçu visuel provisoire (mode debug) — voir ScorePanelPreview.js pour le retirer
import { installScorePanelPreview, removeScorePanelPreview, getScorePanelPreviewExtras } from './ScorePanelPreview.js';

// ✨ NOUVEAU : identifiant spécial de la carte « Spectateurs » (jamais un id de joueur réel),
// utilisé pour l'état d'ouverture desktop/mobile et pour dataset.playerId.
const SPECTATORS_KEY = '__spectators__';

// ✨ NOUVEAU : couleurs utilisées pour les prisonniers fictifs de l'aperçu debug
const PREVIEW_COLORS = ['Red', 'Green', 'Yellow', 'Pink', 'Black', 'Blue'];

/**
 * ScorePanelUI - Affichage des joueurs : panel PC + barre mobile
 *
 * Toute la logique de rendu des meeples est centralisée dans
 * _buildMeeplesDisplay(), appelée par les deux rendus (PC et mobile).
 *
 * ✨ NOUVEAU — Contenu d'un panneau : 4 rangées dans un ordre fixe (voir _buildMeeplesDisplay) :
 *   1. meeples (Normal, Abbé, Grand, Maire, Chariot, Berger, Directeur, puis Bâtisseur+Cochon en bloc insécable)
 *   2. structures (Grange, Forteresse, Tour, Pont)
 *   3. jetons (Blé, Vin, Tissu, Mouton, Roi, Brigand)
 *   4. butin (tuile monastère à gauche, prisonniers à droite)
 * Flux libre avec retour à la ligne ; une rangée sans élément n'est pas rendue. Compteur « ×N »
 * superposé en bas à droite de l'icône (sauf Roi, Brigand, tuile et prisonniers, uniques/individuels).
 * Les pièces des extensions futures se branchent via _getPieceExtras().
 *
 * ✨ NOUVEAU : sur mobile, la barre de cartes reste toujours visible et fermée
 * (meeple coloré + score + chevron — le pseudo n'est plus sur la carte mais dans l'en-tête du
 * détail). Un clic sur une carte ouvre son détail (meeples + marchandises) dans un conteneur
 * séparé (#mobile-player-detail), centré, un seul joueur ouvert à la fois (accordéon).
 * La barre défile horizontalement (cartes de largeur minimale --mobile-card-min-w) ; la carte
 * du joueur actif est recentrée à chaque changement de tour.
 * Le panel PC (#players-scores) n'est pas concerné, il reste toujours déplié.
 *
 * ✨ NOUVEAU — Spectateurs : tous les spectateurs sont regroupés en UNE carte (desktop :
 * « Spectateur(s) (N) » dépliable avec la liste des pseudos ; mobile : fantôme + nombre, la liste
 * est dans le détail).
 *
 * ✨ NOUVEAU — Sélection de prisonniers (mécanisme générique) : voir
 * enablePrisonerSelection()/disablePrisonerSelection()/forceOpenPlayerPanel() plus bas.
 * Utilisé aujourd'hui par l'échange automatique de prisonniers (extension Tour, cf.
 * TowerUI.js), et prévu pour être réutilisé plus tard par le rachat de prisonnier.
 *
 * ✅ FIX : pendant une sélection, les panels reçoivent désormais un rôle explicite
 * (classes CSS posées ici, comportement défini dans style.css) :
 *   - panel du joueur qui DÉTIENT les prisonniers proposés (playerId / cible) → visible
 *     au-dessus du voile, mise en page intacte, recouvert d'un calque sombre local (0.9) SAUF
 *     les prisonniers sélectionnables qui restent au-dessus du calque (cliquables) ;
 *   - panel du joueur qui CHOISIT (chooserId, desktop uniquement) → visible mais recouvert
 *     d'un calque sombre local, pour le distinguer du panel cible ;
 *   - tous les autres panels (carte Spectateurs incluse) → masqués entièrement pendant la
 *     sélection (desktop et mobile, y compris les cartes fermées de la barre du haut sur mobile).
 *
 * ✨ NOUVEAU : gameState.prisoners a été déplacé sous gameState.extraState.prisoners
 * (conteneur générique partagé par toutes les extensions à état persistant — voir
 * GameState.js et ARCHITECTURE.md). Seule la lecture dans _buildMeeplesDisplay() ci-dessous
 * a dû être mise à jour en conséquence.
 */
export class ScorePanelUI {
    constructor(eventBus, gameState, config = {}) {
        this.eventBus  = eventBus;
        this.gameState = gameState;
        this.config    = config;

        this._onScoreUpdated       = this.onScoreUpdated.bind(this);
        this._onMeepleCountUpdated = this.onMeepleCountUpdated.bind(this);

        this.eventBus.on('score-updated',        this._onScoreUpdated);
        this.eventBus.on('meeple-count-updated', this._onMeepleCountUpdated);

        this._isBonusTurn  = false;
        this._isDragonTurn = false;

        // ✨ NOUVEAU : id du joueur dont le détail mobile est actuellement ouvert (un seul à la fois)
        this._mobileOpenPlayerId = null;

        // ✨ NOUVEAU : ids des joueurs dont le détail PC est actuellement ouvert (plusieurs simultanément)
        this._desktopOpenPlayerIds = new Set();

        // ✨ NOUVEAU : sélection de prisonniers — mécanisme générique. Utilisé aujourd'hui par
        // l'échange automatique de prisonniers (extension Tour, cf. TowerUI.js) et prévu pour
        // être réutilisé plus tard par le rachat de prisonnier (sans modale ni voile gris dans
        // ce futur cas d'usage — la gestion de ces éléments reste toujours à la charge de
        // l'appelant, ce mécanisme ne fait que rendre des entrées cliquables).
        // Forme : { playerId, chooserId, isSelectable(entry), onSelect(entry) } où
        // entry = { type, ownerId }, ou null si aucune sélection en cours.
        // ✅ FIX : `chooserId` ajouté — permet à ce fichier de distinguer le panel du joueur qui
        // choisit (mis en avant mais assombri) de celui de tous les autres joueurs non concernés
        // (masqués), en plus du panel cible (`playerId`, entièrement visible).
        this._prisonerSelection = null;

        // ✨ NOUVEAU : gestionnaire de rachat de prisonnier — PERMANENT (contrairement à
        // _prisonerSelection ci-dessus, qui ne cible qu'un panel précis pour la durée d'une
        // session). Appliqué à TOUS les panels en continu. Forme :
        // { isSelectable(entry, panelPlayerId), onSelect(entry, panelPlayerId) }, ou null.
        // Enregistré une fois par TowerUI.setupPrisonerBuyback() au démarrage de la partie.
        this._buybackHandler = null;

        // ✨ NOUVEAU : dernier joueur actif centré dans la barre mobile (recentrage uniquement
        // quand le joueur actif CHANGE, pas à chaque rafraîchissement de score)
        this._lastActiveId = null;

        // ✨ NOUVEAU : suivi de la hauteur réelle de la barre mobile (variable CSS --mobile-bar-h)
        this._barObserver = null;
        this._onWinResize = null;
        this._observeMobileBarHeight();

        // ✨ NOUVEAU : indicateur de défilement de la barre mobile (estompage des bords, voir _updateScrollFade)
        this._scrollEl = null;
        this._onScroll = null;
        this._installScrollFade();

        // ✨ NOUVEAU : aperçu visuel provisoire des futurs pions (uniquement avec « Mode debug »)
        if (this.config?.enableDebug) {
            installScorePanelPreview(() => this.update(this._isBonusTurn, this._isDragonTurn));
        }
    }

    onScoreUpdated() { this.update(this._isBonusTurn, this._isDragonTurn); }
    onTurnChanged(isBonusTurn, isDragonTurn = false) {
        this._isBonusTurn  = isBonusTurn  ?? false;
        this._isDragonTurn = isDragonTurn ?? false;
        this.update(this._isBonusTurn, this._isDragonTurn);
    }
    onMeepleCountUpdated() { this.update(this._isBonusTurn, this._isDragonTurn); }

    // ─────────────────────────────────────────────────────────────
    // Point d'entrée unique — met à jour PC ET mobile
    // ─────────────────────────────────────────────────────────────

    update(isBonusTurn = false, isDragonTurn = false) {
        this._updateDesktop(isBonusTurn, isDragonTurn);
        this._updateMobile(isBonusTurn, isDragonTurn);
    }

    // Alias public pour home.js (compatibilité)
    updateMobile() { this._updateMobile(this._isBonusTurn, this._isDragonTurn); }

    // ─────────────────────────────────────────────────────────────
    // ✨ NOUVEAU : hauteur de la barre mobile → variable CSS --mobile-bar-h
    // Le panel de détail (#mobile-player-detail) se place sous la barre grâce à cette variable :
    // si la barre grandit, elle repousse le détail au lieu de passer par-dessus (auparavant top: 56px en dur).
    // ─────────────────────────────────────────────────────────────

    _observeMobileBarHeight() {
        const bar = document.getElementById('mobile-players-bar');
        if (!bar) return;
        const apply = () => {
            const h = Math.ceil(bar.getBoundingClientRect().height);
            if (h > 0) document.documentElement.style.setProperty('--mobile-bar-h', `${h}px`);
            else       document.documentElement.style.removeProperty('--mobile-bar-h'); // barre masquée (desktop)
            this._updateScrollFade(); // la largeur disponible a pu changer (rotation, redimensionnement)
        };
        apply();
        if (typeof ResizeObserver !== 'undefined') {
            this._barObserver = new ResizeObserver(apply);
            this._barObserver.observe(bar);
        } else {
            this._onWinResize = apply;
            window.addEventListener('resize', apply);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // ✨ NOUVEAU : indicateur de défilement de la barre mobile.
    // Pose les classes can-scroll-left / can-scroll-right sur #mobile-players-scores selon qu'il reste des
    // cartes à découvrir de chaque côté ; style.css estompe alors le bord correspondant (masque).
    // Aucune classe si tout tient à l'écran.
    // ─────────────────────────────────────────────────────────────

    _installScrollFade() {
        const el = document.getElementById('mobile-players-scores');
        if (!el) return;
        this._scrollEl = el;
        this._onScroll = () => this._updateScrollFade();
        el.addEventListener('scroll', this._onScroll, { passive: true });
        this._updateScrollFade();
    }

    _updateScrollFade() {
        const el = this._scrollEl;
        if (!el) return;
        const max   = el.scrollWidth - el.clientWidth;
        const left  = max > 2 && el.scrollLeft > 2;
        const right = max > 2 && el.scrollLeft < max - 2;
        el.classList.toggle('can-scroll-left',  left);
        el.classList.toggle('can-scroll-right', right);
    }

    // ─────────────────────────────────────────────────────────────
    // ✨ NOUVEAU : regroupe joueurs et spectateurs à afficher
    // (les entrées spectateur dont le pseudo correspond à un joueur actif sont masquées, comme avant)
    // ─────────────────────────────────────────────────────────────

    _getDisplayGroups() {
        const activeNames = new Set(
            this.gameState.players
                .filter(p => p.color !== 'spectator' && !p.disconnected && !p.kicked)
                .map(p => p.name)
        );
        const visible = this.gameState.players
            .filter(p => p.color !== 'spectator' || !activeNames.has(p.name));
        return {
            playersList: visible.filter(p => p.color !== 'spectator'),
            spectators:  visible.filter(p => p.color === 'spectator'),
        };
    }

    /**
     * ✨ NOUVEAU : liste des spectateurs (fantôme + pseudo), partagée desktop / mobile.
     */
    _buildSpectatorList(spectators) {
        const list = document.createElement('div');
        list.className = 'spectator-list';
        spectators.forEach(spec => {
            const item = document.createElement('div');
            item.className = 'spectator-item';
            const ghost = document.createElement('img');
            ghost.className = 'spectator-ghost-icon';
            ghost.src = './assets/Meeples/Spectator.png';
            ghost.alt = 'Spectateur';
            item.appendChild(ghost);
            const nameEl = document.createElement('span');
            nameEl.textContent = spec.name;
            item.appendChild(nameEl);
            list.appendChild(item);
        });
        return list;
    }

    // ─────────────────────────────────────────────────────────────
    // Rendu PC
    // ─────────────────────────────────────────────────────────────

    _updateDesktop(isBonusTurn, isDragonTurn = false) {
        const container = document.getElementById('players-scores');
        if (!container || !this.gameState) return;

        container.innerHTML = '';
        const currentPlayer = this.gameState.getCurrentPlayer();

        // ✨ NOUVEAU : joueurs d'un côté, spectateurs regroupés de l'autre
        const { playersList, spectators } = this._getDisplayGroups();
        playersList.forEach(player => {
            const dragonMover = isDragonTurn ? this.gameState.players[this.gameState.dragonPhase?.moverIndex] : null;
            const isActive = dragonMover
                ? player.id === dragonMover.id
                : currentPlayer && player.id === currentPlayer.id;
            const isGhost  = player.disconnected || player.kicked;

            const card = document.createElement('div');
            card.className = 'player-score-card';
            if (isActive) card.classList.add(isDragonTurn ? 'active-dragon' : isBonusTurn ? 'active-bonus' : 'active');
            if (isGhost)  card.style.opacity = '0.45';

            // ✅ FIX : rôle du panel pendant une sélection de prisonnier — cible (détient les
            // prisonniers proposés), choisisseur (décide lequel récupérer, desktop uniquement),
            // ou aucun des deux (masqué entièrement). Remplace l'ancien `forcedOpen` qui ne
            // couvrait que le panel cible.
            const selection = this._prisonerSelection;
            const isSelectionTarget  = !!(selection && selection.playerId  === player.id);
            const isSelectionChooser = !!(selection && selection.chooserId === player.id);
            const forcedOpen = isSelectionTarget || isSelectionChooser;

            // ✨ NOUVEAU : état d'ouverture indépendant par joueur (plusieurs cartes peuvent rester ouvertes)
            const isOpen = forcedOpen || this._desktopOpenPlayerIds.has(player.id);
            if (isOpen) card.classList.add('open');
            if (isSelectionTarget)  card.classList.add('prisoner-selection-target');
            if (isSelectionChooser) card.classList.add('prisoner-selection-chooser');
            if (selection && !isSelectionTarget && !isSelectionChooser) card.classList.add('prisoner-selection-hidden');
            if (!forcedOpen) {
                card.onclick = () => {
                    if (isOpen) this._desktopOpenPlayerIds.delete(player.id);
                    else this._desktopOpenPlayerIds.add(player.id);
                    this._updateDesktop(this._isBonusTurn, this._isDragonTurn);
                };
            }

            // En-tête : indicateur tour + nom + score
            const header = document.createElement('div');
            header.className = 'player-score-header';

            if (isActive) {
                const indicator = document.createElement('span');
                indicator.className   = isDragonTurn ? 'turn-indicator dragon' : isBonusTurn ? 'turn-indicator bonus' : 'turn-indicator';
                indicator.textContent = '▶';
                header.appendChild(indicator);
                if (isDragonTurn) {
                    const dragonIcon = document.createElement('span');
                    dragonIcon.className   = 'dragon-star';
                    dragonIcon.textContent = '🐉';
                    header.appendChild(dragonIcon);
                } else if (isBonusTurn) {
                    const star = document.createElement('span');
                    star.className   = 'bonus-star';
                    star.textContent = '⭐';
                    header.appendChild(star);
                }
            }

            const name = document.createElement('span');
            name.className   = 'player-score-name';
            name.textContent = (player.kicked ? '🚪 ' : '') + player.name;
            header.appendChild(name);

            if (player.color !== 'spectator') {
                const points = document.createElement('span');
                points.className   = 'player-score-points';
                points.textContent = `${player.score} point${player.score > 1 ? 's' : ''}`;
                header.appendChild(points);
            }

            // ✨ NOUVEAU : chevron indicateur d'ouverture
            const chevron = document.createElement('span');
            chevron.className   = 'player-score-chevron';
            chevron.textContent = '▼';
            header.appendChild(chevron);

            card.appendChild(header);

            // ✨ NOUVEAU : meeples affichés uniquement si la carte est ouverte
            if (isOpen) {
                const meeplesDisplay = document.createElement('div');
                meeplesDisplay.className = 'player-meeples-display';
                this._buildMeeplesDisplay(meeplesDisplay, player, 'panel');
                card.appendChild(meeplesDisplay);
            }

            container.appendChild(card);
        });

        // ✨ NOUVEAU : une seule carte pour tous les spectateurs, en dernière position
        if (spectators.length > 0) container.appendChild(this._buildDesktopSpectatorCard(spectators));
    }

    /**
     * ✨ NOUVEAU : carte unique « Spectateur(s) » (desktop). Repliée : fantôme + libellé.
     * Dépliée : liste des spectateurs avec leur fantôme.
     */
    _buildDesktopSpectatorCard(spectators) {
        const isOpen = this._desktopOpenPlayerIds.has(SPECTATORS_KEY);
        const card = document.createElement('div');
        card.className = 'player-score-card spectator-card';
        if (isOpen) card.classList.add('open');
        // Pendant une sélection de prisonnier, les spectateurs ne sont pas concernés → masqués
        if (this._prisonerSelection) card.classList.add('prisoner-selection-hidden');
        card.onclick = () => {
            if (isOpen) this._desktopOpenPlayerIds.delete(SPECTATORS_KEY);
            else this._desktopOpenPlayerIds.add(SPECTATORS_KEY);
            this._updateDesktop(this._isBonusTurn, this._isDragonTurn);
        };

        const header = document.createElement('div');
        header.className = 'player-score-header';

        const ghost = document.createElement('img');
        ghost.className = 'spectator-ghost-icon';
        ghost.src = './assets/Meeples/Spectator.png';
        ghost.alt = 'Spectateur';
        header.appendChild(ghost);

        const name = document.createElement('span');
        name.className   = 'player-score-name';
        name.textContent = spectators.length > 1 ? `Spectateurs (${spectators.length})` : 'Spectateur';
        header.appendChild(name);

        const chevron = document.createElement('span');
        chevron.className   = 'player-score-chevron';
        chevron.textContent = '▼';
        header.appendChild(chevron);

        card.appendChild(header);

        if (isOpen) card.appendChild(this._buildSpectatorList(spectators));

        return card;
    }

    // ─────────────────────────────────────────────────────────────
    // Rendu mobile — carte fermée (meeple coloré + score + chevron) + détail séparé
    // ─────────────────────────────────────────────────────────────

    _updateMobile(isBonusTurn, isDragonTurn = false) {
        const container = document.getElementById('mobile-players-scores');
        if (!container || !this.gameState) return;

        // ✨ NOUVEAU : mémoriser le défilement manuel — innerHTML = '' le remet à 0 sinon
        const savedScroll = container.scrollLeft;
        container.innerHTML = '';
        const currentPlayer = this.gameState.getCurrentPlayer();

        const { playersList, spectators } = this._getDisplayGroups();
        const dragonMoverM = isDragonTurn ? this.gameState.players[this.gameState.dragonPhase?.moverIndex] : null;
        const activeId = dragonMoverM ? dragonMoverM.id : (currentPlayer?.id ?? null);
        let activeCard = null;

        playersList.forEach(player => {
            const isActive = dragonMoverM
                ? player.id === dragonMoverM.id
                : currentPlayer && player.id === currentPlayer.id;
            const isGhost  = player.disconnected || player.kicked;

            // ✨ NOUVEAU : forcedOpen — sur mobile un seul panel peut être affiché à la fois,
            // donc seul le panel CIBLE (celui qui détient les prisonniers) est forcé ouvert ;
            // il n'y a pas de rôle "choisisseur" distinct côté mobile (cf. discussion produit).
            const selection = this._prisonerSelection;
            const isSelectionTarget = !!(selection && selection.playerId === player.id);
            const forcedOpen = isSelectionTarget;
            if (forcedOpen && this._mobileOpenPlayerId !== player.id) this._mobileOpenPlayerId = player.id;
            const isOpen = forcedOpen || this._mobileOpenPlayerId === player.id;

            const activeClass = isDragonTurn ? ' active active-dragon' : isBonusTurn ? ' active active-bonus' : ' active';
            const card = document.createElement('div');
            card.className = 'mobile-player-card' + (isActive ? activeClass : '') + (isOpen ? ' open' : ''); // ✨ NOUVEAU : classe open
            if (isGhost) card.style.opacity = '0.45';
            card.dataset.playerId = player.id;
            card.title = player.name;
            if (isActive) activeCard = card;

            // ✅ FIX : pendant une sélection, toutes les cartes de la barre du haut sauf celle
            // du joueur cible sont masquées (demande explicite : sur mobile un seul panel
            // possible, donc on cache aussi les cartes fermées des autres joueurs).
            if (selection && !isSelectionTarget) card.classList.add('prisoner-selection-hidden');
            // ✅ FIX : la carte fermée du joueur cible (meeple + score) est elle aussi recouverte par le calque sombre
            if (isSelectionTarget) card.classList.add('prisoner-selection-target');

            // ✨ NOUVEAU : plus de pseudo sur la carte (place) — seul le meeple normal coloré
            // identifie le joueur ; le pseudo est dans l'en-tête du détail (_renderMobileDetail).
            const name = document.createElement('div');
            name.className = 'mobile-player-name';
            if (player.color !== 'spectator') {
                const colorCap = player.color.charAt(0).toUpperCase() + player.color.slice(1);
                const colorIcon = document.createElement('img');
                colorIcon.className = 'mobile-player-color-icon';
                colorIcon.src = `./assets/Meeples/${colorCap}/Normal.png`;
                colorIcon.alt = player.color;
                name.appendChild(colorIcon);
            }
            card.appendChild(name);

            if (player.color !== 'spectator') {
                const score = document.createElement('div');
                score.className   = 'mobile-player-score';
                score.textContent = player.score + ' pts';
                card.appendChild(score);
            }

            // ✨ NOUVEAU : chevron — la carte ne montre plus les meeples en ligne,
            // il faut l'ouvrir pour voir le détail (ci-dessous)
            const chevron = document.createElement('div');
            chevron.className   = 'mobile-player-chevron';
            chevron.textContent = '▼';
            card.appendChild(chevron);

            // ✨ NOUVEAU : clic = ouvrir/fermer le détail de ce joueur (un seul à la fois),
            // sauf pendant une sélection de prisonnier forcée sur ce joueur (voir forcedOpen ci-dessus).
            if (!forcedOpen) {
                card.onclick = () => {
                    this._mobileOpenPlayerId = isOpen ? null : player.id;
                    this._updateMobile(this._isBonusTurn, this._isDragonTurn);
                };
            }

            container.appendChild(card);
        });

        // ✨ NOUVEAU : carte unique « Spectateurs » (fantôme + nombre), en dernière position
        if (spectators.length > 0) container.appendChild(this._buildMobileSpectatorCard(spectators));

        // ✨ NOUVEAU : défilement — recentrer la carte du joueur actif UNIQUEMENT quand il change
        // (forcé, même si la rangée avait été défilée à la main) ; sinon restaurer le défilement manuel.
        // Calcul synchrone (pas de requestAnimationFrame : suspendu en onglet caché, cf. ARCHITECTURE.md).
        if (activeCard && container.clientWidth > 0 && activeId !== this._lastActiveId) {
            const cr = container.getBoundingClientRect();
            const r  = activeCard.getBoundingClientRect();
            container.scrollLeft += (r.left + r.width / 2) - (cr.left + cr.width / 2);
            this._lastActiveId = activeId;
        } else {
            container.scrollLeft = savedScroll;
        }
        this._updateScrollFade(); // ✨ NOUVEAU : le contenu vient d'être reconstruit

        this._renderMobileDetail(); // ✨ NOUVEAU
    }

    /**
     * ✨ NOUVEAU : carte compacte « Spectateurs » de la barre mobile (fantôme + nombre + chevron).
     */
    _buildMobileSpectatorCard(spectators) {
        const isOpen = this._mobileOpenPlayerId === SPECTATORS_KEY;
        const card = document.createElement('div');
        card.className = 'mobile-player-card mobile-spectator-card' + (isOpen ? ' open' : '');
        card.dataset.playerId = SPECTATORS_KEY;
        // Pendant une sélection de prisonnier, les spectateurs ne sont pas concernés → masqués
        if (this._prisonerSelection) card.classList.add('prisoner-selection-hidden');

        const name = document.createElement('div');
        name.className = 'mobile-player-name';
        const ghost = document.createElement('img');
        ghost.className = 'mobile-player-color-icon';
        ghost.src = './assets/Meeples/Spectator.png';
        ghost.alt = 'Spectateurs';
        name.appendChild(ghost);
        card.appendChild(name);

        const count = document.createElement('div');
        count.className   = 'mobile-player-score mobile-spectator-count';
        count.textContent = `×${spectators.length}`;
        card.appendChild(count);

        const chevron = document.createElement('div');
        chevron.className   = 'mobile-player-chevron';
        chevron.textContent = '▼';
        card.appendChild(chevron);

        card.onclick = () => {
            this._mobileOpenPlayerId = isOpen ? null : SPECTATORS_KEY;
            this._updateMobile(this._isBonusTurn, this._isDragonTurn);
        };

        return card;
    }

    /**
     * ✨ NOUVEAU : affiche le détail (meeples + marchandises) du joueur actuellement ouvert
     * dans le conteneur séparé #mobile-player-detail, centré sous la barre de cartes.
     * Joueur : en-tête (meeple, pseudo, score — classes isolées, facilement masquables en CSS)
     * puis inventaire. Spectateurs : liste des pseudos.
     */
    _renderMobileDetail() {
        const container = document.getElementById('mobile-player-detail');
        if (!container) return;
        container.innerHTML = '';

        if (!this._mobileOpenPlayerId || !this.gameState) return;

        // ── Carte Spectateurs : liste regroupée ──
        if (this._mobileOpenPlayerId === SPECTATORS_KEY) {
            const { spectators } = this._getDisplayGroups();
            if (spectators.length === 0) { this._mobileOpenPlayerId = null; return; } // plus aucun spectateur
            const specCard = document.createElement('div');
            specCard.className = 'mobile-player-detail-card';
            const title = document.createElement('div');
            title.className   = 'mobile-player-detail-header';
            const titleText = document.createElement('span');
            titleText.className   = 'mobile-player-detail-name';
            titleText.textContent = spectators.length > 1 ? `Spectateurs (${spectators.length})` : 'Spectateur';
            title.appendChild(titleText);
            specCard.appendChild(title);
            specCard.appendChild(this._buildSpectatorList(spectators));
            container.appendChild(specCard);
            return;
        }

        const player = this.gameState.players.find(p => p.id === this._mobileOpenPlayerId);
        if (!player) { this._mobileOpenPlayerId = null; return; } // joueur parti/déconnecté

        const card = document.createElement('div');
        card.className = 'mobile-player-detail-card';

        // ✅ FIX : pendant une sélection ciblant ce joueur, le détail reçoit le calque sombre local
        // (prisonniers sélectionnables laissés au-dessus) — voir style.css.
        if (this._prisonerSelection?.playerId === player.id) {
            card.classList.add('prisoner-selection-target');
        }

        // ✨ NOUVEAU : en-tête pseudo/score (le pseudo n'est plus sur la carte fermée).
        // Isolé dans .mobile-player-detail-header : `display:none` en CSS suffit pour le retirer.
        if (player.color !== 'spectator') {
            const colorCap = player.color.charAt(0).toUpperCase() + player.color.slice(1);
            const header = document.createElement('div');
            header.className = 'mobile-player-detail-header';
            const icon = document.createElement('img');
            icon.className = 'mobile-player-color-icon';
            icon.src = `./assets/Meeples/${colorCap}/Normal.png`;
            icon.alt = player.color;
            header.appendChild(icon);
            const nameEl = document.createElement('span');
            nameEl.className   = 'mobile-player-detail-name';
            nameEl.textContent = (player.kicked ? '🚪 ' : '') + player.name;
            header.appendChild(nameEl);
            const scoreEl = document.createElement('span');
            scoreEl.className   = 'mobile-player-detail-score';
            scoreEl.textContent = `${player.score} pts`;
            header.appendChild(scoreEl);
            card.appendChild(header);
        }

        const meeplesDisplay = document.createElement('div');
        meeplesDisplay.className = 'mobile-player-meeples';
        this._buildMeeplesDisplay(meeplesDisplay, player, 'panelMobile');
        card.appendChild(meeplesDisplay);

        container.appendChild(card);
    }

    // ─────────────────────────────────────────────────────────────
    // ✨ NOUVEAU — Rangées du panneau joueur (voir en-tête de classe)
    // ─────────────────────────────────────────────────────────────

    /**
     * Point de branchement UNIQUE des pièces des extensions pas encore implémentées.
     * Retourne un objet { mayor, wagon, shepherd, ringmaster, barn, castle, bridge, sheep } (compteurs),
     * { king, robber, monastery } (booléens : le joueur détient la pièce unique) et { fakePrisoners }.
     * Une clé absente = pièce non affichée. Aujourd'hui seul l'aperçu debug alimente cet objet ;
     * à l'ajout réel d'une extension, lire ici la donnée réelle (player.xxx / gameState.extraState.xxx).
     */
    _getPieceExtras(player) {
        const idx = this.gameState.players.indexOf(player);
        return getScorePanelPreviewExtras(idx) ?? {}; // ← aperçu provisoire (ScorePanelPreview.js)
    }

    /** Rangée en flux libre avec retour à la ligne (styles en ligne, comme l'ancienne rangée de marchandises). */
    _makeRow(className) {
        const row = document.createElement('div');
        row.className = className;
        row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;';
        return row;
    }

    /**
     * Chip = icône + compteur « ×N » superposé en bas à droite (absent si count === null).
     * Grisé (.unavailable, l'icône seulement) quand count <= 0.
     * @param {object} p
     * @param {string} p.type      — clé MeepleConfig (taille)
     * @param {string} p.src
     * @param {string} p.alt
     * @param {number|null} p.count
     * @param {string} p.context
     * @param {boolean} [p.heightAuto] — conserve le ratio propre à l'image (ex. Tour)
     * @param {{width:string,height:string}} [p.size] — remplace la taille MeepleConfig (ex. marchandises)
     */
    _buildChip({ type, src, alt, count, context, heightAuto = false, size = null }) {
        const wrap = document.createElement('span');
        wrap.className = 'meeple-chip';
        wrap.style.cssText = 'position:relative;display:inline-flex;';

        const img = document.createElement('img');
        img.src = src;
        img.alt = alt;
        const { width, height } = size ?? getMeepleSize(type, context);
        img.style.width     = width;
        img.style.height    = heightAuto ? 'auto' : height;
        img.style.objectFit = 'contain';
        if (count !== null && count <= 0) img.classList.add('unavailable');
        wrap.appendChild(img);

        if (count !== null) {
            const countEl = document.createElement('span');
            countEl.className   = 'meeple-chip-count';
            countEl.textContent = `×${count}`;
            countEl.style.cssText =
                'position:absolute;right:-4px;bottom:-4px;min-width:8px;padding:0 3px;border-radius:7px;' +
                'background:rgba(0,0,0,0.7);color:#fff;font-weight:bold;line-height:13px;text-align:center;' +
                `font-size:${context === 'panel' ? '10px' : '9px'};pointer-events:none;`;
            wrap.appendChild(countEl);
        }
        return wrap;
    }

    /**
     * Prisonnier : meeple à la couleur de son propriétaire d'origine, derrière des barreaux.
     * `clickHandler` null → non cliquable (le clic est quand même absorbé : il ne doit pas
     * basculer l'ouverture de la carte).
     */
    _buildPrisonerChip(type, ownerColorCap, context, clickHandler) {
        // ✅ FIX : un paysan (Farmer/Large-Farmer) capturé rejoint le même pool
        // générique player.meeples / hasLargeMeeple qu'un meeple normal — une fois
        // en prison, il n'y a plus de distinction "paysan" dans l'état de jeu.
        // Le sprite Farmer étant dessiné couché (posture "dans le champ"), l'afficher
        // tel quel dans la case prisonnier était trompeur. On affiche donc toujours
        // le sprite Normal/Large — `entry.type` (donnée réelle utilisée par le rachat
        // et l'échange automatique) reste inchangé, seul le sprite affiché change.
        const displayType = type === 'Farmer' ? 'Normal' : type === 'Large-Farmer' ? 'Large' : type;

        const wrap = document.createElement('span');
        wrap.style.cssText = 'position:relative;display:inline-flex;';

        const img = document.createElement('img');
        img.src = `./assets/Meeples/${ownerColorCap}/${displayType}.png`;
        const { width, height } = getMeepleSize(displayType, context);
        img.style.width  = width;
        img.style.height = height;
        img.style.objectFit = 'contain';
        wrap.appendChild(img);

        // Grille de capture — même traitement visuel prévu dans le document de design
        const bars = document.createElement('div');
        bars.style.cssText = 'position:absolute;inset:0;background:repeating-linear-gradient(90deg, rgba(0,0,0,0.85) 0 1.5px, transparent 1.5px 6px);pointer-events:none;';
        wrap.appendChild(bars);

        if (clickHandler) wrap.classList.add('prisoner-selectable');
        // ✅ FIX : stopPropagation systématique, même sans clickHandler — sinon un clic
        // sur un prisonnier non rachetable (pas assez de points, pas le sien, etc.)
        // remonte jusqu'à la carte et en bascule l'ouverture/fermeture (PC), ou ne fait
        // rien de visible mais laisse un comportement incohérent (mobile). "Rien ne doit
        // se passer" doit vraiment signifier rien, y compris l'absence de cet effet de bord.
        wrap.onclick = (e) => {
            e.stopPropagation();
            if (clickHandler) clickHandler();
        };
        return wrap;
    }

    // ─────────────────────────────────────────────────────────────
    // Méthode partagée : construit les rangées dans un container
    // context : 'panel' (PC) | 'panelMobile' (mobile)
    //
    // ✨ NOUVEAU : 4 rangées dans un ordre fixe (meeples / structures / jetons / butin),
    // chaque rangée n'étant rendue que si elle contient au moins un élément. Pour brancher une
    // nouvelle pièce : l'ajouter dans la bonne rangée ci-dessous (+ sa donnée dans _getPieceExtras
    // et sa taille dans MeepleConfig.js).
    // ─────────────────────────────────────────────────────────────

    _buildMeeplesDisplay(container, player, context) {
        const colorCap = player.color.charAt(0).toUpperCase() + player.color.slice(1);
        const isSpectator = player.color === 'spectator';

        // Spectateur : juste le fantôme, pas de meeples ni marchandises
        if (isSpectator) {
            const ghost = document.createElement('img');
            ghost.src = './assets/Meeples/Spectator.png';
            ghost.alt = 'Spectateur';
            const ghostSize = getMeepleSize('Spectator', context);
            ghost.style.width   = ghostSize.width;
            ghost.style.height  = ghostSize.height;
            ghost.style.opacity = '0.7';
            ghost.style.objectFit = 'contain';
            container.appendChild(ghost);
            return;
        }

        const ext    = this.config?.extensions ?? {};
        const extras = this._getPieceExtras(player);

        // Raccourcis de construction (compteur partout, sauf mention contraire)
        const colored = (type, file, count, alt = type) => this._buildChip({
            type, src: `./assets/Meeples/${colorCap}/${file}`, alt, count, context });
        const misc = (type, file, count, alt = type) => this._buildChip({
            type, src: `./assets/Misc/C2/${file}`, alt, count, context });

        // ── Rangée 1 : meeples ───────────────────────────────────────────
        const meeplesRow = this._makeRow('meeples-row');
        meeplesRow.appendChild(colored('Normal', 'Normal.png', player.meeples));
        if (ext.abbot)       meeplesRow.appendChild(colored('Abbot', 'Abbot.png', player.hasAbbot ? 1 : 0));
        if (ext.largeMeeple) meeplesRow.appendChild(colored('Large', 'Large.png', player.hasLargeMeeple ? 1 : 0));
        // ✨ NOUVEAU : meeples des futures extensions (données via _getPieceExtras)
        if (extras.mayor      !== undefined) meeplesRow.appendChild(colored('Mayor',      'Mayor.png',      extras.mayor,      'Maire'));
        if (extras.wagon      !== undefined) meeplesRow.appendChild(colored('Wagon',      'Wagon.png',      extras.wagon,      'Chariot'));
        if (extras.shepherd   !== undefined) meeplesRow.appendChild(colored('Shepherd',   'Shepherd.png',   extras.shepherd,   'Berger'));
        if (extras.ringmaster !== undefined) meeplesRow.appendChild(colored('Ringmaster', 'Ringmaster.png', extras.ringmaster, 'Directeur de cirque'));
        // Bâtisseur + Cochon : bloc insécable (retour à la ligne des deux d'un coup, ou aucun)
        const specialPair = document.createElement('span');
        specialPair.style.cssText = 'display:inline-flex;flex-wrap:nowrap;align-items:center;gap:6px;';
        if (ext.tradersBuilders) specialPair.appendChild(colored('Builder', 'Builder.png', player.hasBuilder ? 1 : 0));
        if (ext.pig)             specialPair.appendChild(colored('Pig', 'Pig.png', player.hasPig ? 1 : 0));
        if (specialPair.childNodes.length > 0) meeplesRow.appendChild(specialPair);
        if (meeplesRow.childNodes.length > 0) container.appendChild(meeplesRow);

        // ── Rangée 2 : structures ────────────────────────────────────────
        const structuresRow = this._makeRow('structures-row');
        if (extras.barn   !== undefined) structuresRow.appendChild(colored('Barn', 'Barn.png', extras.barn, 'Grange'));
        if (extras.castle !== undefined) structuresRow.appendChild(misc('Castle', 'Castle.png', extras.castle, 'Forteresse'));
        // Pièces de Tour — la hauteur reste 'auto' pour préserver le ratio de l'image
        if (ext.tower) {
            structuresRow.appendChild(this._buildChip({
                type: 'Tower', src: './assets/Meeples/Tower01.png', alt: 'Tour',
                count: player.towerPieces ?? 0, context, heightAuto: true }));
        }
        if (extras.bridge !== undefined) structuresRow.appendChild(this._buildChip({
            type: 'Bridge', src: './assets/Meeples/Bridge.png', alt: 'Pont', count: extras.bridge, context }));
        if (structuresRow.childNodes.length > 0) container.appendChild(structuresRow);

        // ── Rangée 3 : jetons ────────────────────────────────────────────
        const tokensRow = this._makeRow('tokens-row');
        if (ext.merchants) {
            const goods     = player.goods || { cloth: 0, wheat: 0, wine: 0 };
            const goodsSize = getGoodsSize(context === 'panel' ? 'panel' : 'panelMobile');
            [
                { key: 'wheat', file: 'Wheat.png', alt: 'Blé'   },
                { key: 'wine',  file: 'Wine.png',  alt: 'Vin'   },
                { key: 'cloth', file: 'Cloth.png', alt: 'Tissu' },
            ].forEach(({ key, file, alt }) => {
                tokensRow.appendChild(this._buildChip({
                    type: key, src: `./assets/Misc/C2/${file}`, alt,
                    count: goods[key] ?? 0, context, size: goodsSize }));
            });
        }
        if (extras.sheep !== undefined) tokensRow.appendChild(misc('Sheep', 'Sheep1.png', extras.sheep, 'Mouton'));
        // Roi / Brigand : jeton unique partagé, affiché seulement chez le joueur qui le détient, sans compteur
        if (extras.king)   tokensRow.appendChild(misc('King',   'TokenKing.png',   null, 'Roi'));
        if (extras.robber) tokensRow.appendChild(misc('Robber', 'TokenRobber.png', null, 'Brigand'));
        if (tokensRow.childNodes.length > 0) container.appendChild(tokensRow);

        // ── Rangée 4 : butin = tuile monastère (gauche) + prisonniers (droite) ──
        const prisoners = [];
        const selection = this._prisonerSelection;
        const isSelectionPanel = selection && selection.playerId === player.id;

        if (ext.tower) {
            // ✨ NOUVEAU : gameState.prisoners a été déplacé sous gameState.extraState.prisoners
            const myPrisoners = this.gameState?.extraState?.prisoners?.[player.id] ?? [];
            myPrisoners.forEach((entry) => {
                const { type, ownerId } = entry;
                const ownerPlayer = this.gameState.players.find(p => p.id === ownerId);
                const ownerColorCap = (ownerPlayer?.color ?? 'black').charAt(0).toUpperCase() + (ownerPlayer?.color ?? 'black').slice(1);

                // ✨ NOUVEAU : priorité à une session d'échange automatique en cours sur CE
                // panel (mécanisme temporaire et ciblé) ; sinon, retombe sur le gestionnaire
                // de rachat (mécanisme permanent, actif sur tous les panels — voir
                // TowerUI.setupPrisonerBuyback). Les deux ne peuvent jamais s'appliquer
                // simultanément au même prisonnier : le rachat se désactive de lui-même
                // tant qu'un échange automatique attend sa résolution.
                let clickHandler = null;
                if (isSelectionPanel && selection.isSelectable(entry)) {
                    clickHandler = () => selection.onSelect(entry);
                } else if (this._buybackHandler && this._buybackHandler.isSelectable(entry, player.id)) {
                    clickHandler = () => this._buybackHandler.onSelect(entry, player.id);
                }
                prisoners.push(this._buildPrisonerChip(type, ownerColorCap, context, clickHandler));
            });
        }
        // ✨ NOUVEAU : prisonniers fictifs de l'aperçu debug (jamais cliquables)
        for (let i = 0; i < (extras.fakePrisoners ?? 0); i++) {
            prisoners.push(this._buildPrisonerChip('Normal', PREVIEW_COLORS[i % PREVIEW_COLORS.length], context, null));
        }

        if (extras.monastery || prisoners.length > 0) {
            const lootRow = document.createElement('div');
            lootRow.className = 'loot-row';
            lootRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;';

            // Tuile monastère unique, à gauche, sans compteur
            if (extras.monastery) {
                const tile = document.createElement('img');
                tile.src = './assets/Misc/C2/Monastery.jpg';
                tile.alt = 'Tuile monastère';
                const { width, height } = getMeepleSize('Monastery', context);
                tile.style.cssText = `width:${width};height:${height};flex-shrink:0;object-fit:contain;border-radius:3px;`;
                lootRow.appendChild(tile);
            }

            // Prisonniers à droite (toute la largeur s'il n'y a pas de tuile)
            if (prisoners.length > 0) {
                const prisonRow = document.createElement('div');
                prisonRow.className = 'prison-row';
                prisonRow.style.cssText = 'flex:1;min-width:0;align-content:flex-start;align-items:flex-start;';
                prisoners.forEach(p => prisonRow.appendChild(p));
                lootRow.appendChild(prisonRow);
            }
            container.appendChild(lootRow);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // ✨ NOUVEAU — Sélection de prisonniers (mécanisme générique)
    //
    // Utilisé aujourd'hui par l'échange automatique de prisonniers (extension Tour,
    // cf. TowerUI.js). Prévu pour être réutilisé plus tard par le rachat de prisonnier
    // (probablement sans forceOpenPlayerPanel()/voile gris dans ce futur cas d'usage —
    // ces éléments-là restent entièrement à la charge de l'appelant, ce mécanisme ne
    // fait que rendre des entrées cliquables dans le panel indiqué).
    // ─────────────────────────────────────────────────────────────

    /**
     * Active la sélection sur le panel du joueur `playerId` (celui qui DÉTIENT les
     * prisonniers proposés) : les entrées de sa ligne "prisonniers" qui satisfont
     * `isSelectable(entry)` (entry = { type, ownerId }) deviennent cliquables et appellent
     * `onSelect(entry)` au clic.
     *
     * @param {string}   params.playerId    — joueur détenteur des prisonniers (panel "cible")
     * @param {string}   [params.chooserId] — ✅ FIX NOUVEAU : joueur qui choisit (panel mis en
     *        avant mais assombri sur desktop ; ignoré sur mobile où un seul panel est visible).
     *        Optionnel pour compatibilité — sans lui, seul le panel cible est mis en avant et
     *        tous les autres panels (y compris celui du choisisseur) sont masqués.
     * @param {Function} params.isSelectable
     * @param {Function} params.onSelect
     */
    enablePrisonerSelection({ playerId, chooserId = null, isSelectable, onSelect }) {
        this._prisonerSelection = { playerId, chooserId, isSelectable, onSelect };
        document.body.classList.add('prisoner-selection-mode');
        this.update(this._isBonusTurn, this._isDragonTurn);
    }

    /**
     * Désactive la sélection de prisonniers (voir enablePrisonerSelection).
     */
    disablePrisonerSelection() {
        this._prisonerSelection = null;
        document.body.classList.remove('prisoner-selection-mode');
        this.update(this._isBonusTurn, this._isDragonTurn);
    }

    /**
     * Force l'ouverture du panel d'un joueur (desktop ET mobile), utilisé pour afficher
     * automatiquement le panel adverse concerné lors d'une sélection de prisonnier.
     */
    forceOpenPlayerPanel(playerId) {
        this._desktopOpenPlayerIds.add(playerId);
        this._mobileOpenPlayerId = playerId;
        this.update(this._isBonusTurn, this._isDragonTurn);
    }

    /**
     * ✨ NOUVEAU : enregistre le gestionnaire PERMANENT de rachat de prisonnier, appliqué à
     * tous les panels en continu (contrairement à enablePrisonerSelection, ciblé et temporaire).
     * Voir TowerUI.setupPrisonerBuyback() pour l'utilisation actuelle.
     */
    setBuybackHandler({ isSelectable, onSelect }) {
        this._buybackHandler = { isSelectable, onSelect };
        this.update(this._isBonusTurn, this._isDragonTurn);
    }

    destroy() {
        console.log('🧹 ScorePanelUI: cleanup');
        const desktopDiv = document.getElementById('players-scores');
        if (desktopDiv) desktopDiv.innerHTML = '';
        const mobileDiv = document.getElementById('mobile-players-scores');
        if (mobileDiv) mobileDiv.innerHTML = '';
        const detailDiv = document.getElementById('mobile-player-detail'); // ✨ NOUVEAU
        if (detailDiv) detailDiv.innerHTML = '';
        this._mobileOpenPlayerId = null; // ✨ NOUVEAU
        this._desktopOpenPlayerIds.clear(); // ✨ NOUVEAU
        this._prisonerSelection = null; // ✨ NOUVEAU
        this._buybackHandler = null; // ✨ NOUVEAU
        this._lastActiveId = null; // ✨ NOUVEAU
        document.body.classList.remove('prisoner-selection-mode'); // ✨ NOUVEAU

        // ✨ NOUVEAU : arrêter le suivi de la hauteur de barre
        if (this._barObserver) { this._barObserver.disconnect(); this._barObserver = null; }
        if (this._onWinResize) { window.removeEventListener('resize', this._onWinResize); this._onWinResize = null; }
        if (this._scrollEl) {
            this._scrollEl.removeEventListener('scroll', this._onScroll);
            this._scrollEl.classList.remove('can-scroll-left', 'can-scroll-right');
            this._scrollEl = null; this._onScroll = null;
        }

        removeScorePanelPreview(); // ✨ NOUVEAU : retire le bouton d'aperçu debug

        this.eventBus.off('score-updated',        this._onScoreUpdated);
        this.eventBus.off('meeple-count-updated', this._onMeepleCountUpdated);
    }
}
