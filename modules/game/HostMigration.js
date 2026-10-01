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
 * Les invités gardent le même id réseau pendant toute la procédure (pas de destroy/recréation
 * du peer) : la liste des successeurs du snapshot reste valable, et le nouvel hôte les
 * retrouve via le CAS 5 de ReconnectionManager.initInGameNetworkHandler (même id).
 */

// 🧪 Valeur de test. Passer à 20000 (20 s) une fois les tests terminés.
export const HOST_GRACE_MS = 5000;

const RETRY_DELAY_MS   = 1000;  // pause entre deux tentatives de connexion
const HELLO_TIMEOUT_MS = 6000;  // attente de la confirmation du (nouvel) hôte après ouverture du canal
const POST_PROMOTION_SNAPSHOT_MS = 5000; // snapshot de rattrapage après une promotion

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
    }

    /** Remise à zéro (retour au lobby, nouvelle partie). */
    reset() {
        this._runId++;
        this._snapshot = null;
        this._state = 'idle';
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
        const t0   = Date.now();
        const myId = mp.playerId;

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
    }
}
