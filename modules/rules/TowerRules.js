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
        this._collectLockedMeepleOnTile(x, y, targets); // ✨ NOUVEAU : garde verrouillé sur cette tuile

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
                this._collectLockedMeepleOnTile(nx, ny, targets); // ✨ NOUVEAU : garde verrouillé sur une tuile de la ligne
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
     * ✨ NOUVEAU : ajoute à `targets` le meeple verrouillant la tour (x,y), s'il existe et est capturable.
     * Un meeple qui verrouille une tour n'est PAS stocké dans placedMeeples (voir TowerRules.lockTower /
     * TowerUI.applyLockExecuted) — il vit uniquement dans gameState.towers[x,y]. On lui attribue donc
     * une clé spéciale "tower-lock:x,y" (jamais en collision avec une clé meeple classique "x,y,position")
     * pour que TowerUI puisse le distinguer lors de l'exécution de la capture.
     * @private
     */
    _collectLockedMeepleOnTile(x, y, targets) {
        const tower = this.gameState.towers[`${x},${y}`];
        if (!tower?.lockedBy) return;
        if (!isTowerCapturable(tower.lockMeepleType)) return;
        targets.push({
            key: `tower-lock:${x},${y}`,
            meeple: { type: tower.lockMeepleType, color: tower.lockMeepleColor, playerId: tower.lockedBy }
        });
    }

    /**
     * Valide une demande de capture et retourne les infos nécessaires, sans muter l'état.
     * La mutation réelle (retrait du plateau, ajout aux prisonniers ou retour réserve)
     * est appliquée de façon identique côté hôte et invités par TowerUI.applyCaptureExecuted,
     * pour garantir que gameState.prisoners est cohérent partout (pas seulement chez l'hôte).
     * @returns {{ key, meeple, selfCapture }|null}
     */
    executeCapture(meepleKey, capturingPlayerId, placedMeeples) {
        // ✨ NOUVEAU : capture d'un garde verrouillant une tour — résolu depuis gameState.towers
        if (meepleKey.startsWith('tower-lock:')) {
            const coords = meepleKey.slice('tower-lock:'.length);
            const tower  = this.gameState.towers[coords];
            if (!tower?.lockedBy) return null;
            const meeple = { type: tower.lockMeepleType, color: tower.lockMeepleColor, playerId: tower.lockedBy };
            const selfCapture = meeple.playerId === capturingPlayerId;
            return { key: meepleKey, meeple, selfCapture };
        }

        const meeple = placedMeeples[meepleKey];
        if (!meeple) return null;
        const selfCapture = meeple.playerId === capturingPlayerId;
        return { key: meepleKey, meeple, selfCapture };
    }

    /**
     * Verrouille une tour avec un meeple du joueur (n'importe quel joueur, avec ses propres
     * ressources). Nécessite qu'un étage existe déjà. Consomme la phase meeple.
     * @returns {boolean} true si le verrouillage a réussi
     */
    lockTower(x, y, playerId, meepleType) {
        const key = `${x},${y}`;
        if (this.isLocked(x, y)) return false;
        if ((this.gameState.towers[key]?.height ?? 0) <= 0) return false;

        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player) return false;

        if (meepleType === 'Normal' || meepleType === 'Farmer') {
            if ((player.meeples ?? 0) <= 0) return false;
            player.meeples--;
        } else if (meepleType === 'Large' || meepleType === 'Large-Farmer') {
            if (!player.hasLargeMeeple) return false;
            player.hasLargeMeeple = false;
        } else {
            return false; // type non autorisé au verrouillage
        }

        this.gameState.towers[key].lockedBy         = playerId;
        this.gameState.towers[key].lockMeepleType   = meepleType;
        this.gameState.towers[key].lockMeepleColor  = player.color.charAt(0).toUpperCase() + player.color.slice(1);
        return true;
    }
}
