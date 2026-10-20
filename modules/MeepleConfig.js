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
 *
 * ✨ NOUVEAU : champ optionnel `plateOpacity` (0 à 1, défaut 1 = opaque) — opacité du pion
 * sur le plateau, lue par getMeepleOpacity(). Utilisé aujourd'hui par le Dragon et par la Tour
 * (la valeur de 'Tower' pilote aussi le garde de verrouillage et son cadenas, cf. TowerUI.js).
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
    // ✨ NOUVEAU : plateOpacity = transparence du dragon sur le plateau (1 = opaque, 0 = invisible).
    //   Baisser cette valeur pour laisser voir les routes/villes/champs situés sous le pion.
    'Dragon': {
        w: 283, h: 156,
        plate:       0.60,
        plateOpacity: 0.75,
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
    // ✨ NOUVEAU : plateOpacity = transparence de la tour sur le plateau (1 = opaque). Cette valeur
    //   s'applique AUSSI au garde qui verrouille la tour et à son cadenas 🔒 (TowerUI.js).
    'Tower': {
        w: 90, h: 90,
        plate:       1.00,
        plateOpacity: 0.75,
        panel:       0.4,
        panelMobile: 0.35,
        selector:    0.44,
    },

    // ✨ NOUVEAU — Meeples spéciaux des futures extensions (panel joueurs + aperçu debug).
    // Assets : ./assets/Meeples/{Couleur}/{Mayor|Wagon|Shepherd|Ringmaster}.png
    // Seules les tailles 'panel' / 'panelMobile' sont utilisées pour l'instant ; 'plate' et
    // 'selector' sont des valeurs provisoires à ajuster quand l'extension sera réellement branchée.
    'Mayor': {
        w: 79, h: 80,
        plate:       0.92,
        panel:       0.35,
        panelMobile: 0.28,
        selector:    0.44,
    },
    'Wagon': {
        w: 119, h: 76,
        plate:       0.70,
        panel:       0.30,
        panelMobile: 0.24,
        selector:    0.38,
    },
    'Shepherd': {
        w: 74, h: 80,
        plate:       0.90,
        panel:       0.35,
        panelMobile: 0.28,
        selector:    0.44,
    },
    'Ringmaster': {
        w: 62, h: 80,
        plate:       0.87,
        panel:       0.35,
        panelMobile: 0.28,
        selector:    0.44,
    },

    // ✨ NOUVEAU — Structures (ligne 2 du panel joueurs)
    // Barn : ./assets/Meeples/{Couleur}/Barn.png (une variante par couleur)
    // Bridge : ./assets/Meeples/Bridge.png (neutre) — très large, échelle volontairement faible
    // Castle (forteresse) : ./assets/Misc/C2/Castle.png (neutre)
    'Barn': {
        w: 102, h: 80,
        plate:       0.80,
        panel:       0.30,
        panelMobile: 0.24,
        selector:    0.40,
    },
    'Bridge': {
        w: 335, h: 200,
        plate:       0.30,
        panel:       0.12,
        panelMobile: 0.10,
        selector:    0.15,
    },
    'Castle': {
        w: 88, h: 77,
        plate:       0.80,
        panel:       0.32,
        panelMobile: 0.26,
        selector:    0.40,
    },

    // ✨ NOUVEAU — Jetons (ligne 3 du panel joueurs), assets ./assets/Misc/C2/
    // Sheep → Sheep1.png ; King → TokenKing.png ; Robber → TokenRobber.png
    'Sheep': {
        w: 65, h: 65,
        plate:       0.60,
        panel:       0.40,
        panelMobile: 0.32,
        selector:    0.50,
    },
    'King': {
        w: 80, h: 80,
        plate:       0.60,
        panel:       0.32,
        panelMobile: 0.26,
        selector:    0.40,
    },
    'Robber': {
        w: 80, h: 80,
        plate:       0.60,
        panel:       0.32,
        panelMobile: 0.26,
        selector:    0.40,
    },

    // ✨ NOUVEAU — Tuile bonus monastère (ligne 4 du panel joueurs, ./assets/Misc/C2/Monastery.jpg)
    // 208×208 = taille d'une tuile du plateau. panel 0.55 → ~114px, panelMobile 0.45 → ~94px.
    'Monastery': {
        w: 208, h: 208,
        plate:       1.00,
        panel:       0.55,
        panelMobile: 0.45,
        selector:    0.30,
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
 * ✨ NOUVEAU : opacité d'un pion sur le plateau (champ `plateOpacity`, 1 = opaque par défaut).
 * @param {string} type - Type de pion (ex: 'Dragon', 'Tower')
 * @returns {number} valeur entre 0 et 1
 */
export function getMeepleOpacity(type) {
    const value = MEEPLE_CONFIG[type]?.plateOpacity;
    if (typeof value !== 'number') return 1;
    return Math.max(0, Math.min(1, value));
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
