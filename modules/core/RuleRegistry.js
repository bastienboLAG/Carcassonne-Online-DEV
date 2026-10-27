/**
 * RuleRegistry - Gère l'enregistrement et l'activation des règles
 * Permet d'activer/désactiver les extensions du jeu
 */
export class RuleRegistry {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.rules = new Map(); // Map<name, ruleInstance>
        this.activeRules = new Set(); // Set<name>
    }

    /**
     * Enregistrer une nouvelle règle
     * @param {string} name - Nom unique de la règle (ex: "river", "inns")
     * @param {Class} RuleClass - Classe de la règle
     * @param {Object} config - Configuration pour la règle
     */
    register(name, RuleClass, config = {}) {
        // ✅ FIX : le registre survit d'une partie à l'autre — réenregistrer une règle désactivée est
        // normal (nouvelle partie). On ne signale l'écrasement que s'il remplace une règle encore ACTIVE
        // (vrai conflit).
        if (this.rules.has(name) && this.activeRules.has(name)) {
            console.warn(`⚠️ Règle "${name}" déjà active, écrasement`);
        }

        const ruleInstance = new RuleClass(this.eventBus, config);
        this.rules.set(name, ruleInstance);
        console.log(`📝 Règle "${name}" enregistrée`);
        
        return this;
    }

    /**
     * Enregistrer une instance déjà construite (pour les règles nécessitant des dépendances supplémentaires)
     * @param {string} name - Nom unique de la règle
     * @param {Object} ruleInstance - Instance déjà créée
     */
    registerInstance(name, ruleInstance) {
        // ✅ FIX : même raison que register() — écrasement signalé seulement si la règle est encore active
        if (this.rules.has(name) && this.activeRules.has(name)) {
            console.warn(`⚠️ Règle "${name}" déjà active, écrasement`);
        }
        this.rules.set(name, ruleInstance);
        console.log(`📝 Règle "${name}" enregistrée (instance)`);
        return this;
    }

    /**
     * Activer une règle
     * @param {string} name - Nom de la règle à activer
     */
    enable(name) {
        const rule = this.rules.get(name);
        
        if (!rule) {
            console.error(`❌ Règle "${name}" non trouvée`);
            return false;
        }

        if (this.activeRules.has(name)) {
            console.warn(`⚠️ Règle "${name}" déjà active`);
            return true;
        }

        // Appeler la méthode register() de la règle
        if (typeof rule.register === 'function') {
            rule.register();
            this.activeRules.add(name);
            console.log(`✅ Règle "${name}" activée`);
            
            // Émettre un événement
            this.eventBus.emit('rule-enabled', { name });
            return true;
        } else {
            console.error(`❌ Règle "${name}" n'a pas de méthode register()`);
            return false;
        }
    }

    /**
     * Désactiver une règle
     * @param {string} name - Nom de la règle à désactiver
     */
    disable(name) {
        const rule = this.rules.get(name);
        
        // ✅ FIX : désactiver une règle jamais enregistrée (extension décochée) ou déjà inactive est un
        // no-op normal (le retour au lobby les désactive toutes systématiquement) : ni erreur ni warning.
        if (!rule) return true;
        if (!this.activeRules.has(name)) return true;

        // Appeler la méthode unregister() de la règle
        if (typeof rule.unregister === 'function') {
            rule.unregister();
            this.activeRules.delete(name);
            console.log(`🔴 Règle "${name}" désactivée`);
            
            // Émettre un événement
            this.eventBus.emit('rule-disabled', { name });
            return true;
        } else {
            console.error(`❌ Règle "${name}" n'a pas de méthode unregister()`);
            return false;
        }
    }

    /**
     * Vérifier si une règle est active
     * @param {string} name - Nom de la règle
     */
    isActive(name) {
        return this.activeRules.has(name);
    }

    /**
     * Obtenir la liste des règles enregistrées
     */
    getRegisteredRules() {
        return Array.from(this.rules.keys());
    }

    /**
     * Obtenir la liste des règles actives
     */
    getActiveRules() {
        return Array.from(this.activeRules);
    }

    /**
     * Activer plusieurs règles d'un coup
     * @param {Array<string>} names - Tableau de noms de règles
     */
    enableMultiple(names) {
        const results = names.map(name => ({
            name,
            success: this.enable(name)
        }));
        
        const failures = results.filter(r => !r.success);
        if (failures.length > 0) {
            console.warn('⚠️ Échec activation de certaines règles:', failures);
        }
        
        return results;
    }

    /**
     * Désactiver toutes les règles actives
     */
    disableAll() {
        const activeNames = Array.from(this.activeRules);
        activeNames.forEach(name => this.disable(name));
        console.log('🔴 Toutes les règles désactivées');
    }

    /**
     * Réinitialiser le registry (pour tests)
     */
    reset() {
        this.disableAll();
        this.rules.clear();
        console.log('🔄 RuleRegistry réinitialisé');
    }
}
