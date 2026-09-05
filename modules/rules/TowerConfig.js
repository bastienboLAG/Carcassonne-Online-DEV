/**
 * TowerConfig — Configuration de l'extension Tour
 *
 * TOWER_PIECES_BY_PLAYER_COUNT : nombre de pièces de tour par joueur selon le nombre de joueurs
 * TOWER_CAPTURABLE_MEEPLES     : types de meeples capturables (hors pions spéciaux et structures)
 * TOWER_LOCK_MEEPLES           : types de meeples autorisés à verrouiller une tour (utilisé plus tard)
 */

export const TOWER_PIECES_BY_PLAYER_COUNT = {
    2: 10,
    3: 9,
    4: 7,
    5: 6,
    6: 5,
};

// Meeple normal, grand meeple, abbé — pas de bâtisseur/cochon (spéciaux) ni de structures.
// Maire, Chariot, Directeur de cirque à ajouter ici dès qu'ils seront implémentés dans le jeu.
export const TOWER_CAPTURABLE_MEEPLES = new Set([
    'Normal',
    'Farmer',
    'Large',
    'Large-Farmer',
    'Abbot',
]);

// Réservé pour le verrouillage (non utilisé dans cette passe) :
// meeple normal, grand meeple, directeur de cirque (ce dernier pas encore implémenté).
export const TOWER_LOCK_MEEPLES = new Set([
    'Normal',
    'Farmer',
    'Large',
    'Large-Farmer',
]);

/**
 * Retourne le nombre de pièces de tour attribuées à chaque joueur selon le nombre de joueurs.
 * @param {number} playerCount
 * @returns {number}
 */
export function getTowerPiecesForPlayerCount(playerCount) {
    return TOWER_PIECES_BY_PLAYER_COUNT[playerCount] ?? 5;
}

/**
 * Indique si un type de meeple peut être capturé par une tour.
 * @param {string} type
 * @returns {boolean}
 */
export function isTowerCapturable(type) {
    return TOWER_CAPTURABLE_MEEPLES.has(type);
}
