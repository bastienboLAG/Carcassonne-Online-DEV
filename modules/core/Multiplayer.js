import Peer from 'https://esm.sh/peerjs@1.5.2';

// ✨ NOUVEAU : options PeerJS factorisées (auparavant dupliquées dans createGame/joinGame)
function _peerOptions() {
    return {
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
            ]
        }
    };
}

export class Multiplayer {
    constructor() {
        this.peer = null;
        this.connections = []; // Liste des connexions aux autres joueurs
        this.isHost = false;
        this.playerId = null;
        this.onPlayerJoined = null; // Callback quand un joueur rejoint
        this.onPlayerLeft = null; // Callback quand un joueur part
        this.onDataReceived = null; // Callback pour recevoir des données
        this._recentMsgIds = new Set(); // Pour dédupliquer les messages reçus en double
        this._msgCounter = 0; // Compteur pour générer des IDs uniques
        this._connectedPeers = new Set(); // Pour dédupliquer les connexions par peer ID
        this.onHeartbeatPing = null; // Callback quand on reçoit un ping
        this.onHeartbeatPong = null; // Callback quand on reçoit un pong
        this.onHostDisconnected = null; // Callback quand l'hôte se déconnecte (côté invité)

        // ✨ NOUVEAU : id réseau de l'hôte auquel cet invité est (ou tente d'être) connecté.
        // Sert à ne déclencher onHostDisconnected que pour la fermeture de CETTE connexion
        // (et pas pour celle d'une ancienne connexion périmée après un changement d'hôte).
        this.hostPeerId = null;
        this._listening = false; // ✨ NOUVEAU : l'écoute des connexions entrantes est-elle active ?

        // ✨ NOUVEAU : dernier instant où CET appareil a changé d'état réseau (événements
        // offline/online du navigateur, signalisation PeerJS perdue/rétablie). Permet à l'hôte de
        // distinguer « mes invités sont partis » de « c'est moi qui ai été coupé ».
        this.lastSelfOutageAt = 0;

        // ✨ NOUVEAU (diagnostic [NET]) : minuteur de surveillance (silence des connexions, page suspendue)
        // et ping en cours de traitement (pour renvoyer son horodatage dans le pong — mesure du RTT).
        this._wdTimer = null;
        this._wdLast  = 0;
        this._pendingPing = null;

        if (typeof window !== 'undefined') {
            window.addEventListener('offline', () => { this.lastSelfOutageAt = Date.now(); this._netLog('navigateur : hors ligne'); });
            window.addEventListener('online',  () => { this.lastSelfOutageAt = Date.now(); this._netLog('navigateur : en ligne'); });

            // ✅ FIX : PeerJS ne notifie pas toujours la fermeture d'un onglet (événement `close` parfois
            // jamais émis) : l'hôte ne le découvrait que par le heartbeat (~12 s). Un invité qui quitte la
            // page prévient donc l'hôte tout de suite (best-effort) ; l'hôte exécute alors le même chemin
            // qu'une fermeture détectée (voir onData / onClose dans _handleConnection). Le heartbeat
            // reste le filet de sécurité. `persisted` = page mise en cache (bfcache), pas fermée : ignoré.
            window.addEventListener('pagehide', (e) => {
                if (e.persisted || this.isHost || !this.hostPeerId) return;
                this.sendTo(this.hostPeerId, { type: 'page-closing' });
            });

            // ✨ NOUVEAU (diagnostic [NET]) : visibilité de la page (onglet / appli en arrière-plan, écran
            // verrouillé) — une page cachée peut voir ses minuteurs et sa signalisation suspendus.
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', () => {
                    this._netLog(`page ${document.hidden ? 'cachée (arrière-plan / écran verrouillé)' : 'visible'}`);
                });
            }

            // ✨ NOUVEAU (diagnostic [NET]) : type de réseau quand le navigateur le fournit (Chrome/Edge/Opera
            // surtout, Android ; absent sur Safari/iPhone et Firefox). `effectiveType` mesure la QUALITÉ
            // (jamais plus que « 4g »), pas la technologie : on ne peut pas distinguer 4G de 5G.
            const nc = (typeof navigator !== 'undefined') ? navigator.connection : null;
            if (nc) {
                this._logConnectionInfo('réseau au chargement :');
                try { nc.addEventListener('change', () => this._logConnectionInfo('changement de réseau :')); } catch (e) {}
            } else {
                this._netLog('Network Information API indisponible sur ce navigateur (type de réseau inconnu)');
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Diagnostic [NET] — uniquement des logs, aucune logique de jeu
    // ─────────────────────────────────────────────────────────────

    _netLog(msg) {
        console.log(`[NET] ${msg}`);
    }

    _logConnectionInfo(prefix) {
        const nc = (typeof navigator !== 'undefined') ? navigator.connection : null;
        if (!nc) return;
        this._netLog(`${prefix} type=${nc.type ?? '?'} effectif=${nc.effectiveType ?? '?'} rtt≈${nc.rtt ?? '?'} ms débit≈${nc.downlink ?? '?'} Mb/s économie-données=${nc.saveData ?? '?'}`);
    }

    /**
     * ✨ NOUVEAU (diagnostic [NET]) : un seul minuteur léger (2 s), démarré à la première connexion.
     *  - retard du minuteur → la page (ou le navigateur) a été suspendue ou bloquée ;
     *  - silence d'une connexion > 5 s → journalisé une fois par épisode (la reprise est journalisée
     *    dans onData avec sa durée).
     */
    _startNetWatchdog() {
        if (this._wdTimer) return;
        this._wdLast = Date.now();
        this._wdTimer = setInterval(() => {
            const now  = Date.now();
            const late = now - this._wdLast - 2000;
            this._wdLast = now;
            if (late > 2500) {
                const vis = (typeof document !== 'undefined' && document.hidden) ? 'cachée' : 'visible';
                this._netLog(`minuteur en retard de ${(late / 1000).toFixed(1)} s — page suspendue ou thread bloqué (page ${vis})`);
            }
            this.connections.forEach(conn => {
                if (!conn.open) return;
                const silence = now - (conn._lastDataAt || conn._openedAt || now);
                if (silence > 5000 && !conn._silenceLogged) {
                    conn._silenceLogged = true;
                    this._netLog(`silence de ${(silence / 1000).toFixed(1)} s sur la connexion de ${conn.peer}`);
                }
            });
        }, 2000);
    }

    /**
     * ✅ FIX : le lien de DONNÉES vers l'hôte est-il vivant ? (connexion ouverte ET des messages reçus
     * récemment — l'hôte envoie un ping de heartbeat toutes les 3 s). Distingue une vraie perte de
     * l'hôte d'une simple erreur de la signalisation PeerJS (serveur public), qui n'affecte pas les
     * connexions WebRTC déjà établies.
     */
    isHostLinkAlive(maxAgeMs = 7000) {
        const conn = this.connections.find(c => c.peer === this.hostPeerId);
        if (!conn || !conn.open) return false;
        return (Date.now() - (conn._lastDataAt || conn._openedAt || 0)) < maxAgeMs;
    }

    // ─────────────────────────────────────────────────────────────
    // Helpers PeerJS
    // ─────────────────────────────────────────────────────────────

    /**
     * ✨ NOUVEAU : code à 6 chiffres (même format que le code de partie de l'hôte).
     * Les invités s'enregistrent eux aussi sous un code à 6 chiffres : si l'un d'eux devient
     * hôte après une perte de l'hôte, son id réseau EST directement le nouveau code de partie.
     */
    _randomCode() {
        return String(Math.floor(100000 + Math.random() * 900000));
    }

    /**
     * ✨ NOUVEAU : ouvre un Peer avec l'id donné (ou aléatoire PeerJS si null).
     * Résout avec le peer ouvert, rejette (et détruit le peer) en cas d'erreur avant ouverture.
     */
    _openPeer(id) {
        return new Promise((resolve, reject) => {
            const peer = id ? new Peer(id, _peerOptions()) : new Peer(undefined, _peerOptions());
            const onOpen = () => { peer.off('error', onError); resolve(peer); };
            const onError = (err) => {
                peer.off('open', onOpen);
                try { peer.destroy(); } catch (e) {}
                reject(err);
            };
            peer.once('open', onOpen);
            peer.once('error', onError);
        });
    }

    /**
     * ✨ NOUVEAU : ouvre un peer invité avec un code à 6 chiffres, en réessayant avec un autre
     * code si celui-ci est déjà pris. `preferredId` (optionnel) est tenté en premier, pour
     * qu'un invité qui se reconnecte conserve le même id réseau.
     */
    async _openGuestPeer(preferredId = null) {
        let lastErr;
        for (let i = 0; i < 8; i++) {
            const id = (i === 0 && preferredId) ? preferredId : this._randomCode();
            try {
                return await this._openPeer(id);
            } catch (err) {
                lastErr = err;
                if (err?.type !== 'unavailable-id') throw err;
            }
        }
        throw lastErr;
    }

    /**
     * ✨ NOUVEAU : écoute les connexions entrantes (hôte). Idempotent.
     * Une nouvelle connexion du même pair est ignorée si elle arrive dans les 3 s suivant
     * l'ouverture de la précédente (double déclenchement PeerJS connu) ; sinon elle REMPLACE
     * l'ancienne (reconnexion d'un invité qui garde le même id réseau, l'ancienne connexion
     * n'ayant pas encore été détectée comme morte).
     */
    _listenIncoming() {
        if (this._listening || !this.peer) return;
        this._listening = true;
        this.peer.on('connection', (conn) => {
            const existing = this.connections.find(c => c.peer === conn.peer);
            if (existing || (conn.peer && this._connectedPeers.has(conn.peer))) {
                const recent = existing && (Date.now() - (existing._openedAt || 0) < 3000);
                if (recent || !existing) {
                    console.warn(`⚠️ [HOST] Connexion entrante ignorée (pair déjà connu): ${conn.peer}`);
                    return;
                }
                console.warn(`🔁 [HOST] Connexion entrante remplace l'ancienne pour: ${conn.peer}`);
                existing._replaced = true;
                this.connections = this.connections.filter(c => c !== existing);
                this._connectedPeers.delete(conn.peer);
                try { existing.close(); } catch (e) {}
            }
            this._handleConnection(conn);
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Création / jonction
    // ─────────────────────────────────────────────────────────────

    /**
     * Créer une partie (devenir l'hôte)
     * @returns {Promise<string>} L'ID de la partie (code à partager)
     */
    async createGame() {
        return new Promise((resolve, reject) => {
            // Générer un code à 6 chiffres et créer le peer avec cet ID
            const code = this._randomCode();

            this.peer = new Peer(code, _peerOptions());
            this.isHost = true;
            this._listening = false;
            this._installSignalingKeepAlive(this.peer); // ✨ NOUVEAU

            this.peer.on('open', (id) => {
                this.playerId = id;
                console.log('🎮 Partie créée ! Code:', id);

                // Écouter les connexions entrantes
                this._listenIncoming();

                resolve(id);
            });

            this.peer.on('error', (err) => {
                console.error('❌ Erreur PeerJS:', err);
                reject(err);
            });
        });
    }

    /**
     * Rejoindre une partie existante
     * @param {string} hostId - L'ID de l'hôte
     * @param {string|null} preferredId - ✨ NOUVEAU : id réseau à réutiliser si possible
     * @returns {Promise<void>}
     */
    async joinGame(hostId, preferredId = null) {
        this.hostPeerId = hostId;
        // ✨ NOUVEAU : l'invité s'enregistre sous un code à 6 chiffres (réessai si collision)
        const peer = await this._openGuestPeer(preferredId);
        this.peer = peer;
        this.isHost = false;
        this._listening = false;
        this.playerId = peer.id;
        // ✅ FIX : un invité doit lui aussi se reconnecter au serveur de signalisation quand il le perd
        // (avant, seul l'hôte le faisait) — sinon il n'est plus joignable par son id (reconnexion,
        // promotion éventuelle en hôte).
        this._installSignalingKeepAlive(peer);

        return new Promise((resolve, reject) => {
            let _joinResolved = false;

            peer.on('error', (err) => {
                console.error('❌ Erreur de connexion:', err);
                if (_joinResolved) {
                    // Connexion déjà établie : erreur réseau → déconnexion hôte
                    // (✨ ignoré si ce pair est devenu hôte entre-temps)
                    if (!this.isHost && (err.type === 'network' || err.type === 'disconnected' || err.type === 'server-error')) {
                        // ✅ FIX : ces erreurs concernent la liaison avec le serveur de signalisation PeerJS
                        // (la WebSocket qui sert à se trouver par id), PAS la connexion de données WebRTC
                        // vers l'hôte, qui survit normalement à une perte de signalisation. Lancer la
                        // reprise d'hôte ferme volontairement (reconnectTo) cette connexion saine : l'hôte
                        // voit alors le joueur « partir » → fausse « Partie en pause » chez tout le monde.
                        // On ne déclenche donc la perte de l'hôte que si le lien de données n'est plus vivant ;
                        // sinon la signalisation est simplement rétablie (_installSignalingKeepAlive). Une vraie
                        // perte de l'hôte reste détectée par la fermeture de sa connexion ou par le heartbeat.
                        if (this.isHostLinkAlive()) {
                            this._netLog(`erreur de signalisation (${err.type}) mais lien de données vers l'hôte vivant — pas de reprise d'hôte`);
                        } else if (this.onHostDisconnected) {
                            this._netLog(`erreur de signalisation (${err.type}) et lien de données vers l'hôte non vivant → perte de l'hôte`);
                            this.onHostDisconnected();
                        }
                    }
                } else {
                    // Erreur pendant la tentative de connexion initiale
                    reject(err);
                }
            });

            console.log('🔌 Connexion à la partie:', hostId);

            // Se connecter à l'hôte
            const conn = peer.connect(hostId);
            // resolve() dans le conn.on('open') de _handleConnection
            conn.once('open', () => {
                console.log('✅ Connecté à l\'hôte !');
                _joinResolved = true;
                resolve();
            });
            this._handleConnection(conn);
        });
    }

    /**
     * ✨ NOUVEAU : s'assure que le peer local est utilisable (ouvert, connecté au serveur de
     * signalisation) SANS changer d'id réseau. Utilisé pendant le délai de grâce qui suit la
     * perte de l'hôte, et avant une promotion en hôte : l'id de cet invité est celui annoncé
     * aux autres joueurs dans le snapshot, il ne doit donc pas changer.
     */
    async ensurePeerReady() {
        if (!this.peer || this.peer.destroyed) {
            this.peer = await this._openGuestPeer(this.playerId);
            this.playerId = this.peer.id;
            this._listening = false;
            this.peer.on('error', (err) => console.error('❌ Erreur PeerJS (peer recréé):', err));
            this._installSignalingKeepAlive(this.peer); // ✅ FIX : peer recréé → même keep-alive de signalisation
            return;
        }
        if (this.peer.disconnected) {
            try { this.peer.reconnect(); } catch (e) {}
            await new Promise((res) => {
                const t = setTimeout(res, 5000);
                this.peer.once('open', () => { clearTimeout(t); res(); });
            });
        }
        if (this.peer.disconnected || this.peer.destroyed) {
            throw new Error('Peer indisponible');
        }
    }

    /**
     * ✨ NOUVEAU : tente une (re)connexion à `hostId` en conservant le même peer / id réseau.
     * Résout à l'ouverture de la connexion, rejette sur échec (peer introuvable, timeout).
     * Les anciennes connexions sont abandonnées (marquées `_replaced` pour que leur éventuel
     * événement `close` tardif soit ignoré).
     */
    async reconnectTo(hostId, timeoutMs = 4000) {
        await this.ensurePeerReady();
        this.hostPeerId = hostId;

        this.connections.forEach(c => { c._replaced = true; try { c.close(); } catch (e) {} });
        this.connections = [];
        this._connectedPeers.clear();

        return new Promise((resolve, reject) => {
            const conn = this.peer.connect(hostId);
            const onErr = (err) => {
                if (err?.type === 'peer-unavailable') {
                    clearTimeout(timer);
                    this.peer.off('error', onErr);
                    reject(err);
                }
            };
            const timer = setTimeout(() => {
                this.peer.off('error', onErr);
                conn._replaced = true;
                try { conn.close(); } catch (e) {}
                reject(new Error('timeout'));
            }, timeoutMs);
            conn.once('open', () => {
                clearTimeout(timer);
                this.peer.off('error', onErr);
                resolve();
            });
            this.peer.on('error', onErr);
            this._handleConnection(conn);
        });
    }

    /**
     * ✨ NOUVEAU : bascule ce peer (jusque-là invité) en hôte — étape 1, à appeler une fois
     * que tout est prêt côté jeu. Abandonne les connexions vers l'ancien hôte.
     * Son id réseau (6 chiffres) devient le code de partie.
     */
    prepareHostTakeover() {
        this.connections.forEach(c => { c._replaced = true; try { c.close(); } catch (e) {} });
        this.connections = [];
        this._connectedPeers.clear();
        this.isHost = true;
        this.hostPeerId = null;
        this.onHostDisconnected = null;
    }

    /**
     * ✨ NOUVEAU : bascule en hôte — étape 2 : commence à accepter les connexions entrantes.
     * À appeler EN DERNIER, une fois les handlers hôte installés, pour ne jamais recevoir un
     * message d'invité avant que l'hôte sache le traiter.
     */
    startAccepting() {
        this._listening = false;
        this._listenIncoming();
        this._installSignalingKeepAlive(this.peer);
    }

    /**
     * ✨ NOUVEAU : reprend l'écoute des connexions entrantes sans doubler les listeners
     * (idempotent). Utilisé par un hôte qui retrouve internet : son peer a pu être recréé.
     */
    resumeAccepting() {
        this._listenIncoming();
        this._installSignalingKeepAlive(this.peer);
    }

    /**
     * ✨ NOUVEAU : un pair (hôte OU invité) qui perd le serveur de signalisation (coupure réseau, blip du
     * serveur public PeerJS) doit s'y reconnecter : PeerJS ne le fait pas seul, et sans cela le pair n'est
     * plus joignable par son id (les invités qui retentent l'ancien code de l'hôte pendant le délai de
     * grâce ne le retrouvent jamais, même si internet est revenu). Les connexions de données déjà établies
     * ne dépendent pas de la signalisation et ne sont pas touchées. Idempotent par peer.
     * ✅ FIX : auparavant réservé à l'hôte (`_installHostKeepAlive`) ; journalise aussi les événements
     * du peer pour le diagnostic [NET].
     */
    _installSignalingKeepAlive(peer) {
        if (!peer || peer._keepAliveInstalled) return;
        peer._keepAliveInstalled = true;
        // signalisation rétablie après une perte (pas à l'ouverture initiale du peer)
        peer.on('open', () => {
            if (peer._wasDisconnected) {
                this.lastSelfOutageAt = Date.now();
                this._netLog('signalisation PeerJS rétablie');
            }
        });
        peer.on('disconnected', () => {
            peer._wasDisconnected = true;
            this.lastSelfOutageAt = Date.now();
            this._netLog('signalisation PeerJS perdue — tentatives de reconnexion');
            const retry = () => {
                if (this.peer !== peer || peer.destroyed || !peer.disconnected) return;
                try { peer.reconnect(); } catch (e) {}
                setTimeout(retry, 3000);
            };
            setTimeout(retry, 1000);
        });
        peer.on('close', () => this._netLog('peer PeerJS fermé / détruit'));
        peer.on('error', (err) => this._netLog(`erreur PeerJS type=${err?.type} (${err?.message ?? ''})`));
    }

    /**
     * ✨ NOUVEAU : envoie un message ponctuel à un pair (connexion brute, NON enregistrée dans
     * this.connections), puis la referme. Résout après l'envoi, rejette si le pair est
     * introuvable ou ne répond pas. Utilisé par le nouvel hôte pour prévenir l'ancien hôte.
     */
    notifyPeer(targetId, message, timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
            if (!this.peer || this.peer.destroyed || this.peer.disconnected) {
                reject(new Error('peer indisponible'));
                return;
            }
            const conn = this.peer.connect(targetId);
            const cleanup = () => { clearTimeout(timer); this.peer.off('error', onErr); };
            const onErr = (err) => {
                if (err?.type === 'peer-unavailable') { cleanup(); reject(err); }
            };
            const timer = setTimeout(() => {
                cleanup();
                try { conn.close(); } catch (e) {}
                reject(new Error('timeout'));
            }, timeoutMs);
            conn.once('open', () => {
                cleanup();
                conn.send(message);
                setTimeout(() => { try { conn.close(); } catch (e) {} }, 1500);
                resolve();
            });
            this.peer.on('error', onErr);
        });
    }

    /**
     * Gérer une nouvelle connexion
     * @private
     */
    _handleConnection(conn) {
        // ✅ Utiliser un flag sur conn pour garantir l'initialisation unique
        // même si PeerJS déclenche 'open' plusieurs fois
        conn._initialized = false;

        const onOpen = () => {
            const peerId = conn.peer;

            // ✅ Dédupliquer via Set global — couvre tous les cas
            // (double open, double _handleConnection, deux objets conn pour même pair)
            if (this._connectedPeers.has(peerId)) {
                console.warn(`⚠️ Pair déjà connecté, connexion ignorée: ${peerId}`);
                return;
            }
            this._connectedPeers.add(peerId);
            conn._openedAt = Date.now(); // ✨ NOUVEAU : voir _listenIncoming
            conn._lastDataAt = conn._openedAt; // ✨ NOUVEAU : voir isHostLinkAlive / diagnostic [NET]

            this.connections.push(conn);
            console.log('👤 Nouveau joueur connecté:', peerId);
            this._netLog(`connexion ouverte avec ${peerId}`);

            // ✨ NOUVEAU (diagnostic [NET]) : états WebRTC de cette connexion (ICE / connexion)
            try {
                const pc = conn.peerConnection;
                if (pc) {
                    pc.addEventListener('iceconnectionstatechange', () => this._netLog(`ICE ${peerId} : ${pc.iceConnectionState}`));
                    pc.addEventListener('connectionstatechange',    () => this._netLog(`WebRTC ${peerId} : ${pc.connectionState}`));
                }
            } catch (e) { /* diagnostic uniquement */ }
            this._startNetWatchdog();

            if (this.onPlayerJoined) {
                this.onPlayerJoined(peerId);
            }

            conn.send({
                type: 'welcome',
                from: this.playerId,
                message: 'Bienvenue dans la partie !',
                version: this.appVersion ?? null,
                origin:  this.appOrigin  ?? null,
            });
        };

        const onData = (data) => {
            // ✨ NOUVEAU (diagnostic [NET] + isHostLinkAlive) : toute donnée reçue prouve que le lien vit
            const _now = Date.now();
            if (conn._silenceLogged) {
                this._netLog(`données de ${conn.peer} reprises après ${((_now - (conn._lastDataAt || _now)) / 1000).toFixed(1)} s de silence`);
                conn._silenceLogged = false;
            }
            conn._lastDataAt = _now;

            // Messages heartbeat — traités directement, pas de dédup ni de log
            if (data.type === 'heartbeat-ping') {
                // ✨ NOUVEAU (diagnostic [NET]) : mémoriser l'horodatage du ping le temps que le pong parte
                // (broadcast le recopie dans le pong, adressé à l'émetteur) — mesure du temps de réponse.
                this._pendingPing = data.t ? { t: data.t, from: conn.peer } : null;
                try {
                    if (this.onHeartbeatPing) this.onHeartbeatPing(conn.peer);
                } finally {
                    this._pendingPing = null;
                }
                return;
            }
            if (data.type === 'heartbeat-pong') {
                if (data.t && data.to === this.playerId) {
                    const rtt = _now - data.t;
                    if (rtt > 500) this._netLog(`temps de réponse élevé avec ${conn.peer} : ${rtt} ms`);
                }
                if (this.onHeartbeatPong) this.onHeartbeatPong(conn.peer);
                return;
            }

            // ✅ FIX : un invité annonce qu'il quitte la page (pagehide) → même traitement qu'une
            // fermeture de connexion détectée, sans attendre le heartbeat. Réservé à l'hôte.
            if (data.type === 'page-closing') {
                if (this.isHost) {
                    console.log(`🚪 Fermeture de page annoncée par ${conn.peer}`);
                    onClose();
                    try { conn.close(); } catch (e) {}
                }
                return;
            }

            // Dédupliquer les messages broadcast reçus en double
            if (data.msgId) {
                if (this._recentMsgIds.has(data.msgId)) {
                    console.warn(`⚠️ Message dupliqué ignoré: ${data.msgId}`);
                    return;
                }
                this._recentMsgIds.add(data.msgId);
                setTimeout(() => this._recentMsgIds.delete(data.msgId), 5000);
            }
            console.log('📨 Données reçues:', data);
            if (this.onDataReceived) {
                this.onDataReceived(data, conn.peer);
            }
        };

        const onClose = () => {
            // ✨ NOUVEAU (diagnostic [NET]) : journaliser TOUTE fermeture, y compris celles qu'on provoque
            const _age = conn._lastDataAt ? ((Date.now() - conn._lastDataAt) / 1000).toFixed(1) : '?';
            this._netLog(`connexion fermée avec ${conn.peer} (dernier message il y a ${_age} s${conn._replaced ? ', abandonnée volontairement' : ''})`);
            // ✨ NOUVEAU : connexion remplacée / abandonnée volontairement → événement ignoré
            if (conn._replaced) return;
            // ✅ FIX : idempotent — `page-closing` puis l'événement `close` tardif de PeerJS (ou
            // l'inverse) ne doivent déclencher onPlayerLeft qu'une seule fois.
            if (conn._closeHandled) return;
            conn._closeHandled = true;

            const peerId = conn.peer;
            console.log('👋 Joueur déconnecté:', peerId);
            this.connections = this.connections.filter(c => c !== conn);
            this._connectedPeers.delete(peerId);
            if (this.onPlayerLeft) {
                this.onPlayerLeft(peerId);
            }
            // Si on est invité et que c'est l'hôte qui déco → callback dédié
            // ✨ NOUVEAU : uniquement pour l'hôte COURANT (hostPeerId), pas pour une ancienne connexion
            if (!this.isHost && this.onHostDisconnected && conn.peer === this.hostPeerId) {
                this.onHostDisconnected();
            }
        };

        conn.on('open',  onOpen);
        conn.on('data',  onData);
        conn.on('close', onClose);
        conn.on('error', (err) => this._netLog(`erreur de connexion avec ${conn.peer} : ${err?.type ?? ''} ${err?.message ?? err}`)); // ✨ NOUVEAU (diagnostic [NET])
    }

    /**
     * Envoyer des données à tous les joueurs connectés
     * @param {Object} data - Données à envoyer
     */
    broadcast(data) {
        // ✅ Ajouter un ID unique pour détecter les doublons côté receveur
        data.msgId = `${this.playerId}-${++this._msgCounter}`;
        // ✨ NOUVEAU (diagnostic [NET]) : horodatage des pings ; le pong renvoie celui du ping auquel il répond
        // (`to` = émetteur du ping : seul lui calcule le temps de réponse). Champs ignorés par le jeu.
        if (data.type === 'heartbeat-ping') {
            data.t = Date.now();
        } else if (data.type === 'heartbeat-pong' && this._pendingPing) {
            data.t  = this._pendingPing.t;
            data.to = this._pendingPing.from;
        }
        this.connections.forEach(conn => {
            if (conn.open) {
                conn.send(data);
            }
        });
    }

    /**
     * Envoyer des données à un joueur spécifique
     * @param {string} playerId - ID du joueur
     * @param {Object} data - Données à envoyer
     */
    sendTo(playerId, data) {
        const conn = this.connections.find(c => c.peer === playerId);
        if (conn && conn.open) {
            conn.send(data);
        }
    }

    /**
     * Envoyer à tous sauf un pair spécifique (pour le relais hôte)
     */
    broadcastExcept(data, excludePeerId) {
        this.connections.forEach(conn => {
            if (conn.open && conn.peer !== excludePeerId) {
                conn.send(data);
            }
        });
    }

    /**
     * Fermer toutes les connexions
     */
    disconnect() {
        this.connections.forEach(conn => conn.close());
        if (this.peer) {
            this.peer.destroy();
        }
        if (this._wdTimer) { clearInterval(this._wdTimer); this._wdTimer = null; } // ✨ NOUVEAU (diagnostic [NET])
    }
}
