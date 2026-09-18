import { getMeepleSize, getGoodsSize } from '../MeepleConfig.js';

/**
 * ScorePanelUI - Affichage des joueurs : panel PC + barre mobile
 *
 * Toute la logique de rendu des meeples est centralisée dans
 * _buildMeeplesDisplay(), appelée par les deux rendus (PC et mobile).
 *
 * ✨ NOUVEAU : sur mobile, la barre de cartes reste toujours visible et fermée
 * (nom + score + chevron). Un clic sur une carte ouvre son détail (meeples +
 * marchandises) dans un conteneur séparé (#mobile-player-detail), centré,
 * un seul joueur ouvert à la fois (accordéon — cohérent avec l'espace limité).
 * Le panel PC (#players-scores) n'est pas concerné, il reste toujours déplié.
 *
 * ✨ NOUVEAU — Sélection de prisonniers (mécanisme générique) : voir
 * enablePrisonerSelection()/disablePrisonerSelection()/forceOpenPlayerPanel() plus bas.
 * Utilisé aujourd'hui par l'échange automatique de prisonniers (extension Tour, cf.
 * TowerUI.js), et prévu pour être réutilisé plus tard par le rachat de prisonnier.
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
        // Forme : { playerId, isSelectable(entry), onSelect(entry) } où entry = { type, ownerId },
        // ou null si aucune sélection en cours.
        this._prisonerSelection = null;

        // ✨ NOUVEAU : gestionnaire de rachat de prisonnier — PERMANENT (contrairement à
        // _prisonerSelection ci-dessus, qui ne cible qu'un panel précis pour la durée d'une
        // session). Appliqué à TOUS les panels en continu. Forme :
        // { isSelectable(entry, panelPlayerId), onSelect(entry, panelPlayerId) }, ou null.
        // Enregistré une fois par TowerUI.setupPrisonerBuyback() au démarrage de la partie.
        this._buybackHandler = null;
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
    // Rendu PC
    // ─────────────────────────────────────────────────────────────

    _updateDesktop(isBonusTurn, isDragonTurn = false) {
        const container = document.getElementById('players-scores');
        if (!container || !this.gameState) return;

        container.innerHTML = '';
        const currentPlayer = this.gameState.getCurrentPlayer();

        // Filtrer les entrées spec dont le nom est présent comme joueur actif (non ghost)
        // Si le fantôme est disconnected/kicked, on garde l'entrée spec (elle représente l'observateur)
        const activeNames = new Set(
            this.gameState.players
                .filter(p => p.color !== 'spectator' && !p.disconnected && !p.kicked)
                .map(p => p.name)
        );
        const sortedPlayers = [...this.gameState.players]
            .filter(p => p.color !== 'spectator' || !activeNames.has(p.name))
            .sort((a, b) => {
                if (a.color === 'spectator' && b.color !== 'spectator') return 1;
                if (a.color !== 'spectator' && b.color === 'spectator') return -1;
                return 0;
            });
        sortedPlayers.forEach(player => {
            const dragonMover = isDragonTurn ? this.gameState.players[this.gameState.dragonPhase?.moverIndex] : null;
            const isActive = dragonMover
                ? player.id === dragonMover.id
                : currentPlayer && player.id === currentPlayer.id;
            const isGhost  = player.disconnected || player.kicked;

            const card = document.createElement('div');
            card.className = 'player-score-card';
            if (isActive) card.classList.add(isDragonTurn ? 'active-dragon' : isBonusTurn ? 'active-bonus' : 'active');
            if (isGhost)  card.style.opacity = '0.45';

            // ✨ NOUVEAU : pendant une sélection de prisonnier forcée sur ce joueur, le panel
            // reste ouvert et ne peut pas être refermé par un clic sur l'en-tête (sinon on
            // perdrait la possibilité de cliquer les prisonniers sélectionnables affichés dedans).
            const forcedOpen = this._prisonerSelection?.playerId === player.id;
            // ✨ NOUVEAU : état d'ouverture indépendant par joueur (plusieurs cartes peuvent rester ouvertes)
            const isOpen = forcedOpen || this._desktopOpenPlayerIds.has(player.id);
            if (isOpen) card.classList.add('open');
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
    }

    // ─────────────────────────────────────────────────────────────
    // Rendu mobile — carte fermée (nom + score + chevron) + détail séparé
    // ─────────────────────────────────────────────────────────────

    _updateMobile(isBonusTurn, isDragonTurn = false) {
        const container = document.getElementById('mobile-players-scores');
        if (!container || !this.gameState) return;

        container.innerHTML = '';
        const currentPlayer = this.gameState.getCurrentPlayer();

        const activeNamesMobile = new Set(
            this.gameState.players
                .filter(p => p.color !== 'spectator' && !p.disconnected && !p.kicked)
                .map(p => p.name)
        );
        const sortedPlayersMobile = [...this.gameState.players]
            .filter(p => p.color !== 'spectator' || !activeNamesMobile.has(p.name))
            .sort((a, b) => {
                if (a.color === 'spectator' && b.color !== 'spectator') return 1;
                if (a.color !== 'spectator' && b.color === 'spectator') return -1;
                return 0;
            });
        sortedPlayersMobile.forEach(player => {
            const dragonMoverM = isDragonTurn ? this.gameState.players[this.gameState.dragonPhase?.moverIndex] : null;
            const isActive = dragonMoverM
                ? player.id === dragonMoverM.id
                : currentPlayer && player.id === currentPlayer.id;
            const isGhost  = player.disconnected || player.kicked;

            // ✨ NOUVEAU : forcedOpen — même logique que desktop, empêche la fermeture pendant
            // une sélection de prisonnier forcée sur ce joueur. On synchronise aussi
            // _mobileOpenPlayerId pour que _renderMobileDetail() affiche bien ce joueur.
            const forcedOpen = this._prisonerSelection?.playerId === player.id;
            if (forcedOpen && this._mobileOpenPlayerId !== player.id) this._mobileOpenPlayerId = player.id;
            const isOpen = forcedOpen || this._mobileOpenPlayerId === player.id;

            const activeClass = isDragonTurn ? ' active active-dragon' : isBonusTurn ? ' active active-bonus' : ' active';
            const card = document.createElement('div');
            card.className = 'mobile-player-card' + (isActive ? activeClass : '') + (isOpen ? ' open' : ''); // ✨ NOUVEAU : classe open
            if (isGhost) card.style.opacity = '0.45';
            card.dataset.playerId = player.id;

            const name = document.createElement('div');
            name.className = 'mobile-player-name';
            // ✨ NOUVEAU : petit meeple normal coloré à côté du pseudo — identifie le joueur même panel fermé
            if (player.color !== 'spectator') {
                const colorCap = player.color.charAt(0).toUpperCase() + player.color.slice(1);
                const colorIcon = document.createElement('img');
                colorIcon.className = 'mobile-player-color-icon';
                colorIcon.src = `./assets/Meeples/${colorCap}/Normal.png`;
                colorIcon.alt = player.color;
                name.appendChild(colorIcon);
            }
            const nameText = document.createElement('span');
            nameText.className   = 'mobile-player-name-text';
            nameText.textContent = (player.kicked ? '🚪 ' : '') + player.name;
            name.appendChild(nameText);
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

        this._renderMobileDetail(); // ✨ NOUVEAU
    }

    /**
     * ✨ NOUVEAU : affiche le détail (meeples + marchandises) du joueur actuellement ouvert
     * dans le conteneur séparé #mobile-player-detail, centré sous la barre de cartes.
     */
    _renderMobileDetail() {
        const container = document.getElementById('mobile-player-detail');
        if (!container) return;
        container.innerHTML = '';

        if (!this._mobileOpenPlayerId || !this.gameState) return;

        const player = this.gameState.players.find(p => p.id === this._mobileOpenPlayerId);
        if (!player) { this._mobileOpenPlayerId = null; return; } // joueur parti/déconnecté

        const card = document.createElement('div');
        card.className = 'mobile-player-detail-card';

        // ✨ NOUVEAU : plus d'en-tête pseudo/pastille ici — déjà visible dans la carte fermée juste au-dessus,
        // la couleur des meeples affichés suffit à identifier de qui il s'agit.
        const meeplesDisplay = document.createElement('div');
        meeplesDisplay.className = 'mobile-player-meeples';
        this._buildMeeplesDisplay(meeplesDisplay, player, 'panelMobile');
        card.appendChild(meeplesDisplay);

        container.appendChild(card);
    }

    // ─────────────────────────────────────────────────────────────
    // Méthode partagée : construit les meeples dans un container
    // context : 'panel' (PC) | 'panelMobile' (mobile)
    //
    // ✨ NOUVEAU : icône unique + compteur "×N" pour chaque type de meeple,
    // au lieu de répéter une icône par exemplaire (7 icônes normal meeple,
    // ou une icône par exemplaire pour abbé/grand meeple/bâtisseur/cochon).
    // Grisée (classe .unavailable) quand le compteur est à 0.
    // Appliqué de façon identique PC et mobile.
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

        // ✨ NOUVEAU : construit un chip icône + "×N", grisé si count <= 0
        const buildMeepleChip = (type, imgFile, count) => {
            const wrap = document.createElement('span');
            wrap.className = 'meeple-chip';

            const img = document.createElement('img');
            img.src = `./assets/Meeples/${colorCap}/${imgFile}`;
            img.alt = type;
            const { width, height } = getMeepleSize(type, context);
            img.style.width     = width;
            img.style.height    = height;
            img.style.objectFit = 'contain';
            if (count <= 0) img.classList.add('unavailable');
            wrap.appendChild(img);

            const countEl = document.createElement('span');
            countEl.className   = 'meeple-chip-count';
            countEl.textContent = `×${count}`;
            wrap.appendChild(countEl);

            return wrap;
        };

        // ✨ NOUVEAU — Ligne 1 : meeples classiques + spéciaux (séparés par une barre)
        // (Emplacement réservé pour une future ligne "structures" entre celle-ci et les marchandises)
        const meeplesRow = document.createElement('div');
        meeplesRow.className = 'meeples-row';

        meeplesRow.appendChild(buildMeepleChip('Normal', 'Normal.png', player.meeples));
        if (this.config?.extensions?.abbot) {
            meeplesRow.appendChild(buildMeepleChip('Abbot', 'Abbot.png', player.hasAbbot ? 1 : 0));
        }
        if (this.config?.extensions?.largeMeeple) {
            meeplesRow.appendChild(buildMeepleChip('Large', 'Large.png', player.hasLargeMeeple ? 1 : 0));
        }

        // Pions spéciaux (bâtisseur, cochon) — séparés visuellement des meeples classiques
        const specialChips = [];
        if (this.config?.extensions?.tradersBuilders) {
            specialChips.push(buildMeepleChip('Builder', 'Builder.png', player.hasBuilder ? 1 : 0));
        }
        if (this.config?.extensions?.pig) {
            specialChips.push(buildMeepleChip('Pig', 'Pig.png', player.hasPig ? 1 : 0));
        }
        // ✨ NOUVEAU : stock de pièces de tour restant
        // ✅ FIX : taille issue de MeepleConfig('Tower', context) au lieu de '16px' fixe,
        // pour être ajustable et cohérente avec le reste des tailles de meeples.
        if (this.config?.extensions?.tower) {
            const wrap = document.createElement('span');
            wrap.className = 'meeple-chip';
            const img = document.createElement('img');
            img.src = './assets/Meeples/Tower01.png';
            img.alt = 'Tour';
            const { width: towerChipWidth } = getMeepleSize('Tower', context);
            img.style.width  = towerChipWidth;
            img.style.height = 'auto';
            img.style.objectFit = 'contain';
            if ((player.towerPieces ?? 0) <= 0) img.classList.add('unavailable');
            wrap.appendChild(img);
            const countEl = document.createElement('span');
            countEl.className   = 'meeple-chip-count';
            countEl.textContent = `×${player.towerPieces ?? 0}`;
            wrap.appendChild(countEl);
            specialChips.push(wrap);
        }
        if (specialChips.length > 0) {
            const divider = document.createElement('span');
            divider.style.cssText = 'width:1px;align-self:stretch;background:rgba(255,255,255,0.2);margin:0 2px;';
            meeplesRow.appendChild(divider);
            specialChips.forEach(chip => meeplesRow.appendChild(chip));
        }

        container.appendChild(meeplesRow);

        // ✨ NOUVEAU — Ligne 2 : marchandises, sur sa propre ligne (plus de séparateur inline)
        // (Emplacement réservé pour une future ligne "prison + tuile bonus" en dessous)
        if (!isSpectator && this.config?.extensions?.merchants) {
            const goods     = player.goods || { cloth: 0, wheat: 0, wine: 0 };
            const goodsSize = getGoodsSize(context === 'panel' ? 'panel' : 'panelMobile');

            const goodsRow = document.createElement('div');
            goodsRow.className = 'goods-row';

            [
                { key: 'cloth', src: './assets/Misc/C2/Cloth.png', alt: 'Tissu' },
                { key: 'wheat', src: './assets/Misc/C2/Wheat.png', alt: 'Blé'   },
                { key: 'wine',  src: './assets/Misc/C2/Wine.png',  alt: 'Vin'   },
            ].forEach(({ key, src, alt }) => {
                const wrap = document.createElement('span');
                wrap.style.cssText = 'display:inline-flex;align-items:center;gap:2px;';

                const img = document.createElement('img');
                img.src          = src;
                img.alt          = alt;
                img.style.width  = goodsSize.width;
                img.style.height = goodsSize.height;
                img.style.objectFit = 'contain';
                wrap.appendChild(img);

                const count = document.createElement('span');
                count.textContent = goods[key] ?? 0;
                count.style.cssText = 'color:white;font-size:11px;font-weight:bold;min-width:10px;';
                wrap.appendChild(count);

                goodsRow.appendChild(wrap);
            });

            container.appendChild(goodsRow);
        }

        // ✨ NOUVEAU — Ligne 3 : prisonniers (butin), un chip par meeple capturé avec la couleur d'origine
        if (this.config?.extensions?.tower) {
            const myPrisoners = this.gameState?.prisoners?.[player.id] ?? [];
            if (myPrisoners.length > 0) {
                const prisonRow = document.createElement('div');
                prisonRow.className = 'prison-row';

                // ✨ NOUVEAU : sélection de prisonniers — mécanisme générique (voir constructeur
                // et enablePrisonerSelection() plus bas). Aujourd'hui utilisé par l'échange
                // automatique de prisonniers ; prévu pour être réutilisé plus tard par le
                // rachat de prisonnier.
                const selection = this._prisonerSelection;
                const isSelectionPanel = selection && selection.playerId === player.id;

                myPrisoners.forEach((entry) => {
                    const { type, ownerId } = entry;
                    const ownerPlayer = this.gameState.players.find(p => p.id === ownerId);
                    const ownerColorCap = (ownerPlayer?.color ?? 'black').charAt(0).toUpperCase() + (ownerPlayer?.color ?? 'black').slice(1);

                    const wrap = document.createElement('span');
                    wrap.style.cssText = 'position:relative;display:inline-flex;';

                    const img = document.createElement('img');
                    img.src = `./assets/Meeples/${ownerColorCap}/${type}.png`;
                    const { width, height } = getMeepleSize(type, context);
                    img.style.width  = width;
                    img.style.height = height;
                    img.style.objectFit = 'contain';
                    wrap.appendChild(img);

                    // Grille de capture — même traitement visuel prévu dans le document de design
                    const bars = document.createElement('div');
                    bars.style.cssText = 'position:absolute;inset:0;background:repeating-linear-gradient(90deg, rgba(0,0,0,0.85) 0 1.5px, transparent 1.5px 6px);pointer-events:none;';
                    wrap.appendChild(bars);

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
                    if (clickHandler) {
                        wrap.classList.add('prisoner-selectable');
                    }
                    // ✅ FIX : stopPropagation systématique, même sans clickHandler — sinon un clic
                    // sur un prisonnier non rachetable (pas assez de points, pas le sien, etc.)
                    // remonte jusqu'à la carte et en bascule l'ouverture/fermeture (PC), ou ne fait
                    // rien de visible mais laisse un comportement incohérent (mobile). "Rien ne doit
                    // se passer" doit vraiment signifier rien, y compris l'absence de cet effet de bord.
                    wrap.onclick = (e) => {
                        e.stopPropagation();
                        if (clickHandler) clickHandler();
                    };

                    prisonRow.appendChild(wrap);
                });

                container.appendChild(prisonRow);
            }
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
     * Active la sélection sur le panel du joueur `playerId` : les entrées de sa ligne
     * "prisonniers" qui satisfont `isSelectable(entry)` (entry = { type, ownerId }) deviennent
     * cliquables et appellent `onSelect(entry)` au clic.
     */
    enablePrisonerSelection({ playerId, isSelectable, onSelect }) {
        this._prisonerSelection = { playerId, isSelectable, onSelect };
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
        document.body.classList.remove('prisoner-selection-mode'); // ✨ NOUVEAU

        this.eventBus.off('score-updated',        this._onScoreUpdated);
        this.eventBus.off('meeple-count-updated', this._onMeepleCountUpdated);
    }
}
