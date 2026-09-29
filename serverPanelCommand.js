'use strict';

// Keep the Discord command's existing import path; all actions now use the
// same approved Legion map list as the dashboard.
const {
  handleServerPanelCommand,
  handleServerPanelInteraction,
} = require('./web/legionManager');

module.exports = { handleServerPanelCommand, handleServerPanelInteraction };