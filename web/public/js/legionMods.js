(() => {
  const form = document.getElementById('legion-mods-form');
  if (!form) return;

  const mapSelect = document.getElementById('legion-mods-map');
  const idsInput = document.getElementById('legion-mods-ids');
  const loadButton = document.getElementById('legion-mods-load');
  const saveButton = document.getElementById('legion-mods-save');
  const status = document.getElementById('legion-mods-status');
  let loadedMapId = null;
  let loadedIds = '';
  let busy = false;

  function setStatus(text, error = false) {
    status.textContent = text;
    status.className = error ? 'legion-alert error' : 'legion-note';
  }

  function setBusy(value) {
    busy = value;
    loadButton.disabled = value;
    mapSelect.disabled = value;
    idsInput.disabled = value;
    saveButton.disabled = value || loadedMapId !== mapSelect.value;
  }

  function currentIds() {
    return idsInput.value.split(',').map(id => id.trim()).join(',');
  }

  mapSelect.addEventListener('change', () => {
    if (loadedMapId && idsInput.value !== loadedIds &&
        !window.confirm('Les changements non enregistrés seront perdus. Continuer ?')) {
      mapSelect.value = loadedMapId;
      return;
    }
    loadedMapId = null;
    loadedIds = '';
    saveButton.disabled = true;
    setStatus('Charge la liste de la carte sélectionnée avant de la modifier.');
  });

  idsInput.addEventListener('input', () => {
    saveButton.disabled = busy || loadedMapId !== mapSelect.value;
  });

  loadButton.addEventListener('click', async () => {
    if (loadedMapId && idsInput.value !== loadedIds &&
        !window.confirm('Les changements non enregistrés seront perdus. Recharger la liste ?')) {
      return;
    }
    setBusy(true);
    setStatus('Lecture de la liste GPanel…');
    try {
      const response = await fetch(`/legion/api/mods/${encodeURIComponent(mapSelect.value)}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Impossible de lire la liste des mods.');
      idsInput.value = data.modIds.join(',');
      loadedMapId = mapSelect.value;
      loadedIds = idsInput.value;
      saveButton.disabled = false;
      setStatus(data.modIds.length
        ? `${data.modIds.length} mod(s) chargé(s). L’ordre affiché est l’ordre de chargement.`
        : 'Aucun mod n’est configuré sur cette carte.');
    } catch (error) {
      loadedMapId = null;
      saveButton.disabled = true;
      setStatus(error.message, true);
    } finally {
      setBusy(false);
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || loadedMapId !== mapSelect.value) return;
    const modIds = currentIds();
    const summary = modIds || '(liste vide : tous les mods seront retirés)';
    if (!window.confirm(
      `Enregistrer cette liste de mods pour ${mapSelect.selectedOptions[0].text} ?\n\n${summary}\n\nLa carte doit être hors ligne. Aucun redémarrage ne sera lancé.`
    )) return;

    setBusy(true);
    setStatus('Enregistrement et vérification dans GPanel…');
    try {
      const response = await fetch(`/legion/api/mods/${encodeURIComponent(mapSelect.value)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modIds }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Impossible d’enregistrer la liste des mods.');
      idsInput.value = data.modIds.join(',');
      loadedIds = idsInput.value;
      setStatus(`Liste enregistrée et relue dans GPanel (${data.modIds.length} mod(s)). Démarre la carte manuellement pour télécharger les mods.`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      setBusy(false);
    }
  });

  setStatus('Choisis une carte puis charge sa liste de mods.');
})();
