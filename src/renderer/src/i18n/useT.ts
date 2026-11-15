import { useMemo } from 'react'
import { createTranslator, resolveLocale, type Translator } from '../../../core/i18n'
import { useWorkbench } from '../store/workbench'

/**
 * Reactive translator for React components. Changing `app.locale` in Settings re-renders every
 * consumer immediately, and `system` follows the browser/OS language of the current session.
 */
export function useT(): Translator {
  const setting = useWorkbench((s) => s.prefs['app.locale'])
  return useMemo(() => createTranslator(resolveLocale(setting, navigator.language)), [setting])
}
