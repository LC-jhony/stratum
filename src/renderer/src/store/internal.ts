let seq = 0

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${seq++}`

/** Pending SQL-parameter prompt resolver, set while ParamDialog is open. */
let paramResolver: ((values: Record<string, string> | null) => void) | null = null

export const resolveParams = (values: Record<string, string> | null) => paramResolver?.(values)
export const holdParams = (resolve: (values: Record<string, string> | null) => void) => { paramResolver = resolve }
export const releaseParams = () => { paramResolver = null }

/** Tabs whose multi-page fetch must stop; Cancel marks the tab while a fetch loop runs. */
export const fetchStop = new Set<string>()
