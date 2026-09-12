/**
 * MeepleConfig - Dimensions naturelles et scales par contexte d'affichage
 *
 * Contextes :
 *   plate       — sur le plateau de jeu
 *   panel       — player-info desktop
 *   panelMobile — player-info mobile
 *   selector    — sélecteur de meeple
 *
 * Pour ajouter un nouveau type : renseigner w, h et les 4 scales.
 */
export const MEEPLE_CONFIG = {
    'Normal': {
        w: 69, h: 70,
        plate:       0.85,
        panel:       0.35,
        panelMobile: 0.28,
        selector:    0.44,
    },
    'Farmer': {
        w: 70, h: 69,
        plate:       0.85,
        panel:       0.35,
        panelMobile: 0.28,
        selector:    0.44,
    },
    'Large': {
        w: 79, h: 80,
        plate:       0.92,
        panel:       0.35,
        panelMobile: 0.28,
        selector:    0.44,
    },
    'Large-Farmer': {
        w: 80, h: 79,
        plate:       0.92,
        panel:       0.35,
        panelMobile: 0.28,
        selector:    0.44,
    },
    'Abbot': {
        w: 62, h: 80,
        plate:       0.87,
        panel:       0.35,
        panelMobile: 0.28,
        selector:    0.44,
    },
    'Builder': {
        w: 60, h: 80,
        plate:       0.87,
        panel:       0.35,
        panelMobile: 0.28,
        selector:    0.44,
    },
    'Pig': {
        w: 117, h: 70,
        plate:       0.60,
        panel:       0.25,
        panelMobile: 0.20,
        selector:    0.35,
    },
    'Spectator': {
        w: 146, h: 166,
        plate:       0.40,
        panel:       0.22,
        panelMobile: 0.18,
        selector:    0.30,
    },

    // ── Pions Extension Princesse & Dragon (pas des meeples joueurs) ────
    // Dragon : image paysage 283x156 — affiché centré sur la tuile
    // scale plate 0.40 → ~113x62px
    'Dragon': {
        w: 283, h: 156,
        plate:       0.60,
        panel:       0.00,
        panelMobile: 0.00,
        selector:    0.20,
    },
    // Fairy : image portrait 71x112 — décalée par rapport au meeple attaché
    // scale plate 0.55 → ~39x62px, taille proche d'un meeple normal
    'Fairy': {
        w: 71, h: 112,
        plate:       0.55,
        panel:       0.00,
        panelMobile: 0.00,
        selector:    0.35,
    },

    // ✨ NOUVEAU — Pion Extension Tour (assets ./assets/Meeples/TowerXX.png)
    // w/h de référence pour Tower01 — la hauteur réelle varie selon le niveau
    // (Tower01..Tower10), donc l'affichage sur le plateau (renderTowerHeight)
    // n'utilise QUE la largeur retournée ici et laisse la hauteur en 'auto'
    // pour préserver le ratio propre à chaque image de niveau.
    // plate 1.00 → 90px (taille précédemment codée en dur sur le plateau)
    // panel 0.18 → ~16px (taille précédemment codée en dur dans ScorePanelUI)
    // selector 0.44 → ~40px (taille précédemment codée en dur dans le sélecteur)
    'Tower': {
        w: 90, h: 90,
        plate:       1.00,
        panel:       0.18,
        panelMobile: 0.14,
        selector:    0.44,
    },
};

/**
 * Retourne les dimensions CSS pour un type et un contexte donnés.
 * @param {string} type    - Type de meeple (ex: 'Normal', 'Large')
 * @param {string} context - Contexte ('plate' | 'panel' | 'panelMobile' | 'selector')
 * @returns {{ width: string, height: string }}
 */
export function getMeepleSize(type, context) {
    const cfg = MEEPLE_CONFIG[type];
    if (!cfg) {
        console.warn(`getMeepleSize: type inconnu "${type}"`);
        return { width: '30px', height: '30px' };
    }
    const scale = cfg[context];
    if (scale === undefined) {
        console.warn(`getMeepleSize: contexte inconnu "${context}" pour "${type}"`);
        return { width: '30px', height: '30px' };
    }
    return {
        width:  `${Math.round(cfg.w * scale)}px`,
        height: `${Math.round(cfg.h * scale)}px`,
    };
}

/**
 * GOODS_CONFIG - Dimensions des icônes de marchandise (cloth, wheat, wine)
 * Les images font environ 64×64px (icônes carrées).
 * Contextes : panel (desktop score panel), panelMobile (mobile score bar)
 */
export const GOODS_CONFIG = {
    size: { w: 64, h: 64 },
    panel:       0.38,   // ~24px
    panelMobile: 0.28,   // ~18px
};

/**
 * Retourne les dimensions CSS pour une icône de marchandise selon le contexte.
 * @param {string} context - 'panel' | 'panelMobile'
 * @returns {{ width: string, height: string }}
 */
export function getGoodsSize(context) {
    const scale = GOODS_CONFIG[context] ?? GOODS_CONFIG.panel;
    const px = Math.round(GOODS_CONFIG.size.w * scale);
    return { width: `${px}px`, height: `${px}px` };
}
