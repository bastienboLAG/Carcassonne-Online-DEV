/**
 * LobbyUI - Gère l'interface du lobby
 * Responsabilités :
 * - Affichage de la liste des joueurs
 * - Drag & drop pour réordonner les joueurs
 * - Sélection des couleurs
 * - Affichage du code de partie
 * - Synchronisation réseau de l'état du lobby
 */
export class LobbyUI {
    constructor(multiplayer) {
        this.multiplayer = multiplayer;
        
        // Données
        this.players = [];
        this.takenColors = [];
        this.isHost = false;
        this.onKickPlayer  = null; // callback(playerId) — hôte kick un invité
        this.onLeaveGame   = null; // callback() — invité quitte volontairement
        this.onHostLeave   = null; // callback() — hôte quitte (kick général)
        
        // Éléments DOM
        this.playersListEl = null;
        this.gameCodeContainerEl = null;
        this.gameCodeTextEl = null;
        this.colorGridEl = null;
        
        // Images des couleurs
        this.colorImages = {
            'black':     './assets/Meeples/Black/Normal.png',
            'red':       './assets/Meeples/Red/Normal.png',
            'pink':      './assets/Meeples/Pink/Normal.png',
            'green':     './assets/Meeples/Green/Normal.png',
            'blue':      './assets/Meeples/Blue/Normal.png',
            'yellow':    './assets/Meeples/Yellow/Normal.png',
            'spectator': './assets/Meeples/Spectator.png'
        };
        
        this.allColors = ['black', 'red', 'pink', 'green', 'blue', 'yellow', 'spectator'];
    }

    /**
     * Initialiser l'UI du lobby
     */
    init() {
        this.playersListEl = document.getElementById('players-list');
        this.gameCodeContainerEl = document.getElementById('game-code-container');
        this.gameCodeTextEl = document.getElementById('game-code-text');
        this.colorGridEl = document.getElementById('color-grid');
        
        console.log('✅ LobbyUI initialisé');
    }

    /**
     * Définir les joueurs
     */
    setPlayers(players) {
        this.players = players;
        this.updatePlayersList();
    }

    /**
     * Définir si on est l'hôte
     */
    setIsHost(isHost) {
        this.isHost = isHost;
    }

    /**
     * Afficher le code de partie
     */
    showGameCode(code) {
        if (this.gameCodeTextEl) {
            this.gameCodeTextEl.textContent = `Code: ${code}`;
            this.gameCodeContainerEl.style.display = 'block';
        }
    }

    /**
     * Mettre à jour la liste des joueurs avec drag & drop
     * ✨ NOUVEAU : les 6 emplacements ne comptent que les NON-spectateurs ; les spectateurs
     * sont listés à part, dans un bloc « Spectateurs » (sans limite, sans emplacements vides).
     */
    updatePlayersList() {
        if (!this.playersListEl) return;
        
        this.playersListEl.innerHTML = '';
        this.takenColors = this.players.map(p => p.color);
        this.updateAvailableColors();
        
        if (this.players.length === 0) {
            this.playersListEl.innerHTML = '<div class="player-slot empty"><span class="player-name">En attente de joueurs...</span></div>';
            return;
        }
        
        // ✨ NOUVEAU : séparer joueurs et spectateurs en conservant l'index d'origine
        // (movePlayer travaille sur l'index dans this.players complet)
        let playingCount = 0;
        const spectators = [];
        this.players.forEach((player, index) => {
            if (player.color === 'spectator') {
                spectators.push({ player, index });
                return;
            }
            playingCount++;
            this.playersListEl.appendChild(this._createPlayerSlot(player, index, true));
        });
        
        // Ajouter les slots vides (6 places pour les joueurs, spectateurs exclus)
        for (let i = playingCount; i < 6; i++) {
            const slot = document.createElement('div');
            slot.className = 'player-slot empty';
            slot.innerHTML = '<span class="player-name">En attente...</span>';
            this.playersListEl.appendChild(slot);
        }

        // ✨ NOUVEAU : bloc Spectateurs (uniquement s'il y en a)
        if (spectators.length > 0) {
            const title = document.createElement('div');
            title.className   = 'lobby-spectators-title';
            title.textContent = `Spectateurs (${spectators.length})`;
            this.playersListEl.appendChild(title);

            spectators.forEach(({ player, index }) => {
                const slot = this._createPlayerSlot(player, index, false);
                slot.classList.add('spectator-slot');
                this.playersListEl.appendChild(slot);
            });
        }
    }

    /**
     * ✨ NOUVEAU : construit un emplacement joueur (extrait de updatePlayersList pour être
     * partagé entre la liste des joueurs et celle des spectateurs).
     * @param {object}  player
     * @param {number}  index      — index dans this.players (drag & drop)
     * @param {boolean} draggable  — false pour les spectateurs (ordre sans importance)
     */
    _createPlayerSlot(player, index, draggable) {
        const slot = document.createElement('div');
        slot.className = 'player-slot';
        
        // Rendre draggable seulement pour l'hôte
        if (this.isHost && draggable) {
            slot.draggable = true;
            slot.style.cursor = 'grab';
            slot.dataset.playerIndex = index;
            
            slot.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', index);
                slot.style.opacity = '0.5';
            });
            
            slot.addEventListener('dragend', () => {
                slot.style.opacity = '1';
            });
            
            slot.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                slot.style.borderTop = '2px solid gold';
            });
            
            slot.addEventListener('dragleave', () => {
                slot.style.borderTop = '';
            });
            
            slot.addEventListener('drop', (e) => {
                e.preventDefault();
                slot.style.borderTop = '';
                
                const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                const toIndex = parseInt(slot.dataset.playerIndex);
                
                if (fromIndex !== toIndex) {
                    this.movePlayer(fromIndex, toIndex);
                }
            });
        }
        
        const nameSpan = document.createElement('span');
        nameSpan.className   = 'player-name';
        nameSpan.textContent = player.name + (player.isHost ? ' 👑' : '');
        slot.appendChild(nameSpan);

        const meepleImg = document.createElement('img');
        meepleImg.src       = this.colorImages[player.color];
        meepleImg.className = 'player-meeple-img';
        meepleImg.alt       = player.color;
        slot.appendChild(meepleImg);

        // Croix kick (hôte sur les invités) ou quitter (invité sur soi-même)
        const myId = this.multiplayer?.playerId;
        const showKick      = this.isHost && !player.isHost;
        const showHostLeave = this.isHost && player.isHost;
        const showLeave     = !this.isHost && player.id === myId;

        if (showKick || showLeave || showHostLeave) {
            const closeBtn = document.createElement('button');
            closeBtn.className   = 'lobby-kick-btn';
            closeBtn.textContent = '✕';
            closeBtn.title       = showKick ? 'Retirer ce joueur' : 'Quitter le salon';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log('🔴 Croix cliquée — showKick:', showKick, 'showLeave:', showLeave, 'showHostLeave:', showHostLeave, 'onHostLeave:', !!this.onHostLeave);
                if (showKick && this.onKickPlayer)     this.onKickPlayer(player.id);
                if (showLeave && this.onLeaveGame)     this.onLeaveGame();
                if (showHostLeave && this.onHostLeave) this.onHostLeave();
            });
            slot.appendChild(closeBtn);
        }

        return slot;
    }

    /**
     * Déplacer un joueur dans la liste
     */
    movePlayer(fromIndex, toIndex) {
        const [movedPlayer] = this.players.splice(fromIndex, 1);
        this.players.splice(toIndex, 0, movedPlayer);
        
        // Synchroniser avec les autres joueurs
        if (this.multiplayer && this.multiplayer.peer && this.multiplayer.peer.open) {
            this.multiplayer.broadcast({
                type: 'player-order-update',
                players: this.players
            });
        }
        
        this.updatePlayersList();
    }

    /**
     * Mettre à jour les couleurs disponibles
     */
    updateAvailableColors() {
        const colorOptions = document.querySelectorAll('.color-option');
        const currentPlayerColor = this.getCurrentPlayerColor();
        
        colorOptions.forEach(option => {
            const color = option.dataset.color;
            const input = option.querySelector('input');
            
            // spectator peut être choisi par plusieurs joueurs
            // mais au moins 1 non-spectateur doit exister dans le salon
            const isTaken = this.takenColors.includes(color) && color !== currentPlayerColor;
            const isSpectatorColor = color === 'spectator';
            const nonSpectatorCount = this.players.filter(p => p.color !== 'spectator').length;
            // Bloquer spectator si le joueur actuel est le seul non-spectateur
            const wouldLeaveNoPlayer = isSpectatorColor && nonSpectatorCount <= 1 && currentPlayerColor !== 'spectator';
            if ((isTaken && !isSpectatorColor) || wouldLeaveNoPlayer) {
                option.classList.add('disabled');
                input.disabled = true;
            } else {
                option.classList.remove('disabled');
                input.disabled = false;
            }
        });
    }

    /**
     * Obtenir la couleur du joueur actuel
     */
    getCurrentPlayerColor() {
        if (!this.multiplayer) return null;
        const me = this.players.find(p => p.id === this.multiplayer.playerId);
        return me ? me.color : null;
    }

    /**
     * Sélectionner visuellement une couleur dans le sélecteur.
     * Utilisé au retour lobby pour refléter la couleur actuelle du joueur.
     */
    selectColor(color) {
        const opt = document.querySelector(`.color-option[data-color="${color}"]`);
        if (!opt) return;
        document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        const input = opt.querySelector('input');
        if (input) input.checked = true;
    }

    /**
     * Ajouter un joueur
     */
    addPlayer(player) {
        this.players.push(player);
        this.updatePlayersList();
    }

    /**
     * Retirer un joueur
     */
    removePlayer(playerId) {
        this.players = this.players.filter(p => p.id !== playerId);
        this.updatePlayersList();
    }

    /**
     * Mettre à jour la couleur d'un joueur
     */
    updatePlayerColor(playerId, color) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.color = color;
            this.updatePlayersList();
        }
    }

    /**
     * Afficher le lobby
     */
    show() {
        document.getElementById('lobby-page').style.display = 'flex';
        document.getElementById('game-page').style.display = 'none';
    }

    /**
     * Masquer le lobby
     */
    hide() {
        document.getElementById('lobby-page').style.display = 'none';
        document.getElementById('game-page').style.display = 'flex';
    }

    /**
     * Réinitialiser le lobby (pour retour après partie)
     */
    reset() {
        this.players       = [];
        this.onKickPlayer  = null;
        this.onLeaveGame   = null;
        this.onHostLeave   = null;
        this.isHost        = false;
        this.updatePlayersList();
    }

    /**
     * Obtenir la liste des joueurs
     */
    getPlayers() {
        return this.players;
    }

    /**
     * Ouvre/ferme le menu popover de jeu, positionné au-dessus du bouton.
     */
    openCloseMenu(btnEl) {
        const popover = document.getElementById('game-menu-popover');
        if (!popover) return;
        if (popover.style.display !== 'none') { popover.style.display = 'none'; return; }
        if (popover.parentElement !== document.body) document.body.appendChild(popover);
        const rect = btnEl.getBoundingClientRect();
        popover.style.visibility = 'hidden';
        popover.style.display    = 'block';
        const pw = popover.offsetWidth;
        const ph = popover.offsetHeight;
        popover.style.left       = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8)) + 'px';
        popover.style.top        = Math.max(8, rect.top - ph - 8) + 'px';
        popover.style.bottom     = '';
        popover.style.visibility = '';
    }

    /**
     * Affiche la modale de choix joueur/spectateur et appelle callback(isSpectator).
     * ✨ NOUVEAU : `opts.playerDisabled` (partie complète) masque le bouton « Joueur » et adapte
     * le texte ; l'état d'origine de la modale est restauré à la fermeture.
     * @param {Function} callback
     * @param {{ playerDisabled?: boolean }} [opts]
     */
    showRoleChoiceModal(callback, opts = {}) {
        const modal = document.getElementById('join-role-modal');
        if (!modal) return;

        const playerBtn    = document.getElementById('join-as-player-btn');
        const spectatorBtn = document.getElementById('join-as-spectator-btn');
        const textEl       = modal.querySelector('p');
        const originalText = textEl ? textEl.textContent : null;

        if (opts.playerDisabled) {
            playerBtn.style.display = 'none';
            if (textEl) textEl.textContent = 'La partie est complète : vous pouvez la rejoindre en tant que spectateur.';
        } else {
            playerBtn.style.display = '';
        }

        modal.style.display = 'flex';
        const cleanup = () => {
            playerBtn.removeEventListener('click', onPlayer);
            spectatorBtn.removeEventListener('click', onSpectator);
            playerBtn.style.display = '';
            if (textEl && originalText !== null) textEl.textContent = originalText;
        };
        const onPlayer    = () => { modal.style.display = 'none'; cleanup(); callback(false); };
        const onSpectator = () => { modal.style.display = 'none'; cleanup(); callback(true);  };
        playerBtn.addEventListener('click', onPlayer);
        spectatorBtn.addEventListener('click', onSpectator);
    }

    /**
     * Affiche un message d'erreur dans la modale de connexion.
     */
    showJoinError(message) {
        const el = document.getElementById('join-error');
        if (!el) return;
        el.textContent   = message;
        el.style.display = 'block';
    }
}
