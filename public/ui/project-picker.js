/* Project switcher for settings pages.
 *
 * The listbox engine, keyboard model and themed popup live in `ui/picker.js`
 * (shared with the form selectors); this wrapper only keeps the project
 * vocabulary — the current project fallback and the project-specific classes
 * the two toolbars already rely on.
 */

import { createPicker } from './picker.js';

export function createProjectPicker(options = {}) {
  return createPicker({
    fallbackLabel: '当前项目',
    align: 'end',
    className: 'project-picker',
    triggerClassName: 'project-picker-trigger',
    menuClassName: 'project-picker-menu',
    ...options,
  });
}
