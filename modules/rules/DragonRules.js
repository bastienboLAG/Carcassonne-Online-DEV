/**
 * DragonRules — Extension Princesse & Dragon
 *
 * Responsabilités :
 *   - Détecter les zones volcano/dragon sur une tuile posée
 *   - Calculer les tuiles adjacentes valides pour le déplacement du dragon
 *   - Manger les meeples sur la tuile cible
 *   - Gérer la fée (attacher, voler, blocage dragon)
 *   - Gérer la princess (retirer un meeple d'une ville)
 */

import { isDragonEdible, isFairyAttachable } from './DragonConfig.js';

export class DragonRules {
    /**
     * @param {object} params
     * @param {GameState}        params.gameState
     * @param {object}           params.plateau        — map `x,y` → tileData
     * @param {object}           params.placedMeeples  — map `x,y,position` → meeple
     * @param {EventBus}         params.eventBus
     * @param {RuleRegistry}     params.ruleRegistry
     */
    constructor({ gameState, plateau, placedMeeples, eventBus, ruleRegistry }) {
        this.gameState    = gameState;
        this.plateau      = plateau;
        this.placedMeeples = placedMeeples;
        this.eventBus     = eventBus;
        this.ruleRegistry = ruleRegistry;
    }

    // ────────────────────────────────────────────────────────────────────
    // Détection de zones sur une tuile
    // ────────────────────────────────────────────────────────────────────

    /**
     * Indique si une tuile contient une zone de type donné.
     * @param {object} tile
     * @param {string} type  'volcano' | 'dragon' | 'princess' | 'portal'
     */
    tileHasZone(tile, type) {
        return tile?.zones?.some(z => z.type === type) ?? false;
    }

    // ────────────────────────────────────────────────────────────────────
    // Volcano
    // ────────────────────────────────────────────────────────────────────

    /**
     * Appelé quand une tuile volcano est posée (ou en fin de tour si migration).
     * Place/migre le dragon sur cette tuile.
     * Ne déclenche PAS la phase dragon.
     */
    onVolcanoPlaced(x, y) {
        console.log(`🌋 [Dragon] Volcano posé en (${x},${y}) — dragon migre`);
        this.gameState.placeOrMoveDragon(x, y);
        this.eventBus.emit('dragon-moved', { x, y, phase: 'volcano' });
    }

    // ────────────────────────────────────────────────────────────────────
    // Dragon — déclenchement
    // ────────────────────────────────────────────────────────────────────

    /**
     * Appelé quand une tuile dragon est posée.
     * Démarre la phase dragon si le dragon est sur le plateau.
     * @param {number} triggeringPlayerIndex
     * @returns {boolean} true si la phase a démarré
     */
    onDragonTilePlaced(triggeringPlayerIndex) {
        if (!this.gameState.dragonPos) {
            console.warn('[Dragon] Tuile dragon posée mais dragon pas encore sur le plateau — ignoré');
            return false;
        }

        // Vérifier s'il existe au moins un mouvement possible avant de démarrer la phase
        // (le dragon est bloqué de toutes parts ou le plateau est trop petit)
        this.gameState.startDragonPhase(triggeringPlayerIndex);
        const validMoves = this.getValidDragonMoves();
        if (validMoves.length === 0) {
            console.warn('[Dragon] Aucun déplacement possible — phase dragon annulée');
            this.gameState.endDragonPhase();
            this.eventBus.emit('dragon-phase-ended', { reason: 'no-moves-at-start' });
            return false;
        }

        console.log(`🐉 [Dragon] Phase dragon démarrée par joueur index ${triggeringPlayerIndex}`);
        this.eventBus.emit('dragon-phase-started', {
            pos: this.gameState.dragonPos,
            moverIndex: this.gameState.dragonPhase.moverIndex,
        });
        return true;
    }

    // ────────────────────────────────────────────────────────────────────
    // Dragon — déplacement
    // ────────────────────────────────────────────────────────────────────

    /**
     * Calcule les tuiles adjacentes valides pour le déplacement du dragon.
     * Une tuile est valide si :
     *   - elle existe sur le plateau
     *   - elle n'a pas encore été visitée ce cycle
     *   - elle ne contient pas la fée
     * @returns {Array<{x,y}>}
     */
    getValidDragonMoves() {
        const { x, y } = this.gameState.dragonPos;
        const candidates = [
            { x: x,     y: y - 1 }, // nord
            { x: x + 1, y: y     }, // est
            { x: x,     y: y + 1 }, // sud
            { x: x - 1, y: y     }, // ouest
        ];

        return candidates.filter(({ x: cx, y: cy }) => {
            const key = `${cx},${cy}`;
            if (!this.plateau[key]) return false;                        // tuile inexistante
            if (this.gameState.isDragonVisited(cx, cy)) return false;   // déjà visitée
            if (this.gameState.isFairyOnTile(cx, cy)) return false;     // fée présente
            return true;
        });
    }

    /**
     * Exécute un déplacement du dragon vers (x,y).
     * Mange les meeples présents, met à jour l'état.
     * NE termine PAS la phase quand movesRemaining atteint 0 — c'est le bouton
     * "Terminer mon tour" qui s'en charge, pour permettre l'annulation.
     * Termine la phase uniquement si le dragon est physiquement bloqué (0 mouvements valides).
     * @param {number} x
     * @param {number} y
     * @returns {{ eaten: Array<{key, meeple}>, blocked: boolean }}
     */
    executeDragonMove(x, y) {
        const eaten = this._eatMeeplesAt(x, y);
        this.gameState.moveDragon(x, y);

        const validMoves = this.getValidDragonMoves();
        const blockedAfterMove = validMoves.length === 0 && this.gameState.dragonPhase.movesRemaining > 0;
        const exhausted = this.gameState.dragonPhase.movesRemaining <= 0;

        this.eventBus.emit('dragon-moved', {
            x, y,
            phase: 'move',
            eaten,
            movesRemaining: this.gameState.dragonPhase.movesRemaining,
            moverIndex:     this.gameState.dragonPhase.moverIndex,
        });

        // Plus aucune fin automatique — c'est toujours le joueur qui clique "Terminer mon tour",
        // que le dragon soit bloqué, épuisé, ou simplement en attente.

        return { eaten, blocked: blockedAfterMove, exhausted };
    }

    /**
     * Mange tous les meeples éligibles sur la tuile (x,y).
     * Si la fée est sur ce meeple, elle est retirée aussi.
     * @returns {Array<{key, meeple}>}
     */
    _eatMeeplesAt(x, y) {
        const eaten = [];
        const keysToDelete = [];

        for (const [key, meeple] of Object.entries(this.placedMeeples)) {
            const parts = key.split(',');
            const mx = Number(parts[0]);
            const my = Number(parts[1]);
            if (mx !== x || my !== y) continue;
            if (!isDragonEdible(meeple.type)) continue;

            eaten.push({ key, meeple });
            keysToDelete.push(key);

            // Rendre le meeple au joueur
            const player = this.gameState.players.find(p => p.id === meeple.playerId);
            if (player) {
                this._returnMeeple(player, meeple.type);
            }

            // Si la fée était attachée à ce meeple, la retirer
            if (this.gameState.fairyState.meepleKey === key) {
                console.log(`🧚 [Fée] Meeple mangé — fée retirée`);
                this.gameState.removeFairy();
                this.eventBus.emit('fairy-removed', { reason: 'dragon-ate-meeple' });
            }
        }

        keysToDelete.forEach(k => delete this.placedMeeples[k]);

        // ✅ FIX : garde verrouillant une tour sur cette tuile — vit dans
        // gameState.extraState.towers (cf. TowerRules.lockTower / TowerUI.applyLockExecuted),
        // pas dans placedMeeples, donc invisible pour la boucle ci-dessus. Le dragon doit
        // pouvoir le manger comme n'importe quel meeple normal/grand meeple. Traité
        // séparément avec la même clé spéciale "tower-lock:x,y" qu'utilise déjà
        // TowerRules.getCaptureTargets pour ce cas (capture Tour classique) — DragonUI
        // reconnaît ce préfixe pour retirer le bon élément visuel (.tower-lock-meeple
        // au lieu de .meeple[data-key]).
        const towerKey = `${x},${y}`;
        const tower = this.gameState.extraState?.towers?.[towerKey];
        if (tower?.lockedBy && isDragonEdible(tower.lockMeepleType)) {
            const lockMeeple = { type: tower.lockMeepleType, color: tower.lockMeepleColor, playerId: tower.lockedBy };
            eaten.push({ key: `tower-lock:${towerKey}`, meeple: lockMeeple });

            const lockPlayer = this.gameState.players.find(p => p.id === tower.lockedBy);
            if (lockPlayer) this._returnMeeple(lockPlayer, tower.lockMeepleType);

            // ✅ FIX : la fée peut désormais être attachée à un garde verrouillant une tour
            // (cf. getFairyTargets ci-dessous) — si c'est le cas, la retirer comme pour un
            // meeple classique mangé par le dragon (même logique que dans la boucle ci-dessus).
            // Auparavant ce cas n'était volontairement pas traité, aucun chemin UI n'attachant
            // encore la fée à un garde de tour.
            const towerLockKey = `tower-lock:${towerKey}`;
            if (this.gameState.fairyState.meepleKey === towerLockKey) {
                console.log(`🧚 [Fée] Garde de tour mangé — fée retirée`);
                this.gameState.removeFairy();
                this.eventBus.emit('fairy-removed', { reason: 'dragon-ate-meeple' });
            }

            tower.lockedBy        = null;
            tower.lockMeepleType  = null;
            tower.lockMeepleColor = null;
        }

        return eaten;
    }

    /**
     * Rend un meeple à son joueur selon le type.
     */
    _returnMeeple(player, type) {
        switch (type) {
            case 'Abbot':        player.hasAbbot       = true; break;
            case 'Large':
            case 'Large-Farmer': player.hasLargeMeeple = true; break;
            case 'Builder':      player.hasBuilder     = true; break;
            case 'Pig':          player.hasPig         = true; break;
            default:             if (player.meeples < 7) player.meeples++; break;
        }
    }

    _endDragonPhase(reason) {
        console.log(`🐉 [Dragon] Fin de phase — raison: ${reason}`);
        this.gameState.endDragonPhase();
        this.eventBus.emit('dragon-phase-ended', { reason });
    }

    // ────────────────────────────────────────────────────────────────────
    // Fée
    // ────────────────────────────────────────────────────────────────────

    /**
     * Calcule les meeples sur lesquels le joueur peut poser/voler la fée.
     * ✅ FIX : inclut désormais un éventuel garde du joueur verrouillant une tour
     * (gameState.extraState.towers), en plus des meeples classiques de placedMeeples —
     * auparavant totalement absent de ce calcul, la fée ne pouvait jamais y être attachée.
     * @param {string} playerId
     * @returns {Array<{key, meeple}>}
     */
    getFairyTargets(playerId) {
        const targets = Object.entries(this.placedMeeples)
            .filter(([, m]) => m.playerId === playerId && isFairyAttachable(m.type))
            .map(([key, meeple]) => ({ key, meeple }));

        // ✅ FIX : garde verrouillant une tour — clé spéciale "tower-lock:x,y" (même
        // convention que TowerRules.getCaptureTargets), résolu depuis extraState.towers.
        Object.entries(this.gameState.extraState?.towers ?? {}).forEach(([coords, tower]) => {
            if (tower.lockedBy === playerId && isFairyAttachable(tower.lockMeepleType)) {
                targets.push({
                    key: `tower-lock:${coords}`,
                    meeple: { type: tower.lockMeepleType, color: tower.lockMeepleColor, playerId: tower.lockedBy }
                });
            }
        });

        return targets;
    }

    /**
     * Pose ou vole la fée.
     * @param {string} playerId
     * @param {string} meepleKey
     */
    placeFairy(playerId, meepleKey) {
        const prev = this.gameState.fairyState.ownerId;
        this.gameState.placeFairy(playerId, meepleKey);

        // Mettre à jour hasFairy sur les joueurs
        this.gameState.players.forEach(p => { p.hasFairy = false; });
        const owner = this.gameState.players.find(p => p.id === playerId);
        if (owner) owner.hasFairy = true;

        this.eventBus.emit('fairy-placed', { playerId, meepleKey, stolenFrom: prev });
        console.log(`🧚 [Fée] Posée sur ${meepleKey} par joueur ${playerId}${prev && prev !== playerId ? ` (volée à ${prev})` : ''}`);
    }

    // ────────────────────────────────────────────────────────────────────
    // Princess
    // ────────────────────────────────────────────────────────────────────

    /**
     * Quand une tuile princess est posée sur une ville,
     * le joueur actif PEUT retirer un meeple ennemi de cette ville.
     * Retourne les clés de meeples éligibles dans toute la zone city fusionnée.
     * @param {number} x
     * @param {number} y
     * @param {object} tile
     * @param {string} currentPlayerId
     * @param {object} [zoneMerger] — ZoneMerger pour trouver toute la zone fusionnée
     * @returns {Array<string>} clés de meeples éjectables
     */
    getPrincessTargets(x, y, tile, currentPlayerId, zoneMerger = null) {
        const targets = new Set();
        const princessZones = tile.zones
            .map((z, idx) => ({ zone: z, idx }))
            .filter(({ zone }) => zone.type === 'city' && zone.features?.includes?.('princess'));
        console.log(`👸 [getPrincessTargets] x:${x} y:${y} princessZones:${princessZones.length} zoneMerger:${!!zoneMerger} placedMeeples:`, Object.keys(this.placedMeeples));

        for (const { zone, idx } of princessZones) {
            if (zoneMerger) {
                // Utiliser l'index de zone directement — évite le problème de rotation dans findMergedZoneForPosition
                const key = `${x},${y},${idx}`;
                const zoneId = zoneMerger.tileToZone?.get(key);
                console.log(`👸 [getPrincessTargets] tileToZone key:${key} zoneId:${zoneId}`);
                if (zoneId == null) continue;
                const mergedZone = zoneMerger.registry.getZone(zoneId);
                if (!mergedZone) continue;

                for (const [mKey, meeple] of Object.entries(this.placedMeeples)) {
                    if (meeple.type === 'Builder' || meeple.type === 'Pig') continue;
                    const parts = mKey.split(',');
                    const mx = Number(parts[0]), my = Number(parts[1]), mp = Number(parts[2]);
                    const meepleZone = zoneMerger.findMergedZoneForPosition(mx, my, mp);
                    console.log(`👸 [getPrincessTargets] meeple key:${mKey} meepleZone:${meepleZone?.id} mergedZone:${mergedZone.id} match:${meepleZone?.id === mergedZone.id}`);
                    if (meepleZone?.id === mergedZone.id) targets.add(mKey);
                }
            } else {
                for (const [mKey, meeple] of Object.entries(this.placedMeeples)) {
                    if (meeple.type === 'Builder' || meeple.type === 'Pig') continue;
                    const parts = mKey.split(',');
                    if (Number(parts[0]) !== x || Number(parts[1]) !== y) continue;
                    targets.add(mKey);
                }
            }
        }

        return [...targets];
    }

    /**
     * Exécute l'éjection princess d'un meeple.
     * @param {string} meepleKey
     */
    executePrincess(meepleKey) {
        const meeple = this.placedMeeples[meepleKey];
        if (!meeple) return;

        const player = this.gameState.players.find(p => p.id === meeple.playerId);
        if (player) this._returnMeeple(player, meeple.type);

        delete this.placedMeeples[meepleKey];
        this.eventBus.emit('princess-ejected', { meepleKey, meeple });
        console.log(`👸 [Princess] Meeple éjecté : ${meepleKey}`);
    }

    /**
     * Retourne toutes les positions valides pour le portail magique :
     * zones ouvertes (non fermées) et non revendiquées (aucun meeple dedans).
     * Exclut les zones spéciales (dragon, volcano, portal).
     * @param {Object} zoneMerger
     * @param {Object} board - plateau.placedTiles
     * @returns {Array} [{ x, y, zoneIndex, position, zoneType, zoneId }]
     */
    getPortalTargets(zoneMerger, board) {
        const EXCLUDED_TYPES = new Set(['dragon', 'volcano', 'portal']);
        const targets = [];

        if (!zoneMerger) return targets;

        // Vérifier les meeples disponibles du joueur actuel
        const currentPlayer = this.gameState.getCurrentPlayer();
        if (!currentPlayer) return targets;
        const hasMeeple = currentPlayer.meeples > 0;
        const hasAbbot  = currentPlayer.hasAbbot === true;

        // Position actuelle du dragon (tuile interdite au portail)
        const dragonKey = this.gameState.dragonPos
            ? `${this.gameState.dragonPos.x},${this.gameState.dragonPos.y}`
            : null;

        // Pour chaque entrée de tileToZone, trouver les zones valides
        for (const [key, zoneId] of zoneMerger.tileToZone.entries()) {
            const zone = zoneMerger.registry.getZone(zoneId);
            if (!zone) continue;
            if (zone.isComplete) continue;
            if (EXCLUDED_TYPES.has(zone.type)) continue;

            // Récupérer la position visuelle de cette zone sur cette tuile
            const parts = key.split(',');
            const tx = Number(parts[0]), ty = Number(parts[1]), ti = Number(parts[2]);

            // Exclure la tuile sur laquelle se trouve le dragon
            if (dragonKey && `${tx},${ty}` === dragonKey) continue;

            // Vérifier qu'aucun meeple n'est déjà dans cette zone
            const zoneOccupied = Object.entries(this.placedMeeples).some(([mKey]) => {
                const [mx, my, mp] = mKey.split(',').map(Number);
                const mZoneId = zoneMerger.findMergedZoneForPosition(mx, my, mp)?.id;
                return mZoneId === zoneId;
            });
            if (zoneOccupied) continue;

            const tile = board[`${tx},${ty}`];
            if (!tile) continue;
            const tileZone = tile.zones[ti];
            if (!tileZone || tileZone.meeplePosition == null) continue;

            // Calculer la position rotée
            const rawPos = Array.isArray(tileZone.meeplePosition)
                ? tileZone.meeplePosition[0]
                : tileZone.meeplePosition;
            const rotatedPos = zoneMerger._rotatePosition(rawPos, tile.rotation);

            // Filtrer selon le type de zone et les meeples disponibles :
            // - jardin → abbé uniquement
            // - abbaye → meeple normal OU abbé
            // - ville/route/champs → meeple normal uniquement
            if (zone.type === 'garden') {
                if (!hasAbbot) continue;
            } else if (zone.type === 'abbey') {
                if (!hasMeeple && !hasAbbot) continue;
            } else {
                if (!hasMeeple) continue;
            }

            targets.push({ x: tx, y: ty, zoneIndex: ti, position: rotatedPos, zoneType: zone.type, zoneId });
        }

        return targets;
    }
}
