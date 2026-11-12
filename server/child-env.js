/* Environment variables that grant access to Pi GUI's private local servers.
 *
 * Both pi and the integrated terminal run arbitrary user/project commands, and
 * their output can reach the model or third-party tooling. They must not
 * inherit these capabilities. Keep the list in one place: a key missing here is
 * a silent privilege leak that is easy to overlook in either call site.
 */
export const INTERNAL_ENV_KEYS = Object.freeze([
  'PI_GUI_TOKEN',
  'PI_GUI_BROWSER_BRIDGE_URL',
  'PI_GUI_BROWSER_BRIDGE_TOKEN',
  'PI_GUI_BROWSER_EXTENSION',
  'PI_GUI_BROWSER_URL',
  'PI_GUI_BROWSER_TOKEN',
  'PI_GUI_PROCESS_URL',
  'PI_GUI_PROCESS_TOKEN',
  'PI_GUI_RUNTIME_BROWSER_URL',
  'PI_GUI_RUNTIME_BROWSER_TOKEN',
]);

export function scrubInternalEnv(env) {
  const childEnv = { ...env };
  for (const key of INTERNAL_ENV_KEYS) delete childEnv[key];
  return childEnv;
}
