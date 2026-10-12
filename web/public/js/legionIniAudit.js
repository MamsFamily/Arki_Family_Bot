(() => {
  const alert = document.getElementById('ini-audit-alert');
  const status = document.getElementById('ini-audit-status');
  if (!alert || !status) return;
  const states = { running: 'En ligne', offline: 'Hors ligne', starting: 'Démarrage',
    stopping: 'Arrêt', unknown: 'Inconnu' };
  const results = { match: 'Fichier conforme à cette date', missing: 'ALERTE : clé disparue',
    mismatch: 'ALERTE : valeur différente', invalid: 'ALERTE : valeur non validée (masquée)',
    ambiguous: 'ALERTE : plusieurs sections ou valeurs contradictoires',
    unavailable: 'Lecture impossible ; persistance inconnue' };
  const initial = { pending: 'Confirmation initiale en attente',
    unconfirmed: 'Écriture initiale non confirmée ou interrompue ; contrôle manuel requis',
    confirmed: 'Écriture initiale confirmée par relecture' };
  const names = new Map([...document.querySelectorAll('#journal-map option')]
    .map(option => [option.value, option.textContent]));
  let loading = false;
  const date = value => value ? new Date(value).toLocaleString('fr-FR') : 'pas encore contrôlé';
  function render(id, rows, format) {
    const list = document.getElementById(id);
    list.replaceChildren();
    for (const row of rows) {
      const item = document.createElement('li');
      item.textContent = format(row);
      list.append(item);
    }
    if (!rows.length) {
      const item = document.createElement('li');
      item.textContent = 'Aucun historique pour ce processus. Les anciennes écritures ne sont pas reconstituées.';
      list.append(item);
    }
  }
  const target = row => `${names.get(row.map_id) || 'Carte autorisée'} · ${row.file} ${row.section} · ${row.key} : attendu ${row.expected === null ? 'absent' : row.expected}`;
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch('/legion/api/ini/audit', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error('Historique indisponible ; surveillance non vérifiable.');
      const bad = data.current.filter(row =>
        row.initial_result === 'unconfirmed' || row.check_status === 'unavailable' ||
        ['missing', 'mismatch', 'invalid', 'ambiguous'].includes(row.last_result));
      alert.hidden = !bad.length;
      alert.textContent = `${bad.length} réglage(s) INI en écart, non confirmé(s) ou impossible(s) à vérifier. Consulte « Journaux » → « Persistance des réglages INI ». Aucune correction automatique.`;
      status.textContent = `Historique chargé le ${date(new Date())}. Rafraîchissement de l’affichage chaque minute. Effet en jeu non vérifié.`;
      render('ini-audit-current', data.current, row => {
        const prior = row.check_status === 'unavailable' && row.last_result
          ? ` · Dernier résultat lisible : ${results[row.last_result]}` : '';
        return `${target(row)} · ${initial[row.initial_result]} (${date(row.confirmed_at || row.created_at)}) · ${results[row.check_status] || 'Contrôle différé en attente'}${prior} · Observé : ${row.observed == null ? 'absent ou masqué' : row.observed} · GPanel : ${states[row.server_state] || 'Non observé'} · ${date(row.checked_at)}`;
      });
      render('ini-audit-history', data.history, row =>
        `${date(row.created_at)} · ${target(row)} · ${initial[row.initial_result]} · Confirmation : ${date(row.confirmed_at)}`);
      render('ini-audit-checks', data.checks, row =>
        `${date(row.checked_at)} · ${target(row)} · ${results[row.result]} · Observé : ${row.observed == null ? 'absent ou masqué' : row.observed} · GPanel : ${states[row.server_state] || 'Inconnu'} · ${row.reason === 'restart_observed' ? 'Après retour en ligne/redémarrage observé' : 'Après délai'}`);
    } catch {
      status.textContent = 'Historique indisponible ; les résultats précédents peuvent être périmés.';
      alert.hidden = false;
      alert.textContent = 'Surveillance INI non vérifiable : historique PostgreSQL indisponible. Aucun résultat de conformité ne peut être confirmé.';
    } finally { loading = false; }
  }
  document.getElementById('ini-audit-refresh').addEventListener('click', load);
  document.querySelector('[data-tab="journal"]')?.addEventListener('click', load);
  load();
  setInterval(() => { if (!document.hidden) load(); }, 60_000);
})();
