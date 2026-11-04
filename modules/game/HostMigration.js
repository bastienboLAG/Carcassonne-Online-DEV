/**
 * HostMigration — Changement d'hôte en cours de partie
 *
 * Principe :
 *  - L'hôte diffuse à chaque fin de tour un SNAPSHOT complet (même contenu qu'un
 *    full-state-sync + hostId + liste ordonnée des successeurs possibles). Il en rediffuse aussi un
 *    à chaque arrivée / retour d'un joueur (si le tour n'est pas encore entamé), pour que personne
 *    ne reste sans snapshot.
 *  - Si un invité perd l'hôte (fermeture de connexion, erreur réseau ou heartbeat muet), il
 *    tente d'abord de le rejoindre pendant un délai de grâce (sauté si l'hôte a annoncé son départ,
 *    `host-leaving` : une page fermée ou rechargée ne revient jamais sous le même id), puis parcourt
 *    les successeurs dans l'ordre : pour chacun, il tente de le rejoindre pendant un délai de grâce ;
 *    s'il arrive à son propre tour dans la liste, il se promeut hôte.
 *  - Le nouvel hôte a pour code de partie son propre id réseau (6 chiffres, cf. Multiplayer).
 *    Aucune tentative de récupérer l'ancien code (un seul numéro à la fois).
 *  - L'état restauré est celui du DÉBUT du tour en cours (le dernier snapshot).
 *  - Un joueur qui n'a AUCUN snapshot (arrivé juste avant la chute de l'hôte, tour déjà entamé) ne
 *    peut pas participer à l'élection : il retente l'ancien code puis renonce au bout de
 *    NO_SNAPSHOT_GIVE_UP_MS (retour au lobby avec un message).
 *
 * Ancien hôte (option B) :
 *  - il est traité comme un invité DÉCONNECTÉ (et non exclu) : « Partie en pause » chez tous, avec
 *    le bouton « Continuer sans lui ». Son tour n'est pas sauté : s'il revient (même pseudo → CAS 3
 *    de ReconnectionManager) il retrouve son tour et sa tuile en main ; sinon la table l'exclut
 *    (la tuile en main est alors rejouée par le joueur suivant, jamais perdue) ;
 *  - s'il est lui-même isolé (hors ligne / serveur de signalisation perdu), il le détecte
 *    (ReconnectionManager._isHostIsolated) au lieu de croire que ses invités sont partis : mode
 *    « isolement » (onSelfIsolated) — overlay de reconnexion, reconnexion au serveur de
 *    signalisation sous le MÊME id, aucune pause ni exclusion de joueur ;
 *  - s'il retrouve internet avant la fin du délai de grâce des invités, ceux-ci le rejoignent
 *    (CAS 5) et la partie continue chez lui ;
 *  - sinon le nouvel hôte le prévient (`host-moved`, sondage par son ancien id) : il quitte son
 *    rôle d'hôte et rejoint automatiquement la partie avec le nouveau code et son pseudo.
 *
 * Lobby (lot 2) : même mécanique, sans snapshot — les invités connaissent déjà la liste des
 *  joueurs. Hôte qui QUITTE le salon : il désigne un successeur (`lobby-host-transfer`, ordre de
 *  la liste des joueurs) au lieu de fermer le salon. Hôte qui disparaît : élection identique à
 *  celle de la partie (grâce, puis successeurs dans l'ordre de la liste).
 *
 * Les invités gardent le même id réseau pendant toute la procédure (pas de destroy/recréation
 * du peer) : la liste des successeurs du snapshot reste valable, et le nouvel hôte les
 * retrouve via le CAS 5 de ReconnectionManager.initInGameNetworkHandler (même id).
 */

import { remapExtraStateIds } from '../GameState.js'; // ✨ NOUVEAU : remap des ids dans un snapshot reçu

// Délai de grâce : temps laissé à un hôte injoignable (puis à chaque successeur) pour revenir
// avant de passer au suivant. S'ajoute au délai de détection du heartbeat (HeartbeatManager, 5 s).
export const HOST_GRACE_MS = 20000;

const RETRY_DELAY_MS   = 1000;  // pause entre deux tentatives de connexion
const HELLO_TIMEOUT_MS = 6000;  // attente de la confirmation du (nouvel) hôte après ouverture du canal
const POST_PROMOTION_SNAPSHOT_MS = 5000; // snapshot de rattrapage après une promotion
const PROBE_INTERVAL_MS = 3000;       // nouvel hôte : pause entre deux tentatives de prévenir l'ancien hôte
const PROBE_MAX_MS      = 15 * 60000; // nouvel hôte : abandon du sondage de l'ancien hôte
const LOBBY_SWEEP_MS = 40000;  // nouvel hôte de lobby : retire de la liste les invités qui ne sont pas revenus
const ISOLATION_RESTORED_WAIT_MS = 90000; // ancien hôte reconnecté au réseau : attente max d'invités/notification
const NO_SNAPSHOT_GIVE_UP_MS = 60000; // ✨ NOUVEAU : invité sans snapshot : abandon de la reconnexion « classique »

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
        this._mode = 'game';       // 'game' | 'lobby'
        this._lobbyHello = false;  // lobby : le (nouvel) hôte a-t-il répondu à notre player-info ?
        this._listenersInstalled = false;
        this._giveUpTimer = null;  // ✨ NOUVEAU : abandon de la reconnexion classique (invité sans snapshot)
    }

    /** Remise à zéro (retour au lobby, nouvelle partie). */
    reset() {
        this._runId++;
        this._snapshot = null;
        this._state = 'idle';
        this._isolated = false;
        if (this._giveUpTimer) { clearTimeout(this._giveUpTimer); this._giveUpTimer = null; }
    }

    /**
     * Branche les callbacks GameSync. Appelé à chaque attachGameSyncCallbacks() (démarrage de
     * partie ET promotion), donc idempotent : il relit isHost à chaque événement.
     */
    install() {
        const d  = this._d;
        const gs = d.getGameSync();
        if (!gs) return;
        // ✅ FIX : un nouveau snapshot remplace l'ancien — les ids qu'il contient sont à jour
        gs.onHostSnapshot  = (data) => { if (!d.getIsHost()) this._snapshot = data; };
        // `opts.afterJoin` : snapshot demandé par l'arrivée d'un joueur (voir broadcastSnapshot)
        gs.onTurnEndSynced = (opts) => { if (d.getIsHost()) this.broadcastSnapshot(opts); };
        gs.onHostMoved     = (data, from) => this.onHostMoved(data, from);

        // ✅ FIX : un joueur qui revient sous un nouvel id (`player-id-remapped`) doit aussi être remappé dans le
        // snapshot STOCKÉ (ids des joueurs et liste des successeurs) : sinon, à la promotion, le vieux snapshot
        // écrasait le remap déjà appliqué à l'état vivant, et l'élection attendait des ids morts. Enveloppe le
        // callback posé par GameSyncCallbacks.attach (appelé juste avant install()).
        const prevRemap = gs.onPlayerIdRemapped;
        gs.onPlayerIdRemapped = (oldId, newId) => {
            this._remapSnapshot(oldId, newId);
            if (prevRemap) prevRemap(oldId, newId);
        };

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

    /**
     * @param {{afterJoin?: boolean}} [opts] — `afterJoin` : appelé après l'arrivée / le retour d'un joueur. Le
     *   snapshot restaure « le début du tour en cours » ; pris tuile déjà posée, il ferait reprendre la partie
     *   en plein milieu du tour (et bloquerait le tour suivant si l'ancien hôte jouait). On ne le diffuse donc
     *   que si le tour n'est pas entamé ; sinon il est différé (celui de la fin de tour, envoyé à tous, suivra).
     */
    broadcastSnapshot(opts = {}) {
        const d  = this._d;
        const rm = d.getReconnectionManager();
        const gs = d.getGameSync();
        const gameState = d.getGameState();
        if (!rm || !gs || !gameState || !d.getIsHost()) return;

        if (opts?.afterJoin && (gameState.currentTilePlaced || gameState.dragonPhase?.active)) {
            console.log('📸 [MIGRATION] Snapshot après arrivée différé : tour déjà entamé (diffusé à la fin du tour)');
            return;
        }

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

    /**
     * ✅ FIX : remplace un id de joueur dans le snapshot STOCKÉ (données brutes reçues du réseau) — joueurs,
     * joueurs déconnectés, extraState, fée, meeples posés, échange de prisonniers en attente et surtout
     * `candidates` (liste des successeurs utilisée par l'élection). Même périmètre que GameState.remapPlayerId,
     * appliqué aux données sérialisées.
     */
    _remapSnapshot(oldId, newId) {
        const snap = this._snapshot;
        if (!snap || !oldId || !newId || oldId === newId) return;
        const g = snap.gameState;
        if (g) {
            (g.players ?? []).forEach(p => { if (p.id === oldId) p.id = newId; });
            const dp = g.disconnectedPlayers;
            if (dp && dp[oldId]) {
                const entry = dp[oldId];
                if (entry.player && entry.player.id === oldId) entry.player.id = newId;
                dp[newId] = entry;
                delete dp[oldId];
            }
            remapExtraStateIds(g.extraState, oldId, newId);
            if (g.fairyState?.ownerId === oldId) g.fairyState.ownerId = newId;
        }
        Object.values(snap.placedMeeples ?? {}).forEach(m => { if (m.playerId === oldId) m.playerId = newId; });
        const pe = snap.pendingPrisonerExchange;
        if (pe) {
            if (pe.chooserId  === oldId) pe.chooserId  = newId;
            if (pe.opponentId === oldId) pe.opponentId = newId;
        }
        snap.candidates = (snap.candidates ?? []).map(id => id === oldId ? newId : id);
        console.log(`🔧 [MIGRATION] Snapshot stocké : id ${oldId} → ${newId} (successeurs: ${snap.candidates.join(', ') || '(aucun)'})`);
    }

    /**
     * ✨ NOUVEAU : l'état restauré par un changement d'hôte est celui du DÉBUT du tour (snapshot).
     * Tout l'état transitoire du tour avorté (non sérialisé, donc non remplacé par la
     * resynchronisation) serait périmé : captures de tour/princesse/portail/dragon en attente,
     * captures « fraîches », compteur « une rançon par tour », drapeaux de l'UndoManager, points
     * d'abbé en attente, curseurs affichés. `_pendingPrisonerExchange` est volontairement ABSENT :
     * il fait partie du paquet d'état (restauré par applyFullStateSync).
     */
    _resetTurnTransientState() {
        const d  = this._d;
        const gs = d.getGameState();
        if (gs) {
            gs._pendingTowerCapture    = null;
            gs._pendingReciprocalCheck = null;
            gs._pendingPrincessTile    = null;
            gs._pendingPortalTile      = null;
            gs._pendingDragonTile      = null;
            gs._pendingVolcanoPos      = null;
            gs._pendingBuilderBonus    = false;
            gs._freshCaptures          = [];
            gs._turnBuybackUsed        = false;
        }
        d.getUndoManager()?.reset();
        d.setPendingAbbePoints?.(null);
        d.hideAllCursors?.();
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
            // Aucun snapshot (arrivé juste avant la chute de l'hôte, tour déjà entamé) : ancien comportement
            // (réessayer l'ancien code), mais plus indéfiniment — voir _armNoSnapshotGiveUp.
            console.warn(`⚠️ [MIGRATION] Hôte perdu sans snapshot — reconnexion classique (abandon dans ${NO_SNAPSHOT_GIVE_UP_MS / 1000} s si l'hôte ne revient pas)`);
            rm?.startAutoReconnect();
            this._armNoSnapshotGiveUp();
            return;
        }

        this._state = 'running';
        this._mode = 'game';
        const runId = ++this._runId;
        // ✅ FIX : si l'hôte a annoncé son départ (`host-leaving`, page fermée ou rechargée), il ne reviendra
        // jamais sous le même id : on saute le délai de grâce, en partie comme au lobby. Sans annonce
        // (coupure réseau, onglet tué), le délai de grâce reste appliqué : son peer peut se reconnecter
        // sous le même id. Valeur relue à chaque perte (le snapshot, lui, peut survivre à plusieurs pertes).
        snap.skipHost = !!d.getMultiplayer().hostLeaving;
        console.warn(`🚨 [MIGRATION] Hôte perdu (${snap.hostId}) — ${snap.skipHost ? 'départ annoncé, pas de délai de grâce' : `délai de grâce ${HOST_GRACE_MS} ms`}, successeurs: ${snap.candidates.join(', ') || '(aucun)'}`);

        rm.stopAutoReconnect();
        rm._showReconnectOverlay();
        this._run(snap, runId).catch(err => {
            console.error('❌ [MIGRATION] Erreur inattendue:', err);
            this._state = 'idle';
        });
    }

    /**
     * ✨ NOUVEAU : invité SANS snapshot — il ne peut participer à aucune élection et ne connaît pas le nouveau
     * code. La reconnexion classique (vers l'ancien code) ne réussit que si l'hôte revient ; sinon, au bout de
     * NO_SNAPSHOT_GIVE_UP_MS, on rend la main au joueur (lobby + message) au lieu de boucler indéfiniment.
     */
    _armNoSnapshotGiveUp() {
        const d  = this._d;
        const mp = d.getMultiplayer();
        if (this._giveUpTimer) clearTimeout(this._giveUpTimer);
        const runId = this._runId;
        this._giveUpTimer = setTimeout(() => {
            this._giveUpTimer = null;
            if (runId !== this._runId || d.getIsHost() || !d.getGameState()) return;
            if (mp.isHostLinkAlive()) {
                console.log('✅ [MIGRATION] Reconnecté à l\'hôte pendant la reconnexion classique');
                return;
            }
            console.error('❌ [MIGRATION] Aucun snapshot et hôte toujours injoignable — retour au lobby');
            const rm = d.getReconnectionManager();
            rm?.stopAutoReconnect();
            rm?.hideReconnectOverlay();
            d.returnToInitialLobby("Partie perdue : l'hôte n'est plus joignable et aucun nouvel hôte n'a pu être désigné. Demandez le nouveau code aux autres joueurs.");
        }, NO_SNAPSHOT_GIVE_UP_MS);
    }

    // ─────────────────────────────────────────────────────────────
    // Lobby : perte ou départ volontaire de l'hôte du salon
    // ─────────────────────────────────────────────────────────────

    /** Successeurs possibles au lobby : ordre de la liste des joueurs, hors hôte et spectateurs. */
    _lobbyCandidates(hostId) {
        return this._d.getPlayers()
            .filter(p => p.id !== hostId && !p.isHost && p.color !== 'spectator')
            .map(p => p.id);
    }

    /** Invité au lobby : l'hôte du salon est injoignable (fermeture, erreur réseau, heartbeat). */
    onLobbyHostLost() {
        const d  = this._d;
        const mp = d.getMultiplayer();
        if (this._state !== 'idle' || d.getIsHost() || d.getGameState()) return;
        const hostId = mp.hostPeerId;
        if (!hostId) return;
        console.warn(`🚨 [MIGRATION][LOBBY] Hôte du salon perdu (${hostId})`);
        // ✨ NOUVEAU : si l'hôte a annoncé son départ (`host-leaving`), pas de délai de grâce
        this._startLobbyRun({ hostId, candidates: this._lobbyCandidates(hostId), skipHost: !!mp.hostLeaving });
    }

    /** Invité au lobby : l'hôte annonce qu'il quitte le salon et désigne ses successeurs. */
    onLobbyHostTransfer(data) {
        const d  = this._d;
        const mp = d.getMultiplayer();
        if (this._state !== 'idle' || d.getIsHost() || d.getGameState()) return;
        if (!data?.oldHostId || data.oldHostId !== mp.hostPeerId) return; // uniquement de la part de MON hôte
        console.warn(`🚪 [MIGRATION][LOBBY] L'hôte quitte le salon — successeurs: ${(data.candidates || []).join(', ')}`);
        this._startLobbyRun({
            hostId: data.oldHostId,
            candidates: (data.candidates || []).filter(id => id !== data.oldHostId),
            skipHost: true,      // il est parti volontairement : inutile de l'attendre
            voluntary: true,
        });
    }

    /** Hôte au lobby : un invité a répondu à notre player-info (voir LobbyJoin, players-update). */
    onLobbyHostHello() {
        if (this._state === 'running' && this._mode === 'lobby') this._lobbyHello = true;
    }

    _startLobbyRun(snap) {
        const d = this._d;
        this._state = 'running';
        this._mode = 'lobby';
        const runId = ++this._runId;
        d.afficherToast(snap.voluntary
            ? '🔄 L\'hôte quitte le salon — un nouvel hôte va être désigné…'
            : '⚠️ L\'hôte du salon est injoignable — reprise en cours…');
        this._run(snap, runId).catch(err => {
            console.error('❌ [MIGRATION][LOBBY] Erreur inattendue:', err);
            this._state = 'idle';
        });
    }

    /**
     * Hôte au lobby qui QUITTE le salon (✕ à côté de son nom, ou « Retour lobby » puis ✕) :
     * au lieu de fermer le salon et d'exclure tout le monde, il passe la main au premier joueur
     * non spectateur de la liste. S'il n'en reste aucun, ancien comportement.
     */
    leaveLobbyAsHost() {
        const d  = this._d;
        const mp = d.getMultiplayer();
        const myId = mp.playerId;
        const guests = d.getPlayers().filter(p => !p.isHost && p.id !== myId);
        const candidates = guests.filter(p => p.color !== 'spectator').map(p => p.id);

        if (candidates.length === 0) {
            if (guests.length > 0) mp.broadcast({ type: 'you-are-kicked' });
            d.returnToInitialLobby();
            return;
        }
        console.warn(`🚪 [MIGRATION][LOBBY] Je quitte le salon — successeurs: ${candidates.join(', ')}`);
        mp.broadcast({ type: 'lobby-host-transfer', oldHostId: myId, candidates });
        // Laisser le message partir avant de détruire le peer (returnToInitialLobby)
        setTimeout(() => d.returnToInitialLobby(), 600);
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
        const targets = snap.skipHost ? [...snap.candidates] : [snap.hostId, ...snap.candidates];

        for (const targetId of targets) {
            if (runId !== this._runId) return;
            if (targetId === myId) {
                console.warn(`👑 [MIGRATION] À mon tour dans la liste (+${Date.now() - t0} ms) — promotion`);
                if (this._mode === 'lobby') await this._promoteLobby(snap, runId);
                else await this._promote(snap, runId);
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
        d.returnToInitialLobby(this._mode === 'lobby'
            ? "L'hôte du salon n'est plus joignable."
            : "Partie perdue : l'hôte n'est plus joignable.");
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
            if (this._mode === 'game') window._isAutoReconnecting = true; // LobbyJoin : répondre par player-info au game-in-progress
            try {
                await mp.reconnectTo(targetId);
                if (this._mode === 'lobby') {
                    // Au lobby, le (nouvel) hôte n'envoie pas de game-in-progress : on se
                    // présente nous-mêmes (player-info) et la réponse (players-update) fait foi.
                    this._lobbyHello = false;
                    this._d.sendLobbyPlayerInfo();
                    if (await this._waitLobbyHello(runId)) return true;
                } else if (await this._waitHello(runId)) return true;
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

    async _waitLobbyHello(runId) {
        const end = Date.now() + HELLO_TIMEOUT_MS;
        while (Date.now() < end) {
            if (runId !== this._runId) return false;
            if (this._lobbyHello) return true;
            await sleep(200);
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
        // Rattaché à un NOUVEAU hôte en partie : son état est celui du début de tour (rollback)
        if (!sameHost && this._mode === 'game') this._resetTurnTransientState();
        d.setGameCode(hostId);
        // ✅ FIX : la modale « Partie en pause » reçue pendant la reconnexion affiche l'ancien code : la redessiner
        d.getReconnectionManager()?.refreshPauseOverlay();
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
        // ✅ FIX : l'ancien hôte est traité comme un invité DÉCONNECTÉ (et non plus exclu) : « Partie en pause »,
        // son tour N'EST PAS sauté et la tuile qu'il avait en main reste la sienne. À son retour (même pseudo →
        // CAS 3) il reprend son tour ; si la table l'exclut, excludeDisconnectedPlayer rejoue sa tuile.
        // Même structure que GameState.markDisconnected (copie du joueur AVANT de le marquer déconnecté).
        let pauseName = null;
        if (oldIdx !== -1) {
            const oldP = gsd.players[oldIdx];
            if (oldP.color === 'spectator') {
                // Un spectateur n'a ni tour ni tuile : simplement retiré (comme handleDisconnect)
                gsd.players.splice(oldIdx, 1);
                if (oldIdx < gsd.currentPlayerIndex) gsd.currentPlayerIndex--;
                if (gsd.currentPlayerIndex >= gsd.players.length) gsd.currentPlayerIndex = 0;
            } else {
                gsd.disconnectedPlayers = gsd.disconnectedPlayers ?? {};
                gsd.disconnectedPlayers[oldHostId] = { player: { ...oldP }, index: oldIdx, disconnectedAt: Date.now() };
                oldP.disconnected = true;
                pauseName = oldP.name;
            }
        }

        // Rôle d'hôte
        // (l'ancienne connexion vers l'ancien hôte est abandonnée par prepareHostTakeover avec `_replaced` :
        // sa fermeture tardive est ignorée, inutile de passer par getVoluntaryLeaves — qui avalerait la
        // prochaine vraie déconnexion de cet id)
        d.setIsHost(true);
        d.setGameCode(myId);
        const gs = d.getGameSync();
        if (gs) gs.isHost = true;
        const tm = d.getTurnManager();
        if (tm) tm.isHost = true;
        mp.prepareHostTakeover();

        // Liste des joueurs du lobby : marquer le nouvel hôte ; l'ancien reste listé (comme tout joueur
        // déconnecté) s'il est en pause — le CAS 3 le retrouve par son ancien id.
        d.setPlayers(d.getPlayers()
            .filter(p => p.id !== oldHostId || pauseName)
            .map(p => p.id === myId ? { ...p, isHost: true }
                    : p.id === oldHostId ? { ...p, isHost: false } : p));

        // Restaurer l'état de début de tour
        this._resetTurnTransientState(); // ✨ NOUVEAU : état du tour avorté (remet aussi l'UndoManager à zéro)
        rm.applyFullStateSync(snap);
        // L'éventuel échange de prisonniers en attente (restauré par applyFullStateSync) dont l'ancien hôte
        // est le choisisseur reste en attente : il pourra choisir à son retour, et s'il est exclu,
        // excludeDisconnectedPlayer le résout (prisonnier le plus ancien) avant de retirer le joueur.
        const tileId = snap.tuileEnMain?.id;
        const tileData = tileId ? d.getDeck().tiles.find(t => t.id === tileId) : null;
        d.setCurrentTileForPlayer(tileData ?? null);

        // Réinstaller tout ce qu'un hôte doit avoir (mêmes fonctions qu'au démarrage d'une partie hôte)
        d.attachGameSyncCallbacks();                          // callbacks hôte + install() de ce module
        rm.initInGameNetworkHandler(d.getInGameNetworkDeps()); // heartbeat hôte, player-info (CAS 1-5), etc.
        d.refreshGameMenu();
        d.updateTurnDisplay();
        // ✨ NOUVEAU (lot 2) : handler lobby hôte, synchro des options, callbacks du salon — pour
        // que « Retour lobby » fonctionne chez ce nouvel hôte (non activés : la partie garde sa chaîne)
        d.prepareHostLobby();

        // Pause : l'ancien hôte est injoignable. Les invités la reçoivent au fil de leur reconnexion
        // (ReconnectionManager.sendFullStateTo renvoie `game-paused` tant que la pause est active).
        if (pauseName) rm.pauseGame(pauseName);

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
     * ✨ NOUVEAU (lot 2) : promotion d'un invité en hôte AU LOBBY. Pas de snapshot : la liste des
     * joueurs et les options sont déjà chez tous les invités. Les autres invités se présentent
     * (player-info) comme après n'importe quelle jonction : le handler lobby hôte les (ré)inscrit
     * et leur renvoie la liste (players-update) et les options (options-sync).
     */
    async _promoteLobby(snap, runId) {
        const d  = this._d;
        const mp = d.getMultiplayer();
        const oldHostId = snap.hostId;

        try {
            await mp.ensurePeerReady();
        } catch (err) {
            console.error('❌ [MIGRATION][LOBBY] Peer inutilisable, promotion impossible:', err);
            this._state = 'idle';
            d.returnToInitialLobby('Impossible de reprendre le salon en tant qu\'hôte.');
            return;
        }
        if (runId !== this._runId) return;

        // ── Bloc synchrone ──
        const myId = mp.playerId;
        const oldHostName = d.getPlayers().find(p => p.id === oldHostId)?.name ?? null;

        d.setIsHost(true);
        d.setGameCode(myId);
        mp.prepareHostTakeover();
        d.setPlayers(d.getPlayers()
            .filter(p => p.id !== oldHostId)
            .map(p => p.id === myId ? { ...p, isHost: true } : p));

        d.prepareHostLobby();   // handler lobby hôte, options, kick / quitter
        d.activateHostLobby();  // onDataReceived, onPlayerJoined/Left, heartbeat hôte
        d.refreshLobby();       // liste des joueurs + accès aux options (désormais hôte)
        mp.startAccepting();    // en dernier

        this._state = 'idle';
        console.warn(`👑 [MIGRATION][LOBBY] Je suis l'hôte du salon — code : ${myId}`);
        d.afficherToast(`👑 Vous êtes maintenant l'hôte du salon. Nouveau code : ${myId}`);

        // Les invités qui ne reviennent pas (partis, hors ligne) ne seraient jamais retirés de la
        // liste : le heartbeat hôte ne surveille que les pairs connectés.
        setTimeout(() => {
            if (runId !== this._runId || !d.getIsHost() || d.getGameState()) return;
            const alive = new Set(mp.connections.filter(c => c.open).map(c => c.peer));
            const before = d.getPlayers();
            const kept = before.filter(p => p.isHost || p.id === myId || alive.has(p.id));
            if (kept.length !== before.length) {
                console.warn(`🧹 [MIGRATION][LOBBY] ${before.length - kept.length} joueur(s) non revenu(s) retiré(s) du salon`);
                d.setPlayers(kept);
                d.refreshLobby();
                mp.broadcast({ type: 'players-update', players: kept });
            }
        }, LOBBY_SWEEP_MS);

        // Départ involontaire : prévenir l'ancien hôte s'il redevient joignable
        if (!snap.voluntary) this._probeOldHost(oldHostId, oldHostName, myId, runId);
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
            if (gameState) {
                if (oldHostName && gameState.players.some(p => p.name === oldHostName && !p.kicked && !p.disconnected)) return;
            } else if (oldHostName && d.getPlayers().some(p => p.name === oldHostName && p.id !== oldHostId)) {
                return; // au lobby : il est déjà revenu de lui-même sous un autre id
            }
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
     * hôte le reconnaît : CAS 3, joueur déconnecté de même pseudo).
     */
    onHostMoved(data, from) {
        const d  = this._d;
        const mp = d.getMultiplayer();
        if (!d.getIsHost()) return;
        if (data.oldHostId !== mp.playerId || !data.newCode) return;
        const gs = d.getGameState();
        // Si d'autres joueurs sont toujours connectés à moi, ce n'est pas moi qui ai été remplacé
        // (en partie : joueurs réellement joignables ; au lobby : joueurs encore listés — le
        // heartbeat du salon retire ceux qui ne répondent plus)
        const stillHaveGuests = gs
            ? gs.players.some(p => p.id !== mp.playerId && p.id !== from && this._guestAlive(p.id))
            : d.getPlayers().some(p => !p.isHost && p.id !== mp.playerId && p.id !== from);
        if (stillHaveGuests) {
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

        d.afficherToast(`🔄 ${gs ? 'La partie continue' : 'Le salon continue'} avec un nouvel hôte (code ${data.newCode}) — reconnexion…`);
        d.rejoinAsGuest(data.newCode, !!gs);
    }
}
