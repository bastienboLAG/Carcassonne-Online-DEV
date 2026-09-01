/**
 * version.js — Version de l'application
 * À mettre à jour à chaque déploiement.
 *
 * La compatibilité est vérifiée à la connexion :
 * - Même version requise (hôte et invité)
 * - Même origine requise (hostname + pathname) pour éviter les forks
 *
 * V.1.xx.yy.zzz
 * xx=numéro d'extension en cours (03 pour dragon, 04 pour tour, etc.)
 * yy=ajout majeur
 * zzz=ajout mineur
 */

export const APP_VERSION = '1.04.01.001';