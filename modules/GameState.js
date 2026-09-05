/**
 * Gère l'état partagé du jeu entre tous les joueurs
 */
export class GameState {
    constructor() {
        this.players = [];
        this.currentPlayerIndex = 0;
        this.disconnectedPlayers = {};
        this.placedTiles = {};
        this.deck = [];
        this.destroyedTilesCount = 0;
        this.currentTilePlaced = false;

        // ── Extension Princesse & Dragon ────────────────────────────────
        this.dragonPos = null; // { x, y } | null — position du dragon sur le plateau

        this.dragonPhase = {
            active: false,
            movesRemaining: 0,
            moverIndex: 0,
            visitedTiles: [],        // [[x,y], ...] — sérialisable
            triggeringPlayerIndex: 0
        };

        this.fairyState = {
            ownerId: null,    // playerId du propriétaire de la fée
            meepleKey: null,  // clé "x,y,position" du meeple attaché
        };

        // ── Extension Tour ───────────────────────────────────────────────
        // Map "x,y" -> { height, lockedBy, contributions: { playerId: count } }
        // lockedBy réservé pour une passe future (toujours null pour l'instant)
        this.towers = {};

        // Meeples capturés par une tour : Map playerId (capturant) -> [{ type, ownerId }]
        this.prisoners = {};

        // ✨ NOUVEAU : cible de capture en attente après pose d'un étage (comme _pendingPrincessTile)
        this._pendingTowerCapture = null;
    }

    // ── Dragon ───────────────────────────────────────────────────────────

    placeOrMoveDragon(x, y) {
        this.dragonPos = { x, y };
    }

    startDragonPhase(triggeringPlayerIndex) {
        this.dragonPhase.active = true;
        this.dragonPhase.movesRemaining = 6;
        this.dragonPhase.triggeringPlayerIndex = triggeringPlayerIndex;
        this.dragonPhase.moverIndex = triggeringPlayerIndex;
        this.dragonPhase.visitedTiles = this.dragonPos
            ? [[this.dragonPos.x, this.dragonPos.y]]
            : [];
    }

    moveDragon(x, y) {
        this.dragonPos = { x, y };
        this.dragonPhase.visitedTiles.push([x, y]);
        this.dragonPhase.movesRemaining--;
        // NB : l'avancement du moverIndex est fait séparément dans advanceDragonMover(),
        // appelé uniquement au clic "Terminer mon tour" — pour permettre l'annulation.
    }

    /**
     * Passe la main au joueur suivant dans la phase dragon.
     * Appelé au clic "Terminer mon tour" pendant la phase dragon.
     */
    advanceDragonMover() {
        if (this.dragonPhase.movesRemaining <= 0) return;
        let next = this.dragonPhase.moverIndex;
        let attempts = 0;
        do {
            next = (next + 1) % this.players.length;
            attempts++;
        } while (
            attempts < this.players.length &&
            (this.players[next]?.color === 'spectator' ||
             this.players[next]?.disconnected === true ||
             this.players[next]?.kicked === true)
        );
        this.dragonPhase.moverIndex = next;
    }

    endDragonPhase() {
        this.dragonPhase.active = false;
        this.dragonPhase.movesRemaining = 0;
        this.dragonPhase.visitedTiles = [];
    }

    isDragonVisited(x, y) {
        return this.dragonPhase.visitedTiles.some(([vx, vy]) => vx === x && vy === y);
    }

    // ── Fée ──────────────────────────────────────────────────────────────

    placeFairy(ownerId, meepleKey) {
        this.fairyState.ownerId   = ownerId;
        this.fairyState.meepleKey = meepleKey;
    }

    removeFairy() {
        this.fairyState.ownerId   = null;
        this.fairyState.meepleKey = null;
    }

    isFairyOnTile(x, y) {
        if (!this.fairyState.meepleKey) return false;
        const parts = this.fairyState.meepleKey.split(',');
        return Number(parts[0]) === x && Number(parts[1]) === y;
    }

    // ── Joueurs ──────────────────────────────────────────────────────────

    markDisconnected(peerId) {
        const index = this.players.findIndex(p => p.id === peerId);
        if (index === -1) return null;
        const player = { ...this.players[index] };
        this.disconnectedPlayers[peerId] = { player, index, disconnectedAt: Date.now() };
        this.players[index].disconnected = true;
        return { player, index };
    }

    findDisconnectedByName(name) {
        return Object.entries(this.disconnectedPlayers).find(
            ([, data]) => data.player.name === name
        );
    }

    reconnectPlayer(oldPeerId, newPeerId) {
        const entry = this.disconnectedPlayers[oldPeerId];
        if (!entry) return false;
        const player = this.players.find(p => p.id === oldPeerId);
        if (player) {
            player.id = newPeerId;
            player.disconnected = false;
            player.kicked = false;
        }
        delete this.disconnectedPlayers[oldPeerId];
        return true;
    }

    addPlayer(playerId, playerName, color) {
        this.players.push({
            id: playerId,
            name: playerName,
            color: color,
            score: 0,
            meeples: 7,
            hasAbbot:       false,
            hasLargeMeeple: false,
            hasBuilder:     false,
            hasPig:         false,
            hasFairy:       false,
            towerPieces:    0, // ✨ NOUVEAU : défini au démarrage de partie selon le nombre de joueurs
            goods: { cloth: 0, wheat: 0, wine: 0 },
            scoreDetail: { cities: 0, roads: 0, monasteries: 0, fields: 0, goods: 0, fairy: 0 }
        });
    }

    removePlayer(playerId) {
        this.players = this.players.filter(p => p.id !== playerId);
    }

    getCurrentPlayer() {
        return this.players[this.currentPlayerIndex];
    }

    nextPlayer() {
        let attempts = 0;
        do {
            this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
            attempts++;
        } while (
            this.players[this.currentPlayerIndex]?.color === 'spectator' &&
            attempts < this.players.length
        );
    }

    isPlayerTurn(playerId) {
        return this.getCurrentPlayer()?.id === playerId;
    }

    serialize() {
        return {
            players:            this.players,
            currentPlayerIndex: this.currentPlayerIndex,
            placedTiles:        this.placedTiles,
            disconnectedPlayers:this.disconnectedPlayers,
            currentTilePlaced:  this.currentTilePlaced,
            dragonPos:          this.dragonPos,
            dragonPhase:        this.dragonPhase,
            fairyState:         this.fairyState,
            towers:             this.towers,     // ✨ NOUVEAU
            prisoners:          this.prisoners,  // ✨ NOUVEAU
        };
    }

    deserialize(data) {
        this.players = (data.players || []).map(p => ({
            id:             p.id,
            name:           p.name,
            color:          p.color,
            score:          p.score          || 0,
            meeples:        p.meeples        ?? 7,
            hasAbbot:       p.hasAbbot       ?? false,
            hasLargeMeeple: p.hasLargeMeeple ?? false,
            hasBuilder:     p.hasBuilder     ?? false,
            hasPig:         p.hasPig         ?? false,
            hasFairy:       p.hasFairy       ?? false,
            towerPieces:    p.towerPieces    ?? 0, // ✨ NOUVEAU
            goods:          p.goods          ?? { cloth: 0, wheat: 0, wine: 0 },
            scoreDetail:    p.scoreDetail    || { cities: 0, roads: 0, monasteries: 0, fields: 0, goods: 0, fairy: 0 },
            disconnected:   p.disconnected   ?? false,
            kicked:         p.kicked         ?? false,
        }));
        this.currentPlayerIndex  = data.currentPlayerIndex  || 0;
        this.placedTiles         = data.placedTiles         || {};
        this.disconnectedPlayers = data.disconnectedPlayers || {};
        this.currentTilePlaced   = data.currentTilePlaced   ?? false;

        this.dragonPos = data.dragonPos ?? null;
        this.dragonPhase = {
            active:                data.dragonPhase?.active                ?? false,
            movesRemaining:        data.dragonPhase?.movesRemaining        ?? 0,
            moverIndex:            data.dragonPhase?.moverIndex            ?? 0,
            visitedTiles:          data.dragonPhase?.visitedTiles          ?? [],
            triggeringPlayerIndex: data.dragonPhase?.triggeringPlayerIndex ?? 0,
        };
        this.fairyState = {
            ownerId:   data.fairyState?.ownerId   ?? null,
            meepleKey: data.fairyState?.meepleKey ?? null,
        };

        // ✨ NOUVEAU
        this.towers    = data.towers    ?? {};
        this.prisoners = data.prisoners ?? {};
    }
}
