/**
 * LobbyOptions — Gestion des options du lobby, presets et coches maîtres
 *
 * Dépendances injectées via init() :
 *   getIsHost()    → boolean
 *   getInLobby()   → boolean
 *   multiplayer    → objet multiplayer (pour broadcast options-sync)
 */

const LS_KEY = 'carcassonne_lobby_options';

// Injections
let _getIsHost  = () => false;
let _getInLobby = () => false;
let _multiplayer = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function _id(id)   { return document.getElementById(id); }
function _checked(id, def = false) { return _id(id)?.checked ?? def; }

// ── Disponibilité des options ──────────────────────────────────────────────

function _updatePigAvailability() {
    const fieldsOn = _checked('base-fields', true);
    const pigLabel = _id('ext-pig-label');
    const pigCb    = _id('ext-pig');
    if (!pigLabel || !pigCb) return;
    if (!fieldsOn) {
        pigCb.checked  = false;
        pigCb.disabled = true;
        pigLabel.style.opacity       = '0.4';
        pigLabel.style.pointerEvents = 'none';
    } else {
        pigCb.disabled = false;
        pigLabel.style.opacity       = '';
        pigLabel.style.pointerEvents = '';
    }
    _updateMasterCheckboxSafe('all-traders-builders');
    saveLobbyOptions();
}

function _updateMerchantsAvailability() {
    const tilesOn = _checked('tiles-traders-builders');
    const label   = _id('ext-merchants')?.closest('label');
    const cb      = _id('ext-merchants');
    if (!cb) return;
    if (!tilesOn) {
        cb.checked = false; cb.disabled = true;
        if (label) { label.style.opacity = '0.4'; label.style.pointerEvents = 'none'; }
    } else {
        cb.disabled = false;
        if (label) { label.style.opacity = ''; label.style.pointerEvents = ''; }
    }
    _updateMasterCheckboxSafe('all-traders-builders');
    saveLobbyOptions();
}

function _updateInnsCthdAvailability() {
    const tilesOn = _checked('tiles-inns-cathedrals');
    ['ext-cathedrals', 'ext-inns'].forEach(id => {
        const cb    = _id(id);
        const label = cb?.closest('label');
        if (!cb) return;
        if (!tilesOn) {
            cb.checked = false; cb.disabled = true;
            if (label) { label.style.opacity = '0.4'; label.style.pointerEvents = 'none'; }
        } else {
            cb.disabled = false;
            if (label) { label.style.opacity = ''; label.style.pointerEvents = ''; }
        }
    });
    _updateMasterCheckboxSafe('all-inns-cathedrals');
    saveLobbyOptions();
}

function _updateDragonAvailability() {
    const tilesOn  = _checked('tiles-dragon');
    const dragonOn = tilesOn && _checked('ext-dragon');

    ['ext-dragon', 'ext-princess', 'ext-portal'].forEach(id => {
        const cb = _id(id);
        const label = cb?.closest('label');
        if (!cb) return;
        if (!tilesOn) {
            cb.checked = false; cb.disabled = true;
            if (label) { label.style.opacity = '0.4'; label.style.pointerEvents = 'none'; }
        } else {
            cb.disabled = false;
            if (label) { label.style.opacity = ''; label.style.pointerEvents = ''; }
        }
    });

    const fairyCb = _id('ext-fairy-protection');
    const fairyLabel = fairyCb?.closest('label');
    if (fairyCb) {
        if (!dragonOn) {
            fairyCb.checked = false; fairyCb.disabled = true;
            if (fairyLabel) { fairyLabel.style.opacity = '0.4'; fairyLabel.style.pointerEvents = 'none'; }
        } else {
            fairyCb.disabled = false;
            if (fairyLabel) { fairyLabel.style.opacity = ''; fairyLabel.style.pointerEvents = ''; }
        }
    }

    _updateMasterCheckboxSafe('all-dragon');
    saveLobbyOptions();
}

// ── Coches maîtres ─────────────────────────────────────────────────────────

function _updateAllExtensionsMaster() {
    const subMasters = ['all-base', 'all-abbot', 'all-inns-cathedrals', 'all-traders-builders', 'all-dragon'];
    const master = _id('all-extensions');
    if (!master) return;
    const checked   = subMasters.filter(id => { const el = _id(id); return el && el.checked && !el.indeterminate; }).length;
    const unchecked = subMasters.filter(id => { const el = _id(id); return el && !el.checked && !el.indeterminate; }).length;
    if (checked === subMasters.length) {
        master.checked = true; master.indeterminate = false;
    } else if (unchecked === subMasters.length) {
        master.checked = false; master.indeterminate = false;
    } else {
        master.checked = false; master.indeterminate = true;
    }
}

function _updateMasterCheckboxSafe(masterId) {
    const master   = _id(masterId);
    if (!master) return;
    const children = [...document.querySelectorAll(`input[data-group="${masterId}"]`)]
        .filter(el => !el.disabled);
    if (children.length === 0) return;
    const checkedCount = children.filter(c => c.checked).length;
    if (checkedCount === 0) {
        master.checked = false; master.indeterminate = false;
    } else if (checkedCount === children.length) {
        master.checked = true;  master.indeterminate = false;
    } else {
        master.checked = false; master.indeterminate = true;
    }
}

function _onMasterChange(masterId) {
    const master = _id(masterId);
    if (!master) return;
    const checked = master.checked;

    if (masterId === 'all-extensions') {
        const applyGroup = (groupId) => {
            document.querySelectorAll(`input[data-group="${groupId}"]`)
                .forEach(el => { if (!el.disabled) el.checked = checked; });
        };

        if (checked) {
            // Ordre important : chaque mise à jour de disponibilité débloque
            // les options dépendantes avant qu'on les coche
            applyGroup('all-base');         // coche "Les champs"
            _updatePigAvailability();       // débloque Cochon si champs actif
            applyGroup('all-traders-builders'); // coche Bâtisseur + Cochon (si dispo)
            _updateMerchantsAvailability(); // débloque Marchands si tuiles TB actives
            applyGroup('all-abbot');
            applyGroup('all-inns-cathedrals'); // Cathédrales/Auberges si tuiles actives
            _updateInnsCthdAvailability();
            applyGroup('all-dragon');       // Dragon/Princesse/Portail si tuiles actives
            _updateDragonAvailability();    // débloque Protection Fée si Dragon actif
            applyGroup('all-dragon');       // re-coche Protection Fée si maintenant dispo
        } else {
            // Décocher : pas de dépendances à respecter, on décoche tout directement
            ['all-base', 'all-abbot', 'all-inns-cathedrals', 'all-traders-builders', 'all-dragon']
                .forEach(applyGroup);
            _updatePigAvailability();
            _updateMerchantsAvailability();
            _updateInnsCthdAvailability();
            _updateDragonAvailability();
        }

        ['all-base', 'all-abbot', 'all-inns-cathedrals', 'all-traders-builders', 'all-dragon']
            .forEach(id => _updateMasterCheckboxSafe(id));
        _updateAllExtensionsMaster();
        saveLobbyOptions();
        return;
    }

    if (masterId === 'all-dragon') {
        if (checked) {
            const tilesDragon = _id('tiles-dragon');
            if (tilesDragon && !tilesDragon.disabled) tilesDragon.checked = true;

            const extDragon = _id('ext-dragon');
            if (extDragon && !extDragon.disabled) extDragon.checked = true;

            _updateDragonAvailability();

            document.querySelectorAll(`input[data-group="${masterId}"]`)
                .forEach(c => { if (!c.disabled) c.checked = true; });

            if (tilesDragon && !tilesDragon.disabled) {
                tilesDragon.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } else {
            document.querySelectorAll(`input[data-group="${masterId}"]`)
                .forEach(c => { c.checked = false; });
            _updateDragonAvailability();
        }

        document.querySelectorAll(`input[data-group="${masterId}"]`)
            .forEach(c => c.dispatchEvent(new Event('change', { bubbles: true })));

        saveLobbyOptions();
        return;
    }

    const children = [...document.querySelectorAll(`input[data-group="${masterId}"]`)]
        .filter(el => !el.disabled);
    children.forEach(c => { c.checked = checked; });

    _updatePigAvailability();
    _updateMerchantsAvailability();
    _updateInnsCthdAvailability();
    _updateDragonAvailability();

    const allChildren = [...document.querySelectorAll(`input[data-group="${masterId}"]`)];
    allChildren.forEach(c => c.dispatchEvent(new Event('change', { bubbles: true })));

    _updateAllExtensionsMaster();
    saveLobbyOptions();
}

// ── Presets & LocalStorage ─────────────────────────────────────────────────

const PRESET_MAP = {
    'play_fields':            'base-fields',
    'show_remaining':         'list-remaining',
    'test_deck':              'use-test-deck',
    'debug':                  'enable-debug',
    'abbot_extension':        'ext-abbot',
    'abbot_tiles':            'tiles-abbot',
    'large_meeple':           'ext-large-meeple',
    'cathedrals_extension':   'ext-cathedrals',
    'inns_extension':         'ext-inns',
    'inns_cathedrals_tiles':  'tiles-inns-cathedrals',
    'traders_builders_tiles': 'tiles-traders-builders',
    'ext_builder':            'ext-builder',
    'ext_merchants':          'ext-merchants',
    'ext_pig':                'ext-pig',
    'tiles_dragon':           'tiles-dragon',
    'ext_dragon':             'ext-dragon',
    'ext_princess':           'ext-princess',
    'ext_portal':             'ext-portal',
    'ext_fairy_protection':   'ext-fairy-protection',
    'ext_fairy_score_turn':   'ext-fairy-score-turn',
    'ext_fairy_score_zone':   'ext-fairy-score-zone',
};

export function applyPreset(preset) {
    const startRadio = document.querySelector(`input[name="start"][value="${preset.start ?? 'unique'}"]`);
    if (startRadio) startRadio.checked = true;

    for (const [key, id] of Object.entries(PRESET_MAP)) {
        if (preset[key] !== undefined) {
            const el = _id(id);
            if (el) el.checked = preset[key];
        }
    }

    if (preset.unplaceable !== undefined) {
        const radio = document.querySelector(`input[name="unplaceable"][value="${preset.unplaceable}"]`);
        if (radio) radio.checked = true;
    }

    document.querySelectorAll('.ext-master').forEach(m => { if (m.id) _updateMasterCheckboxSafe(m.id); });

    _updatePigAvailability();
    _updateInnsCthdAvailability();
    _updateDragonAvailability();

    // ✅ FIX : recalculer la coche maître globale "all-extensions" après application
    // d'un preset — elle dépend des 5 sous-coches maîtres, pas d'un data-group direct,
    // donc _updateMasterCheckboxSafe('all-extensions') ci-dessus est un no-op silencieux.
    _updateAllExtensionsMaster();

    saveLobbyOptions();
}

export function saveLobbyOptions() {
    const state = {
        start:                    document.querySelector('input[name="start"]:checked')?.value ?? 'unique',
        play_fields:              _checked('base-fields', true),
        show_remaining:           _checked('list-remaining', true),
        test_deck:                _checked('use-test-deck'),
        debug:                    _checked('enable-debug'),
        abbot_extension:          _checked('ext-abbot'),
        abbot_tiles:              _checked('tiles-abbot'),
        large_meeple:             _checked('ext-large-meeple'),
        cathedrals_extension:     _checked('ext-cathedrals', true),
        inns_extension:           _checked('ext-inns', true),
        inns_cathedrals_tiles:    _checked('tiles-inns-cathedrals'),
        traders_builders_tiles:   _checked('tiles-traders-builders'),
        ext_builder:              _checked('ext-builder'),
        ext_merchants:            _checked('ext-merchants'),
        ext_pig:                  _checked('ext-pig'),
        tiles_dragon:             _checked('tiles-dragon'),
        ext_dragon:               _checked('ext-dragon'),
        ext_princess:             _checked('ext-princess'),
        ext_portal:               _checked('ext-portal'),
        ext_fairy_protection:     _checked('ext-fairy-protection'),
        ext_fairy_score_turn:     _checked('ext-fairy-score-turn'),
        ext_fairy_score_zone:     _checked('ext-fairy-score-zone'),
        unplaceable:              document.querySelector('input[name="unplaceable"]:checked')?.value ?? 'reshuffle',
    };
    localStorage.setItem(LS_KEY, JSON.stringify(state));
}

export function syncAllOptions() {
    const options = {
        'base-fields':           _checked('base-fields', true),
        'list-remaining':        _checked('list-remaining', true),
        'use-test-deck':         _checked('use-test-deck'),
        'enable-debug':          _checked('enable-debug'),
        'ext-abbot':             _checked('ext-abbot'),
        'tiles-abbot':           _checked('tiles-abbot'),
        'ext-large-meeple':      _checked('ext-large-meeple'),
        'ext-cathedrals':        _checked('ext-cathedrals', true),
        'ext-inns':              _checked('ext-inns', true),
        'tiles-inns-cathedrals': _checked('tiles-inns-cathedrals'),
        'tiles-traders-builders':_checked('tiles-traders-builders'),
        'ext-builder':           _checked('ext-builder'),
        'ext-merchants':         _checked('ext-merchants'),
        'ext-pig':               _checked('ext-pig'),
        'tiles-dragon':          _checked('tiles-dragon'),
        'ext-dragon':            _checked('ext-dragon'),
        'ext-princess':          _checked('ext-princess'),
        'ext-portal':            _checked('ext-portal'),
        'ext-fairy-protection':  _checked('ext-fairy-protection'),
        'ext-fairy-score-turn':  _checked('ext-fairy-score-turn'),
        'ext-fairy-score-zone':  _checked('ext-fairy-score-zone'),
        'unplaceable':           document.querySelector('input[name="unplaceable"]:checked')?.value ?? 'reshuffle',
        'start':                 document.querySelector('input[name="start"]:checked')?.value ?? 'unique',
    };
    _multiplayer.broadcast({ type: 'options-sync', options });
}

// ── UI Lobby ───────────────────────────────────────────────────────────────

export function updateOptionsAccess() {
    const startButton = _id('start-game-btn');
    const restricted  = _getInLobby() && !_getIsHost();

    // Bloquer les interactions sans toucher .disabled (pour ne pas écraser les états de dépendance)
    document.querySelectorAll('.home-right input').forEach(el => {
        el.style.pointerEvents = restricted ? 'none' : '';
    });
    document.querySelectorAll('.home-right label').forEach(el => {
        el.style.pointerEvents = restricted ? 'none' : '';
        el.style.opacity       = restricted ? '0.7' : '';
    });

    if (startButton) {
        startButton.style.pointerEvents = restricted ? 'none' : 'auto';
        startButton.style.opacity       = restricted ? '0.5' : '1';
        startButton.textContent         = restricted ? "En attente de l'hôte..." : 'Démarrer la partie';
    }
}

export function updateColorPickerVisibility() {
    document.querySelector('.color-picker').style.display = _getInLobby() ? 'block' : 'none';
}

export function updateLobbyUI(createBtn, joinBtn) {
    const inLobby = _getInLobby();
    if (createBtn) createBtn.style.display = inLobby ? 'none' : 'block';
    if (joinBtn)   joinBtn.style.display   = inLobby ? 'none' : 'block';
    updateColorPickerVisibility();
    updateOptionsAccess();
    if (window.updatePresetButtons) window.updatePresetButtons();
}

// ── Chargement presets ────────────────────────────────────────────────────

export async function loadPresets() {
    const container = _id('presets-buttons');
    if (!container) return;

    const presets = [];
    let i = 1;
    while (true) {
        const id = String(i).padStart(2, '0');
        try {
            const res = await fetch(`./data/Presets/${id}.json`);
            if (!res.ok) break;
            const data = await res.json();
            presets.push(data);
            i++;
        } catch (e) {
            break;
        }
    }

    presets.forEach(preset => {
        const btn = document.createElement('button');
        btn.className = 'preset-btn';
        btn.textContent = preset.name ?? `Préset ${i}`;
        btn.addEventListener('click', () => {
            if (!_getIsHost() && _getInLobby()) return;
            applyPreset(preset);
            container.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (_getIsHost() && _getInLobby()) syncAllOptions();
        });
        container.appendChild(btn);
    });

    window.updatePresetButtons = () => {
        container.querySelectorAll('.preset-btn').forEach(btn => {
            btn.disabled = _getInLobby() && !_getIsHost();
            btn.style.opacity = (_getInLobby() && !_getIsHost()) ? '0.4' : '1';
            btn.style.cursor  = (_getInLobby() && !_getIsHost()) ? 'not-allowed' : 'pointer';
        });
    };

    if (presets.length === 0) {
        container.closest('.config-section').style.display = 'none';
    }
}

function loadLobbyOptions() {
    try {
        const saved = localStorage.getItem(LS_KEY);
        if (saved) applyPreset(JSON.parse(saved));
    } catch (e) {
        console.warn('⚠️ Impossible de restaurer les options:', e);
    }
    document.querySelectorAll('.ext-master').forEach(master => {
        if (master.id) _updateMasterCheckboxSafe(master.id);
    });
    // ✅ FIX BUG : "all-extensions" n'a pas de data-group, donc
    // _updateMasterCheckboxSafe('all-extensions') ci-dessus ne fait rien
    // (aucun input[data-group="all-extensions"] n'existe dans le HTML).
    // Il faut appeler explicitement _updateAllExtensionsMaster(), qui
    // dérive son état des 5 sous-coches maîtres (all-base, all-abbot, ...).
    // Sans cet appel, un refresh de page avec toutes les extensions actives
    // laissait la coche maître globale décochée à tort.
    _updateAllExtensionsMaster();
}

export function updateMasterCheckboxes() {
    const MASTER_IDS = ['all-base', 'all-abbot', 'all-inns-cathedrals', 'all-traders-builders', 'all-dragon', 'all-tiles'];
    MASTER_IDS.forEach(_updateMasterCheckboxSafe);
    _updateAllExtensionsMaster();
}

function _updateTileCount() {
    const el = document.getElementById('tiles-count');
    if (!el) return;
    let total = 72; // base toujours incluse
    if (_checked('tiles-abbot'))           total += 8;
    if (_checked('tiles-inns-cathedrals')) total += 18;
    if (_checked('tiles-traders-builders'))total += 24;
    if (_checked('tiles-dragon'))          total += 29;
    // Rivière : +12 si startType river (radio)
    const startVal = document.querySelector('input[name="start"]:checked')?.value;
    if (startVal === 'river') total += 12;
    el.textContent = `(${total} tuiles)`;
}

export function updateAllAvailability() {
    _updatePigAvailability();
    _updateMerchantsAvailability();
    _updateInnsCthdAvailability();
    _updateDragonAvailability();
    _updateTileCount();
    updateMasterCheckboxes();
}

// ── Initialisation ─────────────────────────────────────────────────────────

const MASTER_IDS = ['all-extensions', 'all-base', 'all-abbot', 'all-inns-cathedrals', 'all-traders-builders', 'all-dragon', 'all-tiles'];

/**
 * @param {object} deps
 * @param {Function} deps.getIsHost
 * @param {Function} deps.getInLobby
 * @param {object}   deps.multiplayer
 */
export function initLobbyOptions({ getIsHost, getInLobby, multiplayer }) {
    _getIsHost   = getIsHost;
    _getInLobby  = getInLobby;
    _multiplayer = multiplayer;

    // Charger les options sauvegardées EN PREMIER — avant les _updateAvailability
    // qui appellent saveLobbyOptions() et écraseraient sinon le localStorage
    loadLobbyOptions();

    // Disponibilité des options (listeners + état initial)
    _id('base-fields')?.addEventListener('change', _updatePigAvailability);
    _updatePigAvailability();

    _id('tiles-traders-builders')?.addEventListener('change', _updateMerchantsAvailability);
    _updateMerchantsAvailability();

    _id('tiles-inns-cathedrals')?.addEventListener('change', _updateInnsCthdAvailability);
    _updateInnsCthdAvailability();

    _id('tiles-dragon')?.addEventListener('change', _updateDragonAvailability);
    _id('ext-dragon')?.addEventListener('change', _updateDragonAvailability);
    _updateDragonAvailability();

    // Coches maîtres
    MASTER_IDS.forEach(masterId => {
        const master = _id(masterId);
        if (!master) return;
        master.addEventListener('click', e => e.stopPropagation());
        master.addEventListener('change', e => {
            e.stopPropagation();
            _onMasterChange(masterId);
        });
    });

    document.querySelectorAll('input[data-group]').forEach(child => {
        child.addEventListener('change', () => {
            _updateMasterCheckboxSafe(child.dataset.group);
            _updateAllExtensionsMaster();
        });
    });

    MASTER_IDS.forEach(_updateMasterCheckboxSafe);
    // ✅ FIX : même raison que dans loadLobbyOptions() — "all-extensions" doit être
    // recalculée explicitement, _updateMasterCheckboxSafe ne peut pas le faire seule.
    _updateAllExtensionsMaster();

    // Sauvegarde auto à chaque changement
    document.querySelectorAll(
        '#base-fields, #list-remaining, #use-test-deck, #enable-debug, #ext-abbot, #tiles-abbot, #ext-large-meeple, #ext-cathedrals, #ext-inns, #tiles-inns-cathedrals, #tiles-traders-builders, #ext-builder, #ext-merchants, #ext-pig, #tiles-dragon, #ext-dragon, #ext-princess, #ext-portal, #ext-fairy-protection, #ext-fairy-score-turn, #ext-fairy-score-zone'
    ).forEach(el => el.addEventListener('change', saveLobbyOptions));
    document.querySelectorAll('input[name="unplaceable"], input[name="start"]')
        .forEach(el => el.addEventListener('change', saveLobbyOptions));

    // Compteur de tuiles — mis à jour à chaque changement de tuile ou de départ
    ['tiles-abbot', 'tiles-inns-cathedrals', 'tiles-traders-builders', 'tiles-dragon'].forEach(id => {
        _id(id)?.addEventListener('change', _updateTileCount);
    });
    document.querySelectorAll('input[name="start"]')
        .forEach(el => el.addEventListener('change', _updateTileCount));
    _updateTileCount();

    // Chargement des presets (JSON)
    loadPresets();
}
