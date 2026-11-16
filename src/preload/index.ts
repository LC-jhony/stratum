import { contextBridge, ipcRenderer } from 'electron'
import type { StratumApi } from '../shared/ipc'

const call = (ch: string) => (...a: unknown[]) => ipcRenderer.invoke(ch, ...a)
const group = (g: string, names: string[]) => Object.fromEntries(names.map((n) => [n, call(`${g}:${n}`)]))

const api: StratumApi = {
  connections: {
    ...group('connections', ['list', 'save', 'remove', 'test', 'open', 'close', 'reconnect', 'exportFile', 'importFile']) as Omit<StratumApi['connections'], 'onState'>,
    onState(cb) {
      const l = (_: unknown, state: Parameters<typeof cb>[0]) => cb(state)
      ipcRenderer.on('connections:state', l)
      return () => ipcRenderer.removeListener('connections:state', l)
    },
  },
  db: group('db', ['introspect', 'execute', 'cancel', 'submit', 'plan', 'transaction', 'begin', 'commit', 'rollback', 'savepoint', 'rollbackToSavepoint', 'releaseSavepoint', 'sessions', 'killSession']) as StratumApi['db'],
  themes: group('themes', ['list', 'read', 'importVsCodeExtensions']) as StratumApi['themes'],
  settings: group('settings', ['get', 'set']) as StratumApi['settings'],
  history: group('history', ['get', 'add']) as StratumApi['history'],
  library: group('library', ['list', 'save', 'remove']) as StratumApi['library'],
  extensions: group('extensions', ['list', 'setEnabled']) as StratumApi['extensions'],
  drivers: group('drivers', ['list', 'add', 'remove', 'reveal', 'openFolder']) as StratumApi['drivers'],
  dialogs: group('dialogs', ['pickFile', 'openText', 'openImport']) as StratumApi['dialogs'],
  script: group('script', ['read', 'write']) as StratumApi['script'],
  docker: group('docker', ['list']) as StratumApi['docker'],
  export: group('export', ['save', 'saveBinary', 'pdf']) as StratumApi['export'],
  update: {
    ...group('update', ['state', 'check', 'download', 'install', 'openReleasePage']) as Omit<StratumApi['update'], 'onState'>,
    onState(cb) {
      const l = (_: unknown, state: Parameters<typeof cb>[0]) => cb(state)
      ipcRenderer.on('update:state', l)
      return () => ipcRenderer.removeListener('update:state', l)
    },
  },
  window: {
    ...group('window', ['minimize', 'toggleMaximize', 'close', 'isMaximized', 'showMenu']) as Omit<StratumApi['window'], 'onMaximized'>,
    onMaximized(cb) {
      const l = (_: unknown, maximized: boolean) => cb(maximized)
      ipcRenderer.on('window:maximized', l)
      return () => ipcRenderer.removeListener('window:maximized', l)
    },
  },
  onCommand(cb) {
    const l = (_: unknown, cmd: string, arg?: unknown) => cb(cmd, arg)
    ipcRenderer.on('command', l)
    return () => ipcRenderer.removeListener('command', l)
  },
  platform: process.platform,
}
contextBridge.exposeInMainWorld('stratum', api)
