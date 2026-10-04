/**
 * HeartbeatManager - Détecte les pertes de connexion silencieuses
 * Envoie un ping toutes les 3 s, alerte après 10 s sans réponse (3 pings perdus d'affilée).
 * Même valeur dans les deux sens : un invité qui juge l'hôte perdu, et l'hôte qui juge un invité
 * parti. Les fausses alertes de l'hôte après SA PROPRE coupure sont filtrées ailleurs
 * (ReconnectionManager._isHostIsolated) ; ce délai alimente HostMigration (HOST_GRACE_MS).
 */
export class HeartbeatManager {
    constructor({ multiplayer, onPeerTimeout }) {
        this.multiplayer    = multiplayer;
        this.onPeerTimeout  = onPeerTimeout; // (peerId) => void
        this._interval      = null;
        this._lastPong      = {}; // { peerId: timestamp }
        this._timedOut      = new Set(); // peers déjà signalés
        this._PING_INTERVAL = 3000;  // 3 s
        this._TIMEOUT       = 10000; // 10 s (auparavant 30 s)
    }

    start() {
        if (this._interval) return;
        console.log('💓 HeartbeatManager démarré');

        this._interval = setInterval(() => {
            const now = Date.now();

            // Envoyer un ping à tous
            this.multiplayer.broadcast({ type: 'heartbeat-ping' });

            // Vérifier les timeouts
            for (const peerId of this.multiplayer._connectedPeers) {
                const last = this._lastPong[peerId];
                if (!last) {
                    // Initialiser au démarrage
                    this._lastPong[peerId] = now;
                } else if (now - last > this._TIMEOUT && !this._timedOut.has(peerId)) {
                    this._timedOut.add(peerId);
                    console.warn(`💔 Timeout détecté pour ${peerId}`);
                    if (this.onPeerTimeout) this.onPeerTimeout(peerId);
                }
            }
        }, this._PING_INTERVAL);
    }

    stop() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
            this._lastPong = {};
            console.log('💓 HeartbeatManager arrêté');
        }
    }

    /**
     * Appelé quand on reçoit un pong (réponse à notre ping)
     */
    receivePong(peerId) {
        this._lastPong[peerId] = Date.now();
        // ✅ FIX : un pair qui répond de nouveau est vivant — le retirer des « déjà signalés ».
        // Sans cela, un invité qui avait détecté la perte de l'hôte puis l'avait retrouvé (même
        // id) ne détectait JAMAIS une seconde perte du même hôte (garde `_timedOut`), et restait
        // bloqué sur une connexion morte. Côté invité uniquement : côté hôte, c'est le
        // handshake de reconnexion (CAS 3/5) qui réactive le joueur, pas un simple pong.
        if (!this.multiplayer.isHost) this._timedOut.delete(peerId);
    }

    /**
     * Appelé quand on reçoit un ping — on répond avec un pong
     */
    receivePing() {
        this.multiplayer.broadcast({ type: 'heartbeat-pong' });
    }
}
