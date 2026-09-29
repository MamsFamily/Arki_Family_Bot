const { MAPS } = require('./web/legionManager');

// The stored map list may contain old Nitrado IDs. Booster eligibility always
// comes from the approved Legion cluster, never from those historical records.
function getBoosterMaps() {
  return MAPS.map(map => ({
    id: map.id,
    serviceId: map.id,
    displayName: map.name,
  }));
}

module.exports = { getBoosterMaps };