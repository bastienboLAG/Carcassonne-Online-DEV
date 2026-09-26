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
            meepleKey: null,  // clé "x,y,position" du meeple attaché, ou "tower-lock:x,y"
        };

        // ✨ NOUVEAU : conteneur générique pour tout état persistant "de plateau" qui n'est
        // pas un meeple classique dans placedMeeples (pion/structure/compteur spécifique à
        // une extension). Créé pour l'extension Tour (towers/prisoners), pensé pour accueillir
        // sans modification les futures extensions à état persistant non-meeple (moutons liés
        // au berger, granges, ponts, forteresses...). Sérialisé en un seul bloc (voir
        // serialize/deserialize ci-dessous) et restauré génériquement par
        // UndoManager.restoreExtraState — AUCUN de ces deux mécanismes n'a besoin d'être
        // modifié quand une nouvelle sous-clé est ajoutée ici. Voir ARCHITECTURE.md, section
        // "Ajouter une extension avec pièces/état persistant", pour la marche à suivre.
        this.extraState = {
            // Map "x,y" -> { height, lockedBy, lockMeepleType, lockMeepleColor, contributions: { playerId: count } }
            towers: {},
            // Map playerId (capturant) -> [{ type, ownerId }]
            prisoners: {},
        };

        // ✨ NOUVEAU : cible de capture en attente après pose d'un étage (comme _pendingPrincessTile)
        // Transitoire, turn-scoped, non sérialisé — délibérément PAS dans extraState (voir
        // ARCHITECTURE.md : extraState ne contient que de l'état persistant, pas les _pending*).
        this._pendingTowerCapture = null;

        // ✨ NOUVEAU : échange automatique de prisonniers — vérification différée à la fin du
        // tour du capturant (voir TowerUI.checkPendingReciprocalExchange). Posé immédiatement
        // après une capture non-auto (executeTowerCaptureHost), consommé et remis à null au
        // moment où undoManager.reset() verrouille le tour (la capture n'est alors plus
        // annulable). Également réinitialisé par UndoManager.restoreSnapshot lors d'une
        // annulation — sinon une capture annulée laisserait une vérification fantôme se
        // déclencher en fin de tour. Transitoire, non sérialisé.
        // Forme : { capturingPlayerId, capturedOwnerId, freshlyCapturedType }
        this._pendingReciprocalCheck = null;

        // ✨ NOUVEAU : échange automatique de prisonniers en attente d'un choix du joueur
        // concerné (posé quand la réciprocité laisse plusieurs types de meeples possibles).
        // { chooserId, opponentId, availableTypes, freshlyCapturedType } — transitoire, non
        // sérialisé (comme _pendingTowerCapture/_pendingPrincessTile/_pendingPortalTile).
        this._pendingPrisonerExchange = null;

        // ✨ NOUVEAU : indique si au moins un rachat de prisonnier a eu lieu durant la partie —
        // utilisé par FinalScoresManager pour n'afficher la colonne "Rachats" que si pertinent.
        // Sérialisé (contrairement aux _pending*) car doit survivre à une reconnexion/full-sync.
        this.hasPrisonerBuybacks = false;

        // ✨ NOUVEAU : liste transitoire des captures effectuées durant le tour EN COURS
        // (non sérialisée, comme les autres _pending*). Vidée intégralement à chaque
        // 'turn-changed' (cf. home.js). Sert de garde-fou temporaire : tant que le tour du
        // joueur qui a capturé n'est pas terminé, il pourrait encore annuler son action — le
        // rachat de CETTE capture précise est donc bloqué jusque-là, sans affecter les
        // prisonniers de tours précédents.
        // Forme : [{ holderId, ownerId, type }]
        this._freshCaptures = [];

        // ✅ FIX : une seule rançon (rachat de prisonnier) autorisée par tour de jeu — règle
        // officielle : "Le paiement de rançon pour récupérer un prisonnier ne se fait qu'une
        // fois par tour, même lorsqu'il y a un double tour". Un tour bonus (bâtisseur) compte
        // donc comme la suite du tour précédent : ce flag n'est PAS réinitialisé au passage
        // vers un tour bonus, seulement au passage vers le tour normal suivant (cf. home.js,
        // listener 'turn-changed', qui ne réinitialise que si turnManager.isBonusTurn est
        // false à cet instant). Transitoire, non sérialisé (comme _freshCaptures ci-dessus) :
        // chaque client le recalcule localement via les événements 'turn-changed' déjà
        // synchronisés réseau. Voir aussi TowerUI.setupPrisonerBuyback (vérification UI) et
        // TowerUI.executePrisonerBuybackHost (revalidation côté hôte, seule source de vérité).
        this._turnBuybackUsed = false;
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
        const key = this.fairyState.meepleKey;
        // ✅ FIX : la fée peut désormais être attachée à un garde verrouillant une tour, dont
        // la clé suit le format "tower-lock:x,y" au lieu du format classique "x,y,position".
        // Sans ce cas particulier, le parsing générique ci-dessous produisait NaN pour ce
        // format et retournait silencieusement false : le dragon pouvait alors se déplacer
        // sur une tuile pourtant protégée par la fée (règle de protection contournée).
        if (key.startsWith('tower-lock:')) {
            const [tx, ty] = key.slice('tower-lock:'.length).split(',').map(Number);
            return tx === x && ty === y;
        }
        const parts = key.split(',');
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
            extraState:         this.extraState, // ✨ NOUVEAU : remplace les anciens champs towers/prisoners séparés
            hasPrisonerBuybacks: this.hasPrisonerBuybacks,
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

        // ✨ NOUVEAU : extraState générique — ajouter une nouvelle sous-clé ici (ex: sheep,
        // barns, bridges, fortresses) ne demande AUCUNE autre modification dans ce fichier.
        this.extraState = {
            towers:    data.extraState?.towers    ?? {},
            prisoners: data.extraState?.prisoners ?? {},
        };
        this.hasPrisonerBuybacks = data.hasPrisonerBuybacks ?? false;
    }
}
