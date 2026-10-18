import type { StratumApi } from '../../../shared/ipc'

/**
 * The only renderer entry point to the preload bridge. Keeping this in one module makes the
 * process boundary explicit and gives features a single import instead of `window.stratum`.
 */
export const ipc: StratumApi = new Proxy({} as StratumApi, {
  get(_target, property: string) {
    const bridge = window.stratum as unknown as Record<string, unknown>
    const value = bridge[property]
    return typeof value === 'function' ? value.bind(window.stratum) : value
  },
})
