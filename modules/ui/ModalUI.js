// ✨ NOUVEAU : coût de la rançon affiché dans les règles de la partie (source unique : TowerConfig)
import { PRISONER_BUYBACK_COST } from '../rules/TowerConfig.js';

/**
 * ModalUI - Gère l'affichage des modals (tuiles restantes, règles, etc.)
 */
export class ModalUI {
    constructor() {
        this.modalContainer = null;
        this.init();
    }

    /**
     * Initialiser le conteneur de modal
     */
    init() {
        // Créer le conteneur si il n'existe pas
        if (!document.getElementById('modal-overlay')) {
            const overlay = document.createElement('div');
            overlay.id = 'modal-overlay';
            overlay.className = 'modal-overlay';
            overlay.style.cssText = `
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                z-index: 1000;
                justify-content: center;
                align-items: center;
            `;
            
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    this.hide();
                }
            };
            
            document.body.appendChild(overlay);
            this.modalContainer = overlay;
        } else {
            this.modalContainer = document.getElementById('modal-overlay');
        }
    }

    /**
     * Afficher une modal avec les tuiles restantes
     */
    showRemainingTiles(tiles, totalRemaining) {
        const modal = document.createElement('div');
        modal.className = 'modal-content';
        modal.style.cssText = `
            background: #2a2a2a;
            border-radius: 10px;
            padding: 30px;
            max-width: 800px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        `;
        
        // Titre
        const title = document.createElement('h2');
        title.textContent = `🎴 Tuiles restantes : ${totalRemaining}`;
        title.style.cssText = `
            color: white;
            margin: 0 0 20px 0;
            text-align: center;
        `;
        modal.appendChild(this._createStickyCloseBtn());
        modal.appendChild(title);
        
        // Grille de tuiles
        const grid = document.createElement('div');
        grid.style.cssText = `
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        `;
        
        const prefixOrder = ['base', 'river', 'abbot', 'inns_cathedrals', 'traders_builders'];
        const prefixRank = id => {
            const prefix = prefixOrder.findIndex(p => id.startsWith(p));
            return prefix === -1 ? prefixOrder.length : prefix;
        };
        const sortedTiles = [...tiles].sort((a, b) => {
            const rankA = prefixRank(a.id), rankB = prefixRank(b.id);
            if (rankA !== rankB) return rankA - rankB;
            const numA = parseInt(a.id.replace(/[^0-9]/g, '')) || 0;
            const numB = parseInt(b.id.replace(/[^0-9]/g, '')) || 0;
            return numA - numB;
        });

        sortedTiles.forEach(tile => {
            const tileCard = document.createElement('div');
            tileCard.style.cssText = `
                position: relative;
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 8px;
                background: #3a3a3a;
                border-radius: 8px;
                transition: transform 0.2s;
            `;
            
            tileCard.onmouseenter = () => {
                tileCard.style.transform = 'scale(1.05)';
            };
            
            tileCard.onmouseleave = () => {
                tileCard.style.transform = 'scale(1)';
            };
            
            // Image
            const img = document.createElement('img');
            img.src = tile.imagePath;
            img.style.cssText = `
                width: 100px;
                height: 100px;
                object-fit: contain;
                margin-bottom: 5px;
            `;
            tileCard.appendChild(img);
            
            // Badge quantité (en bas à droite)
            const badge = document.createElement('div');
            badge.textContent = tile.count;
            badge.style.cssText = `
                position: absolute;
                bottom: 8px;
                right: 8px;
                background: linear-gradient(135deg, #d4af37, #f4d03f);
                color: #1a1a1a;
                width: 28px;
                height: 28px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                font-size: 14px;
                box-shadow: 0 2px 8px rgba(212, 175, 55, 0.4);
            `;
            tileCard.appendChild(badge);
            
            grid.appendChild(tileCard);
        });
        
        modal.appendChild(grid);
        
        this.show(modal);
    }

    /**
     * Afficher les règles de la partie
     */
    showGameRules(config) {
        const modal = document.createElement('div');
        modal.className = 'modal-content';
        modal.style.cssText = `
            background: #2a2a2a;
            border-radius: 10px;
            padding: 30px;
            max-width: 600px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        `;
        
        // Titre
        const title = document.createElement('h2');
        title.textContent = '📜 Règles de cette partie';
        title.style.cssText = `
            color: white;
            margin: 0 0 25px 0;
            text-align: center;
            border-bottom: 2px solid #444;
            padding-bottom: 15px;
        `;
        modal.appendChild(this._createStickyCloseBtn());
        modal.appendChild(title);
        
        // Contenu
        const content = document.createElement('div');
        content.style.cssText = `
            color: #e0e0e0;
            line-height: 1.8;
        `;
        
        // Section Départ
        const startLabel = config.startType === 'river' ? 'Rivière 1' : 'Tuile unique';
        const startSection = this._createSection('🏁 Départ', [startLabel]);
        content.appendChild(startSection);
        
        // Section Options
        const optionsList = [];
        if (config.showRemainingTiles) {
            optionsList.push('✓ Lister les tuiles restantes');
        }
        if (config.testDeck) {
            optionsList.push('⚠️ Deck de test (15 tuiles)');
        }
        
        // Option tuile implaçable
        if (config.unplaceableAction === 'reshuffle') {
            optionsList.push('✓ Tuile implaçable : remise dans la pioche');
        } else {
            optionsList.push('✓ Tuile implaçable : détruite');
        }

        // Si aucune option, afficher message
        if (optionsList.length === 0) {
            optionsList.push('Aucune option activée');
        }
        
        const optionsSection = this._createSection('⚙️ Options', optionsList);
        content.appendChild(optionsSection);
        
        // Section Extensions
        // ✅ FIX : toutes les extensions et toutes leurs règles sont TOUJOURS affichées, avec ✓ (active)
        // ou ✗ (inactive). Auparavant, Tour et Princesse & Dragon s'affichaient avec un ✓ codé en dur
        // dès que leurs tuiles étaient cochées (même sans aucune règle), alors que les autres extensions
        // disparaissaient : l'extension semblait active à tort. Le ✓/✗ d'une extension ne dépend que de
        // ses RÈGLES (les tuiles sont listées à part, dans la section « Tuiles »).
        // ✨ NOUVEAU : une future extension s'ajoute simplement en déclarant son bloc ci-dessous.
        const ext = config.extensions ?? {};
        const extensionsSection = document.createElement('div');
        extensionsSection.style.cssText = `
            margin-bottom: 20px;
        `;
        
        const extensionsTitle = document.createElement('h3');
        extensionsTitle.textContent = '🎲 Extensions';
        extensionsTitle.style.cssText = `
            color: #f39c12;
            margin: 0 0 10px 0;
            font-size: 18px;
        `;
        extensionsSection.appendChild(extensionsTitle);

        const extensionBlocks = [
            // Base : toujours en jeu (tuiles obligatoires) → ✓ forcé, seule la règle « champs » varie
            { title: 'Base (Carcassonne)', forceActive: true, rules: [
                { label: 'Les champs', active: !!config.playFields },
            ]},
            { title: "L'Abbé", rules: [
                { label: 'Meeple Abbé', active: !!ext.abbot },
            ]},
            { title: 'Auberges & Cathédrales', rules: [
                { label: 'Grand Meeple', active: !!ext.largeMeeple },
                { label: 'Cathédrales',  active: !!ext.cathedrals },
                { label: 'Auberges',     active: !!ext.inns },
            ]},
            { title: 'Marchands & Bâtisseurs', rules: [
                { label: 'Bâtisseur',     active: !!ext.tradersBuilders },
                { label: 'Marchandises',  active: !!ext.merchants },
                { label: 'Meeple Cochon', active: !!ext.pig },
            ]},
            { title: 'Princesse & Dragon', rules: [
                { label: 'Dragon',           active: !!ext.dragon },
                { label: 'Princesse',        active: !!ext.princess },
                { label: 'Portail Magique',  active: !!ext.portal },
                { label: 'Protection Fée',   active: !!ext.fairyProtection },
                { label: 'Fée : +1pt/tour',  active: !!ext.fairyScoreTurn },
                { label: 'Fée : +3pts/zone', active: !!ext.fairyScoreZone },
            ]},
            { title: 'Tour', rules: [
                { label: 'Capture par les tours', active: !!ext.tower },
                { label: `Rançon (${PRISONER_BUYBACK_COST} pts)`, active: !!ext.ransom },
            ]},
        ];
        extensionBlocks.forEach(block => {
            extensionsSection.appendChild(this._createExtensionBlock(block.title, block.rules, block.forceActive ?? null));
        });

        content.appendChild(extensionsSection);

        // Section Tuiles
        const tilesSection = this._createSection('🧩 Tuiles', (() => {
            const list = [];
            if (config.tileGroups?.base !== false) {
                list.push('Base : 72 tuiles');
            }
            if (config.startType === 'river') {
                list.push('Rivière : +12 tuiles');
            }
            if (config.tileGroups?.abbot) {
                list.push("L'Abbé : +8 tuiles");
            }
            if (config.tileGroups?.inns_cathedrals) {
                list.push('Auberges & Cathédrales : +18 tuiles');
            }
            if (config.tileGroups?.traders_builders) {
                list.push('Marchands & Bâtisseurs : +24 tuiles');
            }
            if (config.tileGroups?.dragon) {
                list.push('Princesse & Dragon : +29 tuiles');
            }
            // ✨ NOUVEAU : total des tuiles Tour (cohérent avec le compteur du lobby : +18)
            if (config.tileGroups?.tower) {
                list.push('Tour : +18 tuiles');
            }
            return list;
        })());
        content.appendChild(tilesSection);

        modal.appendChild(content);
        
        this.show(modal);
    }

    /**
     * ✨ NOUVEAU : bloc d'une extension — titre (✓ vert si au moins une règle active, ✗ rouge sinon)
     * suivi de TOUTES ses règles avec leur propre ✓/✗ (inactives en gris).
     * @param {string}  title
     * @param {Array<{label:string, active:boolean}>} rules
     * @param {boolean|null} forceActive — impose l'état du titre (ex. Base), sinon déduit des règles
     */
    _createExtensionBlock(title, rules, forceActive = null) {
        const isActive = forceActive ?? rules.some(r => r.active);

        const container = document.createElement('div');
        container.style.cssText = `
            font-family: 'Courier New', monospace;
            color: #e0e0e0;
            line-height: 1.6;
            margin-top: 8px;
        `;

        container.appendChild(this._createStatusLine(title, isActive, { fontSize: 15, indent: 0 }));
        rules.forEach(rule => {
            container.appendChild(this._createStatusLine(rule.label, rule.active, {
                fontSize: 14,
                indent: 1,
            }));
        });
        return container;
    }

    /**
     * ✨ NOUVEAU : une ligne « └─ ✓/✗ libellé » de l'arborescence des extensions.
     * @param {number} indent — 0 = titre d'extension, 1 = règle
     */
    _createStatusLine(label, active, { fontSize, indent }) {
        const line = document.createElement('div');
        line.style.cssText = `
            margin-left: 5px;
            font-size: ${fontSize}px;
            padding-left: ${indent * 20}px;
            ${indent > 0 && !active ? 'color: #888;' : ''}
            ${indent === 0 && !active ? 'color: #aaa;' : ''}
        `;

        const branch = document.createElement('span');
        branch.textContent = '└─ ';
        line.appendChild(branch);

        const mark = document.createElement('span');
        mark.textContent = active ? '✓' : '✗';
        mark.style.cssText = `color: ${active ? '#2ecc71' : '#e74c3c'}; font-weight: bold;`;
        line.appendChild(mark);

        const text = document.createElement('span');
        text.textContent = ` ${label}`;
        // Règle inactive : italique grisé (même rendu que l'ancien « Les champs (désactivés) »)
        if (indent > 0 && !active) text.style.fontStyle = 'italic';
        else if (indent > 0) text.style.color = '#a8d8a8';
        line.appendChild(text);

        return line;
    }

    /**
     * Créer une croix sticky en haut à droite de la modale
     */
    _createStickyCloseBtn() {
        const btn = document.createElement('button');
        btn.textContent = '✕';
        btn.style.cssText = `
            position: sticky;
            top: 8px;
            float: right;
            z-index: 10;
            background: #e74c3c;
            color: white;
            border: none;
            border-radius: 50%;
            width: 28px;
            height: 28px;
            font-size: 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            line-height: 1;
            flex-shrink: 0;
            transition: background 0.15s;
            margin-bottom: -28px;
        `;
        btn.onmouseover = () => btn.style.background = '#c0392b';
        btn.onmouseout  = () => btn.style.background = '#e74c3c';
        btn.onclick = () => this.hide();
        return btn;
    }

    /**
     * Créer une section de règles
     */
    _createSection(title, items) {
        const section = document.createElement('div');
        section.style.cssText = `
            margin-bottom: 20px;
        `;
        
        const sectionTitle = document.createElement('h3');
        sectionTitle.textContent = title;
        sectionTitle.style.cssText = `
            color: #f39c12;
            margin: 0 0 10px 0;
            font-size: 18px;
        `;
        section.appendChild(sectionTitle);
        
        const list = document.createElement('ul');
        list.style.cssText = `
            margin: 0;
            padding-left: 20px;
            list-style: none;
        `;
        
        items.forEach(item => {
            const li = document.createElement('li');
            li.textContent = item;
            li.style.cssText = `
                margin-bottom: 8px;
                font-size: 15px;
            `;
            list.appendChild(li);
        });
        
        section.appendChild(list);
        return section;
    }

    /**
     * Afficher la modal
     */
    show(content) {
        this.modalContainer.innerHTML = '';
        this.modalContainer.appendChild(content);
        this.modalContainer.style.display = 'flex';
    }

    /**
     * Masquer la modal
     */
    hide() {
        this.modalContainer.style.display = 'none';
        this.modalContainer.innerHTML = '';
    }
}
