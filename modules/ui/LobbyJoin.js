/**
 * LobbyJoin — Encapsule la logique de connexion d'un invité à une partie.
 * Remplace _doJoin() de home.js.
 */
export class LobbyJoin {
    constructor(deps) {
        this._d = deps;
    }

    async join(isSpectator = false) {
        const d = this._d;
        const code = document.getElementById('join-code-input').value.trim();
        if (!code) { d.showJoinError('Veuillez entrer un code !'); return; }

        try {
            const lobbyHandler = (data, from) => {
                console.log('📨 [INVITÉ] Reçu:', data);

                if (data.type === 'welcome') {
                    console.log('🎉', data.message);
                    // Vérifier compatibilité version + domaine
                    if (d.checkCompatibility) {
                        const result = d.checkCompatibility(data.version, data.origin);
                        if (!result.ok) {
                            // Détruire le peer et revenir proprement au lobby initial
                            try { d.getMultiplayer().peer?.destroy(); } catch(e) {}
                            d.returnToInitialLobby();
                            // Afficher l'erreur après le retour (timeout pour laisser le DOM se réinitialiser)
                            setTimeout(() => {
                                document.getElementById('join-modal').style.display = 'flex';
                                d.showJoinError(result.reason);
                            }, 150);
                            return;
                        }
                    }
                    // ✨ NOUVEAU : en partie (reconnexion, changement d'hôte), le welcome du (nouvel)
                    // hôte ne doit ni remettre l'ancien code saisi ni remplacer le heartbeat de
                    // jeu par celui du lobby (qui renverrait au lobby en cas de silence).
                    if (d.getTurnManager()) return;
                    d.setGameCode(code);
                    document.getElementById('game-code-container').style.display = 'block';
                    document.getElementById('game-code-text').textContent = `Code: ${code}`;
                    d.startHeartbeat(() => d.returnToInitialLobby("L'hote ne repond plus."));
                }

                if (data.type === 'game-in-progress') {
                    // ✅ FIX : un invité promu hôte garde ce handler au bas de sa chaîne réseau —
                    // il ne doit jamais réagir à un message destiné aux invités (défense en profondeur)
                    if (d.getMultiplayer().isHost) return;
                    clearTimeout(window._pendingPlayerInfoTimer);
                    if (window._isAutoReconnecting) {
                        window._isAutoReconnecting = false;
                        d.getMultiplayer().broadcast({ type: 'player-info', name: d.getPlayerName(), color: d.getPlayerColor(), isSpectator: false, version: d.getAppVersion?.(), origin: d.getAppOrigin?.() });
                    } else {
                        window._waitingForRoleChoice = true;
                        d.showRoleChoiceModal((chosenIsSpectator) => {
                            window._waitingForRoleChoice = false;
                            d.getMultiplayer().broadcast({ type: 'player-info', name: d.getPlayerName(), color: d.getPlayerColor(), isSpectator: chosenIsSpectator, version: d.getAppVersion?.(), origin: d.getAppOrigin?.() });
                        });
                    }
                }

                if (data.type === 'players-update') {
                    if (d.getTurnManager()) return; // en partie : géré par le handler de jeu
                    d.setPlayers(data.players);
                    d.getLobbyUI().setPlayers(data.players);
                    const me = data.players.find(p => p.id === d.getMultiplayer().playerId);
                    if (me && me.color !== d.getPlayerColor()) {
                        d.setPlayerColor(me.color);
                        d.getLobbyUI().selectColor(me.color);
                    }
                }

                if (data.type === 'color-change') {
                    const player = d.getPlayers().find(p => p.id === data.playerId);
                    if (player) { player.color = data.color; d.getLobbyUI().updatePlayersList(); }
                }

                if (data.type === 'player-order-update') {
                    d.setPlayers(data.players);
                    d.getLobbyUI().setPlayers(data.players);
                }

                if (data.type === 'return-to-lobby') {
                    if (data.players) d.setPlayers(data.players);
                    d.returnToLobby();
                }

                if (data.type === 'option-change') {
                    if (data.option === 'unplaceable' || data.option === 'start') {
                        const radio = document.querySelector(`input[name="${data.option}"][value="${data.value}"]`);
                        if (radio) radio.checked = true;
                    } else {
                        const checkbox = document.getElementById(data.option);
                        if (checkbox) checkbox.checked = data.value;
                    }
                    d.updateAllAvailability();
                    d.updateOptionsAccess();
                    d.updateMasterCheckboxes();
                }

                if (data.type === 'options-sync') {
                    const opts = data.options;
                    ['base-fields','list-remaining','use-test-deck','enable-debug','ext-abbot','tiles-abbot',
                     'ext-large-meeple','ext-cathedrals','ext-inns','tiles-inns-cathedrals','tiles-traders-builders',
                     'ext-builder','ext-merchants','ext-pig','tiles-dragon','ext-dragon','ext-princess','ext-portal',
                     'ext-fairy-protection','ext-fairy-score-turn','ext-fairy-score-zone'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el && opts[id] !== undefined) el.checked = opts[id];
                    });
                    if (opts['unplaceable']) {
                        const radio = document.querySelector(`input[name="unplaceable"][value="${opts['unplaceable']}"]`);
                        if (radio) radio.checked = true;
                    }
                    if (opts['start']) {
                        const radio = document.querySelector(`input[name="start"][value="${opts['start']}"]`);
                        if (radio) radio.checked = true;
                    }
                    d.updateAllAvailability();
                    d.updateOptionsAccess();
                    d.updateMasterCheckboxes();
                }

                if (data.type === 'game-starting') {
                    console.log("🎮 [INVITÉ] L'hôte démarre la partie !");
                    if (data.config) d.setGameConfig(data.config);
                    d.startGameForInvite();
                }

                if (data.type === 'full-state-sync') {
                    console.log('🔄 [INVITÉ] Réception état complet de la partie en cours...');
                    if (data.gameConfig) d.setGameConfig(data.gameConfig);
                    if (!d.getTurnManager()) {
                        d.startGameForInvite(data);
                    } else {
                        d.getReconnectionManager().applyFullStateSync(data);
                    }
                }

                if (data.type === 'rejoin-rejected') {
                    d.returnToInitialLobby(data.reason || 'Impossible de rejoindre la partie.');
                }

                if (data.type === 'you-are-kicked') {
                    d.returnToInitialLobby('Vous avez été retiré du salon.');
                }
            };

            d.getLobbyUI().onLeaveGame = () => {
                d.getMultiplayer().broadcast({ type: 'player-left' });
                d.returnToInitialLobby();
            };

            d.setOriginalLobbyHandler(lobbyHandler);
            d.getMultiplayer().onDataReceived = lobbyHandler;

            await d.getMultiplayer().joinGame(code);
            document.getElementById('join-modal').style.display = 'none';
            d.setInLobby(true);
            d.setIsHost(false);
            d.updateLobbyUI();

            window._pendingPlayerInfoTimer = setTimeout(() => {
                if (!window._waitingForRoleChoice) {
                    d.getMultiplayer().broadcast({ type: 'player-info', name: d.getPlayerName(), color: d.getPlayerColor(), isSpectator, version: d.getAppVersion?.(), origin: d.getAppOrigin?.() });
                }
            }, 500);

        } catch (error) {
            console.error('❌ Erreur de connexion:', error);
            document.getElementById('join-modal').style.display = 'flex';
            d.showJoinError('Impossible de rejoindre: ' + error.message);
        }
    }
}
