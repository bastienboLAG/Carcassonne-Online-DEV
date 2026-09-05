/**
 * TowerRules — Extension Tour
 *
 * Responsabilités :
 *   - Détecter les tuiles avec zone tower
 *   - Poser un étage (gratuit en points, consomme une pièce du stock du joueur)
 *   - Calculer la portée de capture (ligne continue dans les 4 directions, distance = hauteur)
 *   - Exécuter une capture (retour réserve si soi-même, sinon prisonnier de l'adversaire)
 *
 * État stocké dans GameState.towers : Map "x,y" -> { height, lockedBy }
 * (lockedBy réservé pour une passe future — toujours null ici)
 */

import { isTowerCapturable } from './TowerConfig.js';

export class TowerRules {
    /**
     * @param {object} params
     * @param {GameState} params.gameState
     * @param {object}    params.plateau — Board (placedTiles)
     */
    constructor({ gameState, plateau }) {
        this.gameState = gameState;
        this.plateau   = plateau;
    }

    /**
     * Indique si une tuile contient une zone de type tower.
     */
    tileHasTowerZone(tile) {
        return tile?.zones?.some(z => z.type === 'tower') ?? false;
    }

    /**
     * Retourne l'index de zone tower d'une tuile, ou -1.
     */
    _towerZoneIndex(tile) {
        return tile?.zones?.findIndex(z => z.type === 'tower') ?? -1;
    }

    /**
     * Hauteur actuelle d'une tour (0 si pas encore commencée).
     */
    getHeight(x, y) {
        return this.gameState.towers[`${x},${y}`]?.height ?? 0;
    }

    /**
     * Indique si une tour est verrouillée.
     */
    isLocked(x, y) {
        return !!this.gameState.towers[`${x},${y}`]?.lockedBy;
    }

    /**
     * Liste toutes les tuiles tower du plateau non verrouillées, avec leur hauteur actuelle.
     * @returns {Array<{x, y, height, zoneIndex}>}
     */
    getEligibleTowerTiles() {
        const result = [];
        for (const [key, tile] of Object.entries(this.plateau.placedTiles)) {
            const zoneIndex = this._towerZoneIndex(tile);
            if (zoneIndex === -1) continue;
            const [x, y] = key.split(',').map(Number);
            if (this.isLocked(x, y)) continue;
            result.push({ x, y, height: this.getHeight(x, y), zoneIndex });
        }
        return result;
    }

    /**
     * Vérifie qu'un joueur peut poser un étage sur cette tour.
     */
    canAddFloor(x, y, playerId) {
        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player || (player.towerPieces ?? 0) <= 0) return false;
        if (this.isLocked(x, y)) return false;
        const tile = this.plateau.placedTiles[`${x},${y}`];
        if (!tile || !this.tileHasTowerZone(tile)) return false;
        return true;
    }

    /**
     * Pose un étage. Décrémente le stock du joueur, incrémente la hauteur.
     * @returns {number} nouvelle hauteur, ou -1 si échec
     */
    addFloor(x, y, playerId) {
        if (!this.canAddFloor(x, y, playerId)) return -1;

        const key = `${x},${y}`;
        if (!this.gameState.towers[key]) {
            this.gameState.towers[key] = { height: 0, lockedBy: null, contributions: {} };
        }
        const tower = this.gameState.towers[key];
        tower.height++;
        tower.contributions[playerId] = (tower.contributions[playerId] ?? 0) + 1;

        const player = this.gameState.players.find(p => p.id === playerId);
        if (player) player.towerPieces = Math.max(0, (player.towerPieces ?? 0) - 1);

        return tower.height;
    }

    /**
     * Calcule les cibles capturables depuis une tour : tuile centrale + les 4 directions,
     * jusqu'à distance = hauteur, en s'arrêtant dès qu'une case est vide (ligne continue requise).
     * @returns {Array<{key, meeple}>}
     */
    getCaptureTargets(x, y, placedMeeples) {
        const height = this.getHeight(x, y);
        const targets = [];

        this._collectMeeplesOnTile(x, y, placedMeeples, targets);

        const directions = [
            { dx: 0, dy: -1 }, // nord
            { dx: 0, dy: 1 },  // sud
            { dx: -1, dy: 0 }, // ouest
            { dx: 1, dy: 0 },  // est
        ];

        directions.forEach(({ dx, dy }) => {
            for (let step = 1; step <= height; step++) {
                const nx = x + dx * step;
                const ny = y + dy * step;
                if (!this.plateau.placedTiles[`${nx},${ny}`]) break; // trou = ligne interrompue
                this._collectMeeplesOnTile(nx, ny, placedMeeples, targets);
            }
        });

        return targets;
    }

    /**
     * Ajoute à `targets` tous les meeples capturables présents sur la tuile (x,y).
     * @private
     */
    _collectMeeplesOnTile(x, y, placedMeeples, targets) {
        Object.entries(placedMeeples).forEach(([key, meeple]) => {
            const [mx, my] = key.split(',').map(Number);
            if (mx !== x || my !== y) return;
            if (!isTowerCapturable(meeple.type)) return;
            targets.push({ key, meeple });
        });
    }

    /**
     * Exécute une capture.
     * - Si le meeple appartient au joueur capturant : retour direct en réserve.
     * - Sinon : retiré du plateau et ajouté aux prisonniers du capturant (gameState.prisoners).
     * @returns {{ key, meeple, selfCapture: boolean }|null}
     */
    executeCapture(meepleKey, capturingPlayerId, placedMeeples) {
        const meeple = placedMeeples[meepleKey];
        if (!meeple) return null;

        const selfCapture = meeple.playerId === capturingPlayerId;

        if (selfCapture) {
            const player = this.gameState.players.find(p => p.id === capturingPlayerId);
            if (player) this._returnMeeple(player, meeple.type);
        } else {
            if (!this.gameState.prisoners[capturingPlayerId]) this.gameState.prisoners[capturingPlayerId] = [];
            this.gameState.prisoners[capturingPlayerId].push({
                type: meeple.type,
                ownerId: meeple.playerId,
            });
        }

        delete placedMeeples[meepleKey];

        // Si la fée était attachée à ce meeple, la retirer (même traitement que le dragon)
        if (this.gameState.fairyState?.meepleKey === meepleKey) {
            this.gameState.removeFairy();
        }

        return { key: meepleKey, meeple, selfCapture };
    }

    /**
     * Rend un meeple à son joueur selon le type (même logique que DragonRules._returnMeeple).
     * @private
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
}
