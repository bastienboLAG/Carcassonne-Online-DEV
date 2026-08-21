import { Tile } from '../Tile.js';

/**
 * SlotsUI - Gère l'affichage des slots de placement
 * CONNECTÉ À EVENTBUS
 *
 * Fix: on maintient un flag interne `this.tileAvailable` pour savoir
 * si une tuile est vraiment en main CE tour-ci.
 * Cela évite que le refresh déclenché par turn-changed affiche des slots
 * alors que le joueur inactif n'a pas de tuile à poser.
 *
 * Fix (tuile dragon prématurée) : `this.isBlocked` permet de forcer les
 * slots en lecture seule (contour gris, non cliquables) même si c'est le
 * tour du joueur, le temps que la modale "tuile implaçable" (dragon sans
 * volcan) soit résolue. Positionné depuis l'extérieur via setBlocked().
 */
export class SlotsUI {
    constructor(plateau, gameSync, eventBus, getTileEnMain) {
        this.plateau       = plateau;
        this.gameSync      = gameSync;
        this.eventBus      = eventBus;
        this.boardElement  = null;
        this.getTileEnMain = getTileEnMain;

        this.isMyTurn        = false;
        this.firstTilePlaced = false;
        this.onSlotClick     = null;
        this.isRiverPhase    = false;

        // ✅ Flag interne : une tuile est-elle disponible pour CE joueur CE tour ?
        // Mis à true par tile-drawn, remis à false par tile-placed.
        this.tileAvailable = false;

        // ✅ Flag interne : les slots doivent-ils être forcés en lecture seule,
        // indépendamment du tour du joueur ? (ex: tuile dragon sans volcan en
        // attente de confirmation via la modale implaçable)
        this.isBlocked = false;

        // Binder pour que off() retrouve la même référence
        this._onTileDrawn   = this.onTileDrawn.bind(this);
        this._onTilePlaced  = this.onTilePlaced.bind(this);
        this._onTurnChanged = this.onTurnChanged.bind(this);
        this._onTileRotated = this.onTileRotated.bind(this);

        this.eventBus.on('tile-drawn',   this._onTileDrawn);
        this.eventBus.on('tile-placed',  this._onTilePlaced);
        this.eventBus.on('turn-changed', this._onTurnChanged);
        this.eventBus.on('tile-rotated', this._onTileRotated);
    }

    init() {
        this.boardElement = document.getElementById('board');
    }

    setSlotClickHandler(callback) {
        this.onSlotClick = callback;
    }

    /**
     * Force (ou lève) le mode lecture seule des slots, indépendamment du tour.
     * Utilisé pour bloquer le placement pendant qu'une tuile dragon posée
     * sans volcan sur le plateau attend confirmation (modale implaçable).
     * Patch immédiatement les slots déjà affichés, et la condition est
     * aussi respectée par toute régénération future (generateSlotsAround /
     * createCentralSlot) tant que le flag reste actif.
     */
    setBlocked(blocked) {
        if (this.isBlocked === blocked) return;
        this.isBlocked = blocked;
        console.log('🚫 SlotsUI.setBlocked —', blocked);

        document.querySelectorAll('.slot').forEach(slot => {
            if (!this.isMyTurn || this.isBlocked) {
                slot.classList.add('slot-readonly');
                slot.style.cursor        = 'default';
                slot.style.pointerEvents = 'none';
            } else {
                slot.classList.remove('slot-readonly');
                slot.style.cursor        = 'pointer';
                slot.style.pointerEvents = 'auto';
            }
        });
    }

    // ─── Handlers événements ─────────────────────────────────────────────────

    onTileDrawn(data) {
        // Une nouvelle tuile est disponible pour ce tour
        this.tileAvailable = true;
        console.log('🎴 SlotsUI.onTileDrawn — tileAvailable = true, firstTilePlaced =', this.firstTilePlaced);
        if (this.firstTilePlaced) {
            this.refresh();
        }
    }

    onTilePlaced(data) {
        // La tuile vient d'être posée : plus rien à afficher
        this.tileAvailable   = false;
        this.firstTilePlaced = true;
        this._clearSlots();
        console.log('📌 SlotsUI.onTilePlaced — slots effacés, tileAvailable = false');
    }

    onTileRotated(data) {
        // On ne rafraîchit que si une tuile est réellement disponible
        if (this.tileAvailable) this.refresh();
    }

    onTurnChanged(data) {
        console.log('🔄 SlotsUI.onTurnChanged — isMyTurn:', data.isMyTurn, 'tileAvailable:', this.tileAvailable);
        this.isMyTurn = data.isMyTurn;

        // Si aucune tuile disponible : on efface les slots et on s'arrête
        if (!this.tileAvailable) {
            this._clearSlots();
            return;
        }

        // Sinon on met à jour le mode (readonly/actif) des slots existants
        document.querySelectorAll('.slot').forEach(slot => {
            if (!this.isMyTurn || this.isBlocked) {
                slot.classList.add('slot-readonly');
                slot.style.cursor        = 'default';
                slot.style.pointerEvents = 'none';
            } else {
                slot.classList.remove('slot-readonly');
                slot.style.cursor        = 'pointer';
                slot.style.pointerEvents = 'auto';
            }
        });

        this.refresh();
    }

    // ─── Rafraîchissement ────────────────────────────────────────────────────

    refresh() {
        if (this.firstTilePlaced && this.tileAvailable) {
            this.refreshAllSlots();
        }
    }

    /**
     * Supprime tous les slots non-centraux
     */
    _clearSlots() {
        document.querySelectorAll('.slot:not(.slot-central)').forEach(s => s.remove());
    }

    createCentralSlot() {
        console.log('🎯 Création du slot central...');
        const slot = document.createElement('div');
        slot.className        = 'slot slot-central';
        slot.style.gridColumn = 50;
        slot.style.gridRow    = 50;

        if (!this.isMyTurn || this.isBlocked) {
            slot.classList.add('slot-readonly');
            slot.style.cursor        = 'default';
            slot.style.pointerEvents = 'none';
        } else {
            slot.onclick = () => {
                if (this.getTileEnMain() && !this.firstTilePlaced && this.onSlotClick) {
                    this.onSlotClick(50, 50, this.getTileEnMain(), true);
                }
            };
        }

        this.boardElement.appendChild(slot);
        console.log('✅ Slot central ajouté au board');
    }

    refreshAllSlots() {
        const tile = this.getTileEnMain();
        console.log('🔄 refreshAllSlots — tile:', tile?.id || 'null', 'tileAvailable:', this.tileAvailable);

        // Supprimer les anciens slots
        this._clearSlots();

        if (!tile || !this.tileAvailable) {
            console.log('  ❌ STOP: pas de tuile disponible');
            return;
        }

        const placedTilesCount = Object.keys(this.plateau.placedTiles).length;
        if (placedTilesCount === 0) {
            console.log('  ❌ STOP: plateau vide');
            return;
        }

        for (let coord in this.plateau.placedTiles) {
            const [x, y] = coord.split(',').map(Number);
            this.generateSlotsAround(x, y, tile);
        }
    }

    generateSlotsAround(x, y, tile) {
        const directions = [{dx:0, dy:-1}, {dx:1, dy:0}, {dx:0, dy:1}, {dx:-1, dy:0}];
        directions.forEach(({ dx, dy }) => {
            const nx = x + dx, ny = y + dy;
            if (!this.plateau.isFree(nx, ny)) return;
            if (!this.plateau.canPlaceTile(nx, ny, tile, this.isRiverPhase)) return;

            const slot = document.createElement('div');
            slot.className        = 'slot';
            slot.style.gridColumn = nx;
            slot.style.gridRow    = ny;

            if (!this.isMyTurn || this.isBlocked) {
                slot.classList.add('slot-readonly');
                slot.style.cursor        = 'default';
                slot.style.pointerEvents = 'none';
            } else {
                slot.onclick = () => {
                    if (this.onSlotClick) this.onSlotClick(nx, ny, this.getTileEnMain());
                };
            }

            this.boardElement.appendChild(slot);
        });
    }

    destroy() {
        console.log('🧹 SlotsUI: cleanup');
        document.querySelectorAll('.slot').forEach(el => el.remove());

        this.eventBus.off('tile-drawn',   this._onTileDrawn);
        this.eventBus.off('tile-placed',  this._onTilePlaced);
        this.eventBus.off('tile-rotated', this._onTileRotated);
        this.eventBus.off('turn-changed', this._onTurnChanged);

        this.onSlotClick = null;
    }
}
