/**
 * LobbyNavigator — Gère le retour au lobby (in-game → lobby et lobby initial).
 * Remplace returnToLobby() et returnToInitialLobby() de home.js.
 */
export class LobbyNavigator {
    constructor(deps) {
        this._d = deps;
    }

    // ── Retour au lobby depuis une partie en cours ────────────────────────────

    returnToLobby() {
        const d = this._d;
        console.log('🔙 Retour au lobby...');
        d.stopAutoReconnect();
        d.stopGameTimer();

        ['game-timer', 'mobile-game-timer'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.textContent = '⏱ 00:00'; el.style.display = 'none'; }
        });

        // Nettoyer overlays dragon/princesse
        d.clearDragonCursors();
        document.querySelectorAll('.princess-cursor').forEach(el => el.remove());
        const dragonOverlay = document.getElementById('dragon-phase-overlay');
        if (dragonOverlay) dragonOverlay.style.display = 'none';
        document.getElementById('dragon-piece')?.remove();

        const multiplayer = d.getMultiplayer();
        const isHost      = d.getIsHost();
        const players     = d.getPlayers();

        if (isHost && multiplayer.peer?.open) {
            multiplayer.broadcast({ type: 'return-to-lobby', players });
        }

        document.getElementById('back-to-lobby-btn').style.display = 'none';

        // Reset pause/reconnexion
        d.destroyReconnectionManager();

        // Restaurer les boutons masqués (spectateur)
        ['end-turn-btn', 'undo-btn', 'mobile-end-turn-btn', 'mobile-undo-btn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        });
        const tileTitle = document.querySelector('#current-tile-container h3');
        if (tileTitle) tileTitle.style.display = '';

        d.getUnplaceableManager()?.hideUnplaceableBadge();
        document.getElementById('tile-destroyed-modal').style.display = 'none';

        // ✨ NOUVEAU : nettoyage de la modale/overlay d'échange de prisonniers (extension Tour)
        const _prisonerModal = document.getElementById('prisoner-exchange-modal');
        if (_prisonerModal) _prisonerModal.style.display = 'none';
        const _prisonerOverlay = document.getElementById('prisoner-selection-overlay');
        if (_prisonerOverlay) _prisonerOverlay.style.display = 'none';
        document.body.classList.remove('prisoner-selection-mode');

        // Détruire les modules UI
        d.destroyGameModules();

        // Réinitialiser les variables de jeu
        d.resetGameState();

        document.getElementById('final-scores-modal').style.display = 'none';
        document.getElementById('board').innerHTML = '';

        const boardEl     = document.getElementById('board');
        const containerEl = document.getElementById('board-container');
        if (boardEl)     boardEl.style.transform = '';
        if (containerEl) { containerEl.scrollLeft = 0; containerEl.scrollTop = 0; }
        d.resetZoom();

        d.destroyNavigationManager();

        // Relancer le heartbeat lobby
        const existingPeers = new Set(multiplayer._connectedPeers);
        d.stopHeartbeat();
        d.startHeartbeat((peerId) => {
            const p = d.getPlayers();
            d.setPlayers(p.filter(pl => pl.id !== peerId));
            d.getLobbyUI().setPlayers(d.getPlayers());
            multiplayer.broadcast({ type: 'players-update', players: d.getPlayers() });
        });
        existingPeers.forEach(peerId => {
            const hm = d.getHeartbeatManager();
            if (hm) hm._lastPong[peerId] = Date.now();
        });

        multiplayer.onPlayerJoined = (playerId) => {
            const hm = d.getHeartbeatManager();
            if (hm) hm._lastPong[playerId] = Date.now();
        };
        multiplayer.onPlayerLeft = (peerId) => {
            d.setPlayers(d.getPlayers().filter(p => p.id !== peerId));
            d.getLobbyUI().setPlayers(d.getPlayers());
            multiplayer.broadcast({ type: 'players-update', players: d.getPlayers() });
        };

        // Restaurer onDataReceived
        if (isHost) {
            multiplayer.onDataReceived = multiplayer._lobbyHostHandler ?? null;
        } else {
            multiplayer.onDataReceived = d.getOriginalLobbyHandler() ?? null;
        }

        const lobbyUI = d.getLobbyUI();
        lobbyUI.show();
        lobbyUI.reset();

        if (isHost) {
            lobbyUI.setIsHost(true);
            lobbyUI.onKickPlayer = (playerId) => {
                multiplayer.sendTo(playerId, { type: 'you-are-kicked' });
                d.setPlayers(d.getPlayers().filter(p => p.id !== playerId));
                lobbyUI.setPlayers(d.getPlayers());
                multiplayer.broadcast({ type: 'players-update', players: d.getPlayers() });
            };
            lobbyUI.onHostLeave = () => {
                const invites = d.getPlayers().filter(p => !p.isHost);
                if (invites.length > 0) multiplayer.broadcast({ type: 'you-are-kicked' });
                this.returnToInitialLobby();
            };
        } else {
            lobbyUI.setIsHost(false);
            lobbyUI.onLeaveGame = () => {
                multiplayer.broadcast({ type: 'player-left' });
                this.returnToInitialLobby();
            };
        }

        lobbyUI.setPlayers(d.getPlayers());
        d.updateLobbyUI();
        if (!isHost) lobbyUI.selectColor(d.getPlayerColor());

        console.log('✅ Retour au lobby terminé');
    }

    // ── Retour au lobby initial (déconnexion complète) ────────────────────────

    returnToInitialLobby(message = null) {
        const d = this._d;
        console.log('🔙 Retour au lobby initial...');

        if (d.getTurnManager()) {
            this.returnToLobby();
        }

        d.stopAutoReconnect();
        window._isAutoReconnecting = false;
        d.stopGameTimer();

        d.setPlayers([]);
        d.setInLobby(false);
        d.setIsHost(false);
        d.setGameCode('');

        const gameCodeContainer = document.getElementById('game-code-container');
        if (gameCodeContainer) gameCodeContainer.style.display = 'none';

        d.getMultiplayer().onDataReceived = null;

        const lobbyUI = d.getLobbyUI();
        lobbyUI.setIsHost(false);
        lobbyUI.setPlayers([]);
        lobbyUI.reset();
        lobbyUI.show();
        d.updateLobbyUI();

        const multiplayer = d.getMultiplayer();
        if (multiplayer?.peer) {
            setTimeout(() => multiplayer.peer.destroy(), 100);
        }

        if (message) {
            setTimeout(() => alert(message), 200);
        }

        console.log('✅ Retour au lobby initial terminé');
    }
}
