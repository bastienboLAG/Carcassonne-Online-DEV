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

            // ✨ NOUVEAU : état d'ouverture indépendant par joueur (plusieurs cartes peuvent rester ouvertes)
            const isOpen = this._desktopOpenPlayerIds.has(player.id);
            if (isOpen) card.classList.add('open');
            card.onclick = () => {
                if (isOpen) this._desktopOpenPlayerIds.delete(player.id);
                else this._desktopOpenPlayerIds.add(player.id);
                this._updateDesktop(this._isBonusTurn, this._isDragonTurn);
            };

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
            const isOpen   = this._mobileOpenPlayerId === player.id; // ✨ NOUVEAU

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

            // ✨ NOUVEAU : clic = ouvrir/fermer le détail de ce joueur (un seul à la fois)
            card.onclick = () => {
                this._mobileOpenPlayerId = isOpen ? null : player.id;
                this._updateMobile(this._isBonusTurn, this._isDragonTurn);
            };

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

        this.eventBus.off('score-updated',        this._onScoreUpdated);
        this.eventBus.off('meeple-count-updated', this._onMeepleCountUpdated);
    }
}
