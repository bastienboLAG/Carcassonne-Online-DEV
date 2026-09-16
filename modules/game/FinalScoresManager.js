/**
 * FinalScoresManager - Gère les scores finaux et la modale associée
 * Extrait de home.js pour alléger le fichier principal
 */
export class FinalScoresManager {
    constructor({ gameState, scoring, zoneMerger, gameSync, eventBus, updateTurnDisplay, gameConfig = null }) {
        this.gameState       = gameState;
        this.scoring         = scoring;
        this.zoneMerger      = zoneMerger;
        this.gameSync        = gameSync;
        this.eventBus        = eventBus;
        this.updateTurnDisplay = updateTurnDisplay;
        this.gameConfig      = gameConfig;

        this.gameEnded       = false;
        this.finalScoresData = null;
    }

    /**
     * Calcul et application des scores finaux (appelé par l'hôte)
     */
    computeAndApply(placedMeeples) {
        if (!this.scoring || !this.zoneMerger) return null;

        const detailedScores = this.scoring.applyAndGetFinalScores(placedMeeples, this.gameState);
        console.log('💰 Scores finaux détaillés:', detailedScores);

        this.gameEnded       = true;
        this.finalScoresData = detailedScores;

        this.eventBus.emit('score-updated');
        this.updateTurnDisplay();
        this.showModal(detailedScores);

        if (this.gameSync) this.gameSync.syncGameEnded(detailedScores, this.gameState?.destroyedTilesCount ?? 0);

        return detailedScores;
    }

    /**
     * Réception des scores finaux depuis le réseau (invité)
     */
    receiveFromNetwork(detailedScores, destroyedTilesCount = 0) {
        console.log('🏁 [SYNC] Fin de partie reçue');
        this.gameEnded       = true;
        this.finalScoresData = detailedScores;
        if (this.gameState) this.gameState.destroyedTilesCount = destroyedTilesCount;

        detailedScores.forEach(playerScore => {
            const player = this.gameState.players.find(p => p.id === playerScore.id);
            if (player) {
                player.score       = playerScore.total;
                player.scoreDetail = {
                    cities:       playerScore.cities,
                    roads:        playerScore.roads,
                    monasteries:  playerScore.monasteries,
                    fields:       playerScore.fields,
                    goods:        playerScore.goods ?? 0,
                    fairy:        playerScore.fairy ?? 0,
                    buybacks:     playerScore.buybacks ?? 0 // ✨ NOUVEAU — Rachat de prisonnier
                };
                player.goods = playerScore.goodsTokens ?? { cloth: 0, wheat: 0, wine: 0 };
            }
        });

        this.eventBus.emit('score-updated');
        this.updateTurnDisplay();
        this.showModal(detailedScores);
    }

    /**
     * Afficher la modale des scores finaux
     */
    showModal(detailedScores) {
        const modal = document.getElementById('final-scores-modal');
        const isMobile = window.innerWidth < 768;

        // Arrêter le timer de partie et afficher le temps final dans la modale
        if (typeof stopGameTimer === 'function') stopGameTimer();
        const timerEl = document.getElementById('game-timer');
        const timerText = timerEl ? timerEl.textContent : '';
        if (timerEl) timerEl.style.display = 'none';
        const finalTimerEl = document.getElementById('final-scores-timer');
        if (finalTimerEl && timerText) {
            finalTimerEl.textContent = `Durée de la partie : ${timerText.replace('⏱ ', '')}`;
        }

        if (isMobile) {
            this._showModalMobile(detailedScores, modal);
        } else {
            this._showModalDesktop(detailedScores, modal);
        }

        modal.style.display = 'flex';
    }

    _showModalDesktop(detailedScores, modal) {
        const tbody = document.getElementById('final-scores-body');
        tbody.innerHTML = '';
        const table = document.getElementById('final-scores-table');
        table.style.display = '';

        // Wrapper scroll horizontal
        let wrapper = table.parentElement;
        if (!wrapper.classList.contains('scores-table-wrapper')) {
            wrapper = document.createElement('div');
            wrapper.className = 'scores-table-wrapper';
            table.parentNode.insertBefore(wrapper, table);
            wrapper.appendChild(table);
        }

        const cardsContainer = document.getElementById('final-scores-cards');
        if (cardsContainer) cardsContainer.style.display = 'none';

        const hasMerchants = this.gameConfig?.extensions?.merchants;
        const hasFairy     = this.gameConfig?.extensions?.fairyScoreTurn
                          || this.gameConfig?.extensions?.fairyScoreZone;
        // ✨ NOUVEAU — Rachat de prisonnier : colonne affichée uniquement si au moins un
        // rachat a eu lieu durant la partie (gameState.hasPrisonerBuybacks).
        const hasBuybacks  = !!this.gameState?.hasPrisonerBuybacks;

        // Mettre à jour les en-têtes
        const thead = table.querySelector('thead tr');
        thead.innerHTML = `
            <th>Joueur</th>
            <th>Villes</th>
            <th>Routes</th>
            <th>Abbayes</th>
            <th>Champs</th>
            ${hasMerchants ? '<th>March.</th>' : ''}
            ${hasFairy     ? '<th>Fée</th>' : ''}
            ${hasBuybacks  ? '<th>Rachats</th>' : ''}
            <th>Total</th>
        `;

        detailedScores.forEach(player => {
            if (player.color === 'spectator') return;
            const row      = document.createElement('tr');
            const colorCap = player.color.charAt(0).toUpperCase() + player.color.slice(1);
            const imgSrc   = `assets/Meeples/${colorCap}/Normal.png`;

            const nameCell = document.createElement('td');
            nameCell.innerHTML = `
                <div class="player-name-cell">
                    <img src="${imgSrc}" alt="${player.color}">
                    <span style="${player.kicked ? 'opacity:0.45;' : ''}">${player.kicked ? '🚪 ' : ''}${player.name}</span>
                </div>`;
            row.appendChild(nameCell);

            const vals = [player.cities, player.roads, player.monasteries, player.fields];
            if (hasMerchants) vals.push(player.goods ?? 0);
            if (hasFairy)     vals.push(player.fairy ?? 0);
            if (hasBuybacks)  vals.push(player.buybacks ?? 0); // ✨ NOUVEAU
            vals.push(player.total); // Total toujours en dernier

            const totalIdx = vals.length - 1;
            vals.forEach((val, i) => {
                const td = document.createElement('td');
                td.textContent = val;
                if (i === totalIdx) td.style.fontWeight = 'bold';
                row.appendChild(td);
            });

            tbody.appendChild(row);
        });

        // Ligne tuiles détruites
        const destroyed = this.gameState?.destroyedTilesCount ?? 0;
        if (destroyed > 0) {
            const footerRow = document.createElement('tr');
            footerRow.style.cssText = 'border-top: 2px solid rgba(255,255,255,0.2); color: rgba(255,255,255,0.6); font-size: 13px;';
            const td = document.createElement('td');
            td.colSpan = 10;
            td.style.textAlign = 'center';
            td.style.padding = '8px 0 4px';
            td.textContent = `🗑️ ${destroyed} tuile${destroyed > 1 ? 's' : ''} détruite${destroyed > 1 ? 's' : ''} durant la partie`;
            footerRow.appendChild(td);
            tbody.appendChild(footerRow);
        }
    }

    _showModalMobile(detailedScores, modal) {
        document.getElementById('final-scores-table').style.display = 'none';

        let cardsContainer = document.getElementById('final-scores-cards');
        if (!cardsContainer) {
            cardsContainer = document.createElement('div');
            cardsContainer.id = 'final-scores-cards';
            document.getElementById('final-scores-table').parentNode.insertBefore(
                cardsContainer,
                document.getElementById('final-scores-table')
            );
        }
        cardsContainer.innerHTML = '';
        cardsContainer.style.display = 'flex';
        cardsContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 10px;
            width: 100%;
            margin-bottom: 16px;
        `;

        const hasMerchantsMobile = this.gameConfig?.extensions?.merchants;
        const hasFairyMobile     = this.gameConfig?.extensions?.fairyScoreTurn
                                || this.gameConfig?.extensions?.fairyScoreZone;
        // ✨ NOUVEAU — Rachat de prisonnier : même condition d'affichage que sur desktop.
        const hasBuybacksMobile  = !!this.gameState?.hasPrisonerBuybacks;

        const labels = ['Villes', 'Routes', 'Abbayes', 'Champs'];
        const keys   = ['cities', 'roads', 'monasteries', 'fields'];
        if (hasMerchantsMobile) { labels.push('Marchandises'); keys.push('goods'); }
        if (hasFairyMobile)     { labels.push('Fée');        keys.push('fairy'); }
        if (hasBuybacksMobile)  { labels.push('Rachats');    keys.push('buybacks'); } // ✨ NOUVEAU

        detailedScores.forEach((player, index) => {
            if (player.color === 'spectator') return;
            const colorCap = player.color.charAt(0).toUpperCase() + player.color.slice(1);
            const isWinner = index === 0;

            const card = document.createElement('div');
            card.style.cssText = `
                background: ${isWinner ? 'rgba(241,196,15,0.2)' : 'rgba(52,73,94,0.7)'};
                border: 1px solid ${isWinner ? 'rgba(241,196,15,0.5)' : 'rgba(255,255,255,0.1)'};
                border-radius: 10px;
                padding: 12px 14px;
            `;

            // En-tête : meeple + nom + total
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
            `;
            header.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;">
                    <img src="assets/Meeples/${colorCap}/Normal.png" style="width:28px;height:28px;">
                    <span style="color:white;font-weight:bold;font-size:15px;${player.kicked ? 'opacity:0.45;' : ''}">${player.kicked ? '🚪 ' : ''}${player.name}</span>
                    ${isWinner ? '<span style="font-size:16px;">🏆</span>' : ''}
                </div>
                <span style="color:${isWinner ? '#f1c40f' : 'white'};font-weight:bold;font-size:20px;">${player.total} pts</span>
            `;
            card.appendChild(header);

            // Détails
            const details = document.createElement('div');
            details.style.cssText = `
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 4px 16px;
            `;
            keys.forEach((key, i) => {
                const val = player[key] ?? 0;
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;justify-content:space-between;color:rgba(255,255,255,0.75);font-size:13px;';
                row.innerHTML = `<span>${labels[i]}</span><span>${val}</span>`;
                details.appendChild(row);
            });
            card.appendChild(details);

            cardsContainer.appendChild(card);
        });

        // Ligne tuiles détruites
        const destroyed = this.gameState?.destroyedTilesCount ?? 0;
        if (destroyed > 0) {
            const footer = document.createElement('div');
            footer.style.cssText = 'text-align:center;color:rgba(255,255,255,0.5);font-size:13px;padding:4px 0 8px;';
            footer.textContent = `🗑️ ${destroyed} tuile${destroyed > 1 ? 's' : ''} détruite${destroyed > 1 ? 's' : ''} durant la partie`;
            cardsContainer.appendChild(footer);
        }
    }

    /**
     * Afficher les scores courants en mode debug
     */
    showDebugModal() {
        if (this.finalScoresData) {
            this.showModal(this.finalScoresData);
            return;
        }
        if (this.gameState && this.gameState.players.length > 0) {
            const currentScores = this.gameState.players
                .map(p => ({
                    id: p.id, name: p.name, color: p.color,
                    cities:      p.scoreDetail?.cities      || 0,
                    roads:       p.scoreDetail?.roads       || 0,
                    monasteries: p.scoreDetail?.monasteries || 0,
                    fields:      p.scoreDetail?.fields      || 0,
                    goods:       p.scoreDetail?.goods       || 0,
                    fairy:       p.scoreDetail?.fairy       || 0,
                    buybacks:    p.scoreDetail?.buybacks    || 0, // ✨ NOUVEAU — Rachat de prisonnier
                    goodsTokens: p.goods || { cloth: 0, wheat: 0, wine: 0 },
                    total:       p.score
                }))
                .sort((a, b) => b.total - a.total);
            this.showModal(currentScores);
        }
    }
}
