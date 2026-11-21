const { createApp } = require('../server');

const app = createApp({
  appsScriptUrl: process.env.GOOGLE_APPS_SCRIPT_URL,
  nodeEnv: process.env.NODE_ENV || 'production'
});

module.exports = app;
