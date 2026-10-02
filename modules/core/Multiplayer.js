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
        if (typeof window !== 'undefined') {
            window.addEventListener('offline', () => { this.lastSelfOutageAt = Date.now(); });
            window.addEventListener('online',  () => { this.lastSelfOutageAt = Date.now(); });
        }
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
            this._installHostKeepAlive(this.peer); // ✨ NOUVEAU

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

        return new Promise((resolve, reject) => {
            let _joinResolved = false;

            peer.on('error', (err) => {
                console.error('❌ Erreur de connexion:', err);
                if (_joinResolved) {
                    // Connexion déjà établie : erreur réseau → déconnexion hôte
                    // (✨ ignoré si ce pair est devenu hôte entre-temps)
                    if (!this.isHost && (err.type === 'network' || err.type === 'disconnected' || err.type === 'server-error')) {
                        if (this.onHostDisconnected) {
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
        this._installHostKeepAlive(this.peer);
    }

    /**
     * ✨ NOUVEAU : reprend l'écoute des connexions entrantes sans doubler les listeners
     * (idempotent). Utilisé par un hôte qui retrouve internet : son peer a pu être recréé.
     */
    resumeAccepting() {
        this._listenIncoming();
        this._installHostKeepAlive(this.peer);
    }

    /**
     * ✨ NOUVEAU : un hôte qui perd le serveur de signalisation (coupure réseau, blip) doit
     * s'y reconnecter : PeerJS ne le fait pas seul, et sans cela les invités qui retentent
     * l'ancien code (délai de grâce) ne le retrouvent jamais, même si internet est revenu.
     */
    _installHostKeepAlive(peer) {
        if (!peer || peer._keepAliveInstalled) return;
        peer._keepAliveInstalled = true;
        // signalisation rétablie après une perte (pas à l'ouverture initiale du peer)
        peer.on('open', () => { if (peer._wasDisconnected) this.lastSelfOutageAt = Date.now(); });
        peer.on('disconnected', () => {
            peer._wasDisconnected = true;
            this.lastSelfOutageAt = Date.now();
            if (!this.isHost || this.peer !== peer) return;
            console.warn('📡 [HOST] Serveur de signalisation perdu — tentatives de reconnexion');
            const retry = () => {
                if (!this.isHost || this.peer !== peer || peer.destroyed || !peer.disconnected) return;
                try { peer.reconnect(); } catch (e) {}
                setTimeout(retry, 3000);
            };
            setTimeout(retry, 1000);
        });
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

            this.connections.push(conn);
            console.log('👤 Nouveau joueur connecté:', peerId);

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
            // Messages heartbeat — traités directement, pas de dédup ni de log
            if (data.type === 'heartbeat-ping') {
                if (this.onHeartbeatPing) this.onHeartbeatPing(conn.peer);
                return;
            }
            if (data.type === 'heartbeat-pong') {
                if (this.onHeartbeatPong) this.onHeartbeatPong(conn.peer);
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
            // ✨ NOUVEAU : connexion remplacée / abandonnée volontairement → événement ignoré
            if (conn._replaced) return;

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
    }

    /**
     * Envoyer des données à tous les joueurs connectés
     * @param {Object} data - Données à envoyer
     */
    broadcast(data) {
        // ✅ Ajouter un ID unique pour détecter les doublons côté receveur
        data.msgId = `${this.playerId}-${++this._msgCounter}`;
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
    }
}
