import { useSyncExternalStore } from 'react'
import { themes } from './themeManager'

const subscribe = themes.subscribe.bind(themes)

/** Subscribe to the active product icon slot. The singleton stays in the theme module. */
export const useProductIconTheme = () => useSyncExternalStore(subscribe, () => themes.active.productIcon)

/** Subscribe to the active file icon slot. */
export const useFileIconTheme = () => useSyncExternalStore(subscribe, () => themes.active.fileIcon)
