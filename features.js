// Feature switches. Linked projects and the SWMS / high risk construction
// work screening are switched OFF unless PROJECTS_ENABLED=1 is set in the
// server .env. Switching off only hides them: project records stay in the
// database untouched and come back if the switch is turned on again.
module.exports = {
  get projects() { return process.env.PROJECTS_ENABLED === '1'; },
};
