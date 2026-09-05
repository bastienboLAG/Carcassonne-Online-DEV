export class Deck {
    constructor() {
        this.tiles = [];
        this.currentIndex = 0;
        this.totalTiles = 0;
    }

    /**
     * Charger les tuiles selon la config
     * config.testDeck       : mode test 15 tuiles Base uniquement
     * config.tileGroups     : { base: true, abbot: false, river: false }
     * config.startType      : 'unique' | 'river'
     */
    async loadAllTiles(testMode = false, tileGroups = {}, startType = 'unique') {
        const riverTiles = [];
        const normalTiles = [];

        // ── Chargement parallèle d'un groupe de tuiles ─────────────────
        const _loadGroup = async (folder, ids) => {
            const results = await Promise.allSettled(
                ids.map(id => fetch(`./data/${folder}/${id}.json`).then(r => r.json()))
            );
            return results
                .filter(r => r.status === 'fulfilled')
                .map(r => r.value);
        };

        // ── Groupe River (chargé en premier si activé) ─────────────────
        if (startType === 'river') {
            const ids = ['01','02','03','04','05','06','07','08','09','10','11','12'];
            riverTiles.push(...await _loadGroup('River', ids));
        }

        // ── Groupe Base ─────────────────────────────────────────────────
        const baseIds = testMode
            ? ['23', '24', '03', '01', '02', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14']
            : Array.from({ length: 24 }, (_, i) => String(i + 1).padStart(2, '0'));
        normalTiles.push(...await _loadGroup('Base', baseIds));

        // ── Groupes optionnels — tous lancés en parallèle ───────────────
        const optionalFetches = [];
        if (tileGroups.abbot)
            optionalFetches.push(_loadGroup('Abbot', ['01','02','03','04','05','06','07','08']));
        if (tileGroups.inns_cathedrals)
            optionalFetches.push(_loadGroup('Inns_Cathedrals', ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18']));
        if (tileGroups.traders_builders)
            optionalFetches.push(_loadGroup('Traders_Builders', ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24']));
        if (tileGroups.dragon)
            optionalFetches.push(_loadGroup('Dragon', ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29']));
        // ✨ NOUVEAU : extension Tour
        if (tileGroups.tower)
            optionalFetches.push(_loadGroup('Tower', ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17']));

        const optionalResults = await Promise.all(optionalFetches);
        optionalResults.forEach(group => normalTiles.push(...group));

        // ── Calcul du total ─────────────────────────────────────────────
        const allTileData = [...riverTiles, ...normalTiles];
        if (testMode) {
            this.totalTiles = allTileData.length;
        } else {
            this.totalTiles = allTileData.reduce((sum, d) => sum + d.quantity, 0);
        }

        // ── Création des tuiles river ────────────────────────────────────
        const riverDeck = [];
        for (const data of riverTiles) {
            riverDeck.push({
                id:        `${data.extension.toLowerCase()}-${data.id}`,
                zones:     data.zones,
                imagePath: data.image
            });
        }

        // ── Création du deck normal ──────────────────────────────────────
        const normalDeck = [];
        for (const data of normalTiles) {
            const quantity = testMode ? 1 : data.quantity;
            const uniqueId = `${data.extension.toLowerCase()}-${data.id}`;
            for (let i = 0; i < quantity; i++) {
                normalDeck.push({
                    id:        uniqueId,
                    zones:     data.zones,
                    imagePath: data.image
                });
            }
        }

        // ── Ordre / mélange ──────────────────────────────────────────────
        if (startType === 'river' && testMode) {
            // River + test : ordre forcé pour reproduire un blocage total
            // 01(source) → 07-06-10-05-02-03-04-08-09-11 → 12(embouchure)
            const riverTestOrder = [
                'river-01','river-07','river-06','river-10','river-05',
                'river-02','river-03','river-04','river-08','river-09',
                'river-11','river-12'
            ];
            const orderedRiver = riverTestOrder.map(id => riverDeck.find(t => t.id === id)).filter(Boolean);
            this._shuffleArray(normalDeck);
            this.tiles = [...orderedRiver, ...normalDeck];
            this.totalTiles = this.tiles.length;
            console.log(`🌊 [TEST] Mode rivière ordre forcé : ${orderedRiver.map(t => t.id).join(' → ')}`);

        } else if (startType === 'river') {
            // River : source fixe, 2-11 shufflées, embouchure fixe
            const source      = riverDeck.find(t => t.id === 'river-01');
            const embouchure  = riverDeck.find(t => t.id === 'river-12');
            const middle      = riverDeck.filter(t => t.id !== 'river-01' && t.id !== 'river-12');
            this._shuffleArray(middle);

            // Deck normal shufflé sans forcer base-04
            this._shuffleArray(normalDeck);

            this.tiles = [source, ...middle, embouchure, ...normalDeck];
            console.log(`🌊 Mode rivière : ${riverDeck.length} tuiles river + ${normalDeck.length} tuiles normales`);

        } else if (testMode) {
            // Mode test : deck personnalisé dans l'ordre défini
            // Charger les tuiles manquantes si besoin (ex: inns sans extension activée)
            if (!tileGroups.inns_cathedrals) {
                try {
                    const res  = await fetch('./data/Inns_Cathedrals/03.json');
                    const data = await res.json();
                    normalDeck.push({ id: 'inns_cathedrals-03', zones: data.zones, imagePath: data.image });
                } catch(e) { console.error('Erreur chargement inns_cathedrals-03:', e); }
            }
            const testIds = ['base-04', 'dragon-22', 'dragon-22', 'dragon-29', 'dragon-18', 'dragon-22'];
            this.tiles = testIds.map(id => {
                const found = normalDeck.find(t => t.id === id);
                return found ? { ...found } : null;
            }).filter(Boolean);
            this.totalTiles = this.tiles.length;
            console.log('🧪 Mode test custom : ' + this.tiles.map(t => t.id).join(', '));

        } else {
            // Tuile unique : shuffle + base-04 en premier
            this._shuffleArray(normalDeck);
            const index04 = normalDeck.findIndex(t => t.id === 'base-04');
            if (index04 !== -1) {
                const tile04 = normalDeck.splice(index04, 1)[0];
                normalDeck.unshift(tile04);
            }
            this.tiles = normalDeck;
        }

        console.log(`📦 Deck chargé: ${this.tiles.length} tuiles (total: ${this.totalTiles})`);
    }

    /**
     * Vérifie si une tuile contient une zone dragon (déclencheur phase dragon).
     * @param {object} tile
     * @returns {boolean}
     */
    _tileHasDragonZone(tile) {
        return tile?.zones?.some(z => z.type === 'dragon') ?? false;
    }

    /**
     * Appelé par l'hôte quand une tuile dragon est piochée sans volcan actif.
     * Remet la tuile dans la pioche à une position aléatoire et la mélange.
     * Pioche la suivante et la retourne (ne contient plus de zone dragon garantie
     * car un seul reshuf suffit — si 2 dragons consécutifs, on reshuf à nouveau
     * jusqu'à tomber sur une tuile non-dragon).
     * @returns {object|null} la prochaine tuile valide, ou null si pioche vide
     */
    reshuffleDragonTile() {
        // La tuile dragon est à currentIndex - 1 (vient d'être piochée)
        const dragonTileIndex = this.currentIndex - 1;
        const dragonTile = this.tiles[dragonTileIndex];

        // Retirer la tuile dragon du deck (on va la réinsérer)
        this.tiles.splice(dragonTileIndex, 1);
        this.currentIndex--;  // on recule car on a retiré avant currentIndex

        // Insérer à une position aléatoire APRÈS currentIndex
        const remaining = this.tiles.length - this.currentIndex;
        if (remaining === 0) {
            // Plus rien derrière, remettre quand même (pioche "vide" dans la pratique)
            this.tiles.push(dragonTile);
        } else {
            const insertAt = this.currentIndex + Math.floor(Math.random() * remaining);
            this.tiles.splice(insertAt, 0, dragonTile);
        }

        console.log(`🐉 [Deck] Tuile dragon remélangée à l'index ${this.currentIndex + Math.floor(Math.random() * remaining)}`);

        // Piocher la prochaine tuile (peut aussi être dragon — l'appelant doit reboucler)
        return this.draw();
    }

    _shuffleArray(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    }

    // Garde pour compatibilité
    shuffle() { this._shuffleArray(this.tiles); }

    draw() {
        if (this.currentIndex >= this.tiles.length) return null;
        return this.tiles[this.currentIndex++];
    }

    remaining() { return this.tiles.length - this.currentIndex; }
    total()     { return this.totalTiles; }

    getRemainingTilesByType() {
        const counts = {};
        for (let i = this.currentIndex; i < this.tiles.length; i++) {
            const tile = this.tiles[i];
            if (!counts[tile.id]) {
                counts[tile.id] = { id: tile.id, imagePath: tile.imagePath, count: 0 };
            }
            counts[tile.id].count++;
        }
        return Object.values(counts).sort((a, b) => b.count - a.count);
    }
}
