/**
 * HostMigration — Changement d'hôte en cours de partie
 *
 * Principe :
 *  - L'hôte diffuse à chaque fin de tour un SNAPSHOT complet (même contenu qu'un
 *    full-state-sync + hostId + liste ordonnée des successeurs possibles).
 *  - Si un invité perd l'hôte (fermeture de connexion, erreur réseau ou heartbeat muet), il
 *    tente d'abord de le rejoindre pendant un délai de grâce, puis parcourt les successeurs
 *    dans l'ordre : pour chacun, il tente de le rejoindre pendant un délai de grâce ; s'il
 *    arrive à son propre tour dans la liste, il se promeut hôte.
 *  - Le nouvel hôte a pour code de partie son propre id réseau (6 chiffres, cf. Multiplayer).
 *    Aucune tentative de récupérer l'ancien code (un seul numéro à la fois).
 *  - L'état restauré est celui du DÉBUT du tour en cours (le dernier snapshot). Si l'ancien
 *    hôte jouait, son tour est sauté et la tuile déjà piochée passe au joueur suivant.
 *
 * Ancien hôte (option B) :
 *  - s'il est lui-même isolé (hors ligne / serveur de signalisation perdu), il le détecte
 *    (ReconnectionManager._isHostIsolated) au lieu de croire que ses invités sont partis : mode
 *    « isolement » (onSelfIsolated) — overlay de reconnexion, reconnexion au serveur de
 *    signalisation sous le MÊME id, aucune pause ni exclusion de joueur ;
 *  - s'il retrouve internet avant la fin du délai de grâce des invités, ceux-ci le rejoignent
 *    (CAS 5) et la partie continue chez lui ;
 *  - sinon le nouvel hôte le prévient (`host-moved`, sondage par son ancien id) : il quitte
 *    son rôle d'hôte et rejoint automatiquement la partie avec le nouveau code et son pseudo.
 *
 * Les invités gardent le même id réseau pendant toute la procédure (pas de destroy/recréation
 * du peer) : la liste des successeurs du snapshot reste valable, et le nouvel hôte les
 * retrouve via le CAS 5 de ReconnectionManager.initInGameNetworkHandler (même id).
 */

// 🧪 Valeur de test. Passer à 20000 (20 s) une fois les tests terminés.
export const HOST_GRACE_MS = 5000;

const RETRY_DELAY_MS   = 1000;  // pause entre deux tentatives de connexion
const HELLO_TIMEOUT_MS = 6000;  // attente de la confirmation du (nouvel) hôte après ouverture du canal
const POST_PROMOTION_SNAPSHOT_MS = 5000; // snapshot de rattrapage après une promotion
const PROBE_INTERVAL_MS = 3000;       // nouvel hôte : pause entre deux tentatives de prévenir l'ancien hôte
const PROBE_MAX_MS      = 15 * 60000; // nouvel hôte : abandon du sondage de l'ancien hôte
const ISOLATION_RESTORED_WAIT_MS = 90000; // ancien hôte reconnecté au réseau : attente max d'invités/notification

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isInactive = (p) => p.color === 'spectator' || p.disconnected === true || p.kicked === true;

export class HostMigration {
    /**
     * @param {object} deps — injectées depuis home.js (voir _getHostMigration)
     */
    constructor(deps) {
        this._d = deps;
        this._snapshot = null;   // dernier snapshot reçu (invités)
        this._state = 'idle';    // 'idle' | 'running'
        this._runId = 0;         // invalide une procédure en cours (reset / nouvelle partie)
        this._isolated = false;  // ancien hôte : suis-je isolé du réseau ?
        // Connexions existantes au moment où l'hôte devient isolé : elles sont mortes mais peuvent
        // rester marquées « ouvertes » plusieurs dizaines de secondes. Seule une connexion
        // NOUVELLE prouve qu'un joueur est réellement revenu.
        this._staleConns = new Set();
        this._isolatedAt = 0;
        this._listenersInstalled = false;
    }

    /** Remise à zéro (retour au lobby, nouvelle partie). */
    reset() {
        this._runId++;
        this._snapshot = null;
        this._state = 'idle';
        this._isolated = false;
    }

    /**
     * Branche les callbacks GameSync. Appelé à chaque attachGameSyncCallbacks() (démarrage de
     * partie ET promotion), donc idempotent : il relit isHost à chaque événement.
     */
    install() {
        const d  = this._d;
        const gs = d.getGameSync();
        if (!gs) return;
        gs.onHostSnapshot  = (data) => { if (!d.getIsHost()) this._snapshot = data; };
        gs.onTurnEndSynced = () => { if (d.getIsHost()) this.broadcastSnapshot(); };
        gs.onHostMoved     = (data, from) => this.onHostMoved(data, from);

        // Hôte : perte de réseau de l'appareil = c'est MOI qui suis isolé (détection immédiate,
        // avant que les invités ne « se déconnectent » un par un)
        if (!this._listenersInstalled) {
            this._listenersInstalled = true;
            window.addEventListener('offline', () => {
                setTimeout(() => {
                    if (navigator.onLine === false && d.getIsHost() && d.getGameState()
                        && d.getMultiplayer().connections.length > 0) this.onSelfIsolated();
                }, 1500);
            });
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Hôte : diffusion du snapshot
    // ─────────────────────────────────────────────────────────────

    broadcastSnapshot() {
        const d  = this._d;
        const rm = d.getReconnectionManager();
        const gs = d.getGameSync();
        const gameState = d.getGameState();
        if (!rm || !gs || !gameState || !d.getIsHost()) return;

        const hostId = d.getMultiplayer().playerId;
        // Successeurs possibles, dans l'ordre de la liste des joueurs (déterministe chez tous)
        const candidates = gameState.players
            .filter(p => p.id !== hostId && !isInactive(p))
            .map(p => p.id);

        try {
            const message = gs.buildFullStateMessage(rm.collectFullStateArgs());
            message.hostId = hostId;
            message.candidates = candidates;
            gs.syncHostSnapshot(message);
            console.log('📸 [MIGRATION] Snapshot diffusé — successeurs:', candidates.join(', ') || '(aucun)');
        } catch (err) {
            console.error('❌ [MIGRATION] Échec du snapshot:', err);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Invité : perte de l'hôte
    // ─────────────────────────────────────────────────────────────

    /**
     * Appelé quand la connexion à l'hôte est perdue (fermeture, erreur réseau, heartbeat).
     * Idempotent : ignoré si une procédure est déjà en cours.
     */
    onHostLost() {
        if (this._state !== 'idle') return;
        const d  = this._d;
        const rm = d.getReconnectionManager();
        if (!d.getGameState() || d.getIsHost()) return;

        const snap = this._snapshot;
        if (!snap) {
            // Aucun snapshot (partie tout juste démarrée) : ancien comportement
            console.warn('⚠️ [MIGRATION] Hôte perdu sans snapshot — reconnexion classique');
            rm?.startAutoReconnect();
            return;
        }

        this._state = 'running';
        const runId = ++this._runId;
        console.warn(`🚨 [MIGRATION] Hôte perdu (${snap.hostId}) — délai de grâce ${HOST_GRACE_MS} ms, successeurs: ${snap.candidates.join(', ') || '(aucun)'}`);

        rm.stopAutoReconnect();
        rm._showReconnectOverlay();
        this._run(snap, runId).catch(err => {
            console.error('❌ [MIGRATION] Erreur inattendue:', err);
            this._state = 'idle';
        });
    }

    async _run(snap, runId) {
        const d    = this._d;
        const mp   = d.getMultiplayer();
        const myId = mp.playerId;

        // ✨ NOUVEAU : si c'est CET invité qui est hors ligne, rien à élire : on attend le retour
        // du réseau (comme l'ancienne reconnexion automatique) puis on lance l'élection. Évite
        // qu'un invité sans internet se promeuve hôte seul ou finisse au lobby.
        await this._waitOnline(runId);
        if (runId !== this._runId) return;
        const t0 = Date.now();

        // 1) l'ancien hôte (peut-être une simple coupure), 2) les successeurs dans l'ordre
        const targets = [snap.hostId, ...snap.candidates];

        for (const targetId of targets) {
            if (runId !== this._runId) return;
            if (targetId === myId) {
                console.warn(`👑 [MIGRATION] À mon tour dans la liste (+${Date.now() - t0} ms) — promotion`);
                await this._promote(snap, runId);
                return;
            }
            const ok = await this._tryTarget(targetId, runId);
            if (runId !== this._runId) return;
            if (ok) {
                console.warn(`✅ [MIGRATION] Connecté à ${targetId} (+${Date.now() - t0} ms)`);
                this._finish(targetId, targetId === snap.hostId);
                return;
            }
        }

        console.error('❌ [MIGRATION] Aucun hôte joignable — retour au lobby');
        this._state = 'idle';
        d.returnToInitialLobby("Partie perdue : l'hôte n'est plus joignable.");
    }

    /**
     * Tente de rejoindre `targetId` pendant HOST_GRACE_MS (avec le même peer / id réseau).
     * Succès = canal ouvert ET confirmation du hôte (message game-in-progress → LobbyJoin
     * repasse window._isAutoReconnecting à false), pour ne pas croire à tort être connecté à
     * un pair qui n'écoute pas encore (successeur en cours de promotion).
     */
    async _tryTarget(targetId, runId) {
        const mp = this._d.getMultiplayer();
        const deadline = Date.now() + HOST_GRACE_MS;
        while (Date.now() < deadline) {
            if (runId !== this._runId) return false;
            window._isAutoReconnecting = true; // LobbyJoin : répondre par player-info au game-in-progress
            try {
                await mp.reconnectTo(targetId);
                if (await this._waitHello(runId)) return true;
                console.warn(`⚠️ [MIGRATION] ${targetId} : canal ouvert mais pas de confirmation`);
            } catch (err) {
                console.log(`⏳ [MIGRATION] ${targetId} injoignable (${err?.type || err?.message})`);
            }
            await sleep(RETRY_DELAY_MS);
        }
        return false;
    }

    async _waitOnline(runId) {
        const mp = this._d.getMultiplayer();
        while (runId === this._runId) {
            if (navigator.onLine !== false) {
                try { await mp.ensurePeerReady(); return; } catch (e) { /* signalisation pas encore revenue */ }
            }
            await sleep(1000);
        }
    }

    async _waitHello(runId) {
        const end = Date.now() + HELLO_TIMEOUT_MS;
        while (Date.now() < end) {
            if (runId !== this._runId) return false;
            if (window._isAutoReconnecting === false) return true;
            await sleep(200);
        }
        return false;
    }

    _finish(hostId, sameHost) {
        const d = this._d;
        d.setGameCode(hostId);
        this._state = 'idle';
        if (sameHost) d.afficherToast('✅ Reconnecté à l\'hôte.');
        else d.afficherToast(`🔄 Nouvel hôte — nouveau code de partie : ${hostId}`);
    }

    // ─────────────────────────────────────────────────────────────
    // Promotion de cet invité en hôte
    // ─────────────────────────────────────────────────────────────

    async _promote(snap, runId) {
        const d   = this._d;
        const mp  = d.getMultiplayer();
        const rm  = d.getReconnectionManager();
        const oldHostId = snap.hostId;
        const idBefore  = mp.playerId;

        try {
            await mp.ensurePeerReady();
        } catch (err) {
            console.error('❌ [MIGRATION] Peer inutilisable, promotion impossible:', err);
            this._state = 'idle';
            d.returnToInitialLobby('Impossible de reprendre la partie en tant qu\'hôte.');
            return;
        }
        if (runId !== this._runId) return;

        // ── Tout ce qui suit est synchrone : aucun événement réseau ne peut s'intercaler ──
        const myId = mp.playerId;

        // Adapter le snapshot (données brutes reçues du réseau) AVANT de l'appliquer :
        const gsd = snap.gameState;
        if (myId !== idBefore) { // id réseau changé (rare : id déjà pris) → suivre dans l'état
            const me = gsd.players.find(p => p.id === idBefore);
            if (me) me.id = myId;
        }
        const oldIdx = gsd.players.findIndex(p => p.id === oldHostId);
        const oldHostName = oldIdx !== -1 ? gsd.players[oldIdx].name : null;
        if (oldIdx !== -1) {
            gsd.players[oldIdx].disconnected = true;
            gsd.players[oldIdx].kicked = true; // il pourra revenir comme invité (CAS 3, même pseudo)
            if (gsd.currentPlayerIndex === oldIdx) {
                // Son tour est sauté : la tuile déjà piochée (incluse dans le snapshot) passe au suivant
                const len = gsd.players.length;
                let next = oldIdx, n = 0;
                do { next = (next + 1) % len; n++; } while (n < len && isInactive(gsd.players[next]));
                gsd.currentPlayerIndex = next;
            }
        }

        // Rôle d'hôte
        d.getVoluntaryLeaves().add(oldHostId); // la fermeture tardive de l'ancien canal ne doit pas déclencher de pause
        d.setIsHost(true);
        d.setGameCode(myId);
        const gs = d.getGameSync();
        if (gs) gs.isHost = true;
        const tm = d.getTurnManager();
        if (tm) tm.isHost = true;
        mp.prepareHostTakeover();

        // Liste des joueurs du lobby : retirer l'ancien hôte, marquer le nouveau
        d.setPlayers(d.getPlayers()
            .filter(p => p.id !== oldHostId)
            .map(p => p.id === myId ? { ...p, isHost: true } : p));

        // Restaurer l'état de début de tour
        d.getUndoManager()?.reset();
        rm.applyFullStateSync(snap);
        const tileId = snap.tuileEnMain?.id;
        const tileData = tileId ? d.getDeck().tiles.find(t => t.id === tileId) : null;
        d.setCurrentTileForPlayer(tileData ?? null);

        // Réinstaller tout ce qu'un hôte doit avoir (mêmes fonctions qu'au démarrage d'une partie hôte)
        d.attachGameSyncCallbacks();                          // callbacks hôte + install() de ce module
        rm.initInGameNetworkHandler(d.getInGameNetworkDeps()); // heartbeat hôte, player-info (CAS 1-5), etc.
        d.refreshGameMenu();
        d.updateTurnDisplay();

        // Enfin, accepter les connexions
        mp.startAccepting();

        this._snapshot = null;
        this._state = 'idle';
        console.warn(`👑 [MIGRATION] Je suis l'hôte — code de partie : ${myId}`);
        d.afficherToast(`👑 Vous êtes maintenant l'hôte. Nouveau code de partie : ${myId}`);

        // Snapshot de rattrapage : les invités n'en ont qu'un ancien (hostId = ancien hôte)
        setTimeout(() => this.broadcastSnapshot(), POST_PROMOTION_SNAPSHOT_MS);

        // ✨ NOUVEAU (option B) : prévenir l'ancien hôte dès qu'il redevient joignable
        this._probeOldHost(oldHostId, oldHostName, myId, runId);
    }

    /**
     * ✨ NOUVEAU : nouvel hôte — tente régulièrement de joindre l'ancien hôte par son ancien id
     * (qui redevient joignable s'il retrouve internet) pour lui annoncer le nouveau code.
     * S'arrête dès que : message livré, joueur de même pseudo de nouveau actif (il est revenu
     * de lui-même), perte du rôle d'hôte, reset, ou délai maximal.
     */
    async _probeOldHost(oldHostId, oldHostName, newCode, runId) {
        const d  = this._d;
        const mp = d.getMultiplayer();
        const end = Date.now() + PROBE_MAX_MS;
        while (Date.now() < end) {
            if (runId !== this._runId || !d.getIsHost()) return;
            const gameState = d.getGameState();
            if (!gameState) return;
            if (oldHostName && gameState.players.some(p => p.name === oldHostName && !p.kicked && !p.disconnected)) return;
            try {
                await mp.notifyPeer(oldHostId, { type: 'host-moved', oldHostId, newCode });
                console.warn(`📨 [MIGRATION] Ancien hôte ${oldHostId} prévenu du nouveau code`);
                return;
            } catch (e) { /* encore hors ligne : on réessaie */ }
            await sleep(PROBE_INTERVAL_MS);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Ancien hôte : isolé du réseau, puis informé du nouvel hôte
    // ─────────────────────────────────────────────────────────────

    /**
     * ✨ NOUVEAU : appelé quand CET hôte constate qu'il est coupé du réseau (événement
     * « offline », ou perte d'invités alors que son propre peer est déconnecté). Idempotent.
     */
    onSelfIsolated() {
        const d  = this._d;
        const rm = d.getReconnectionManager();
        const mp = d.getMultiplayer();
        if (this._isolated || !d.getIsHost() || !d.getGameState() || !rm) return;

        this._isolated = true;
        this._staleConns = new Set(mp.connections);
        this._isolatedAt = Date.now();
        const runId = this._runId;
        console.warn('📵 [MIGRATION] Je suis isolé du réseau (hôte) — attente du retour de la connexion');
        if (rm.gamePaused) rm.resumeGame('reconnected'); // retire une éventuelle modale « Partie en pause »
        rm._showReconnectOverlay();
        this._isolationLoop(runId).catch(err => {
            console.error('❌ [MIGRATION] Erreur en mode isolement:', err);
            this._isolated = false;
        });
    }

    /**
     * ✨ NOUVEAU : ce joueur est-il réellement joignable depuis cet hôte depuis le début de
     * l'isolement ? Oui si une connexion NOUVELLE est ouverte, ou si une ancienne connexion a de
     * nouveau reçu un pong de heartbeat (elle a survécu à la coupure). Une ancienne connexion
     * morte mais encore marquée « ouverte » ne compte pas.
     */
    _guestAlive(playerId) {
        const d  = this._d;
        const mp = d.getMultiplayer();
        const hm = d.getHeartbeatManager?.();
        return mp.connections.some(c => c.peer === playerId && c.open &&
            (!this._staleConns.has(c) || (hm && (hm._lastPong[c.peer] || 0) > this._isolatedAt)));
    }

    _anyGuestAlive() {
        const d = this._d;
        const myId = d.getMultiplayer().playerId;
        return (d.getGameState()?.players ?? []).some(p => p.id !== myId && this._guestAlive(p.id));
    }

    /**
     * ✨ NOUVEAU : à la fin d'un isolement, les invités qui n'ont pas redonné signe de vie sont
     * signalés déconnectés (comportement normal : pause / exclusion proposée). Pendant l'isolement
     * leurs timeouts avaient été ignorés (ce n'était pas leur faute), donc plus rien ne les
     * re-signalerait sans ce balayage différé (15 s : le temps qu'ils reviennent).
     */
    _scheduleSweep(runId) {
        setTimeout(() => {
            const d  = this._d;
            const mp = d.getMultiplayer();
            const gameState = d.getGameState();
            if (runId !== this._runId || !d.getIsHost() || !gameState) return;
            gameState.players.forEach(p => {
                if (p.id === mp.playerId || p.disconnected || p.kicked) return;
                if (this._guestAlive(p.id)) return;
                console.warn(`🧹 [MIGRATION] ${p.name} n'est pas revenu après l'isolement — déconnexion signalée`);
                mp.onPlayerLeft?.(p.id, true); // force : ne pas ré-évaluer l'isolement
            });
        }, 15000);
    }

    async _isolationLoop(runId) {
        const d  = this._d;
        const mp = d.getMultiplayer();
        let restoredAt = null;

        while (this._isolated && runId === this._runId) {
            const online = navigator.onLine !== false;
            if (online) {
                try {
                    await mp.ensurePeerReady();   // se reconnecte au serveur de signalisation sous le même id
                    mp.resumeAccepting();          // (le peer a pu être recréé)
                    if (restoredAt === null) {
                        restoredAt = Date.now();
                        console.warn('📶 [MIGRATION] Réseau rétabli — en attente des invités ou du nouvel hôte');
                    }
                } catch (e) {
                    restoredAt = null; // signalisation pas encore revenue
                }
            } else {
                restoredAt = null;
            }

            if (restoredAt !== null) {
                // Des invités sont revenus (ou n'ont jamais lâché) : la partie continue ici
                if (this._anyGuestAlive()) {
                    console.warn('✅ [MIGRATION] Invités joignables — fin de l\'isolement');
                    this._isolated = false;
                    d.getReconnectionManager()?.hideReconnectOverlay();
                    d.afficherToast('✅ Connexion rétablie.');
                    this._scheduleSweep(runId);
                    return;
                }
                if (Date.now() - restoredAt > ISOLATION_RESTORED_WAIT_MS) {
                    console.error('❌ [MIGRATION] Personne n\'est revenu — retour au lobby');
                    this._isolated = false;
                    d.returnToInitialLobby('Connexion rétablie, mais la partie est introuvable. Demandez le code actuel aux autres joueurs.');
                    return;
                }
            }
            await sleep(1000);
        }
    }

    /**
     * ✨ NOUVEAU : message `host-moved` reçu par l'ANCIEN hôte (qui se croit encore hôte).
     * Il rejoint alors la partie comme invité, avec le nouveau code et son pseudo (le nouvel
     * hôte le reconnaît : CAS 3, joueur exclu de même pseudo).
     */
    onHostMoved(data, from) {
        const d  = this._d;
        const mp = d.getMultiplayer();
        if (!d.getIsHost() || !d.getGameState()) return;
        if (data.oldHostId !== mp.playerId || !data.newCode) return;
        // Si d'autres joueurs sont toujours connectés à moi, ce n'est pas moi qui ai été remplacé
        if ((d.getGameState()?.players ?? []).some(p => p.id !== mp.playerId && p.id !== from && this._guestAlive(p.id))) {
            console.warn('⚠️ [MIGRATION] host-moved ignoré : des joueurs sont encore connectés à moi');
            return;
        }

        console.warn(`➡️ [MIGRATION] La partie continue chez ${from} (code ${data.newCode}) — je la rejoins comme invité`);
        this._isolated = false;
        this._runId++;
        d.getVoluntaryLeaves().add(from);
        // Abandonner la connexion de notification AVANT de quitter la partie : sinon le
        // `return-to-lobby` diffusé par returnToLobby() atteindrait le nouvel hôte.
        mp.connections.filter(c => c.peer === from).forEach(c => { c._replaced = true; try { c.close(); } catch (e) {} });
        mp.connections = mp.connections.filter(c => c.peer !== from);
        mp._connectedPeers.delete(from);

        d.afficherToast(`🔄 La partie continue avec un nouvel hôte (code ${data.newCode}) — reconnexion…`);
        d.rejoinAsGuest(data.newCode);
    }
}
