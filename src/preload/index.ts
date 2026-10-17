import { contextBridge, ipcRenderer } from 'electron'
import type { StratumApi } from '../shared/ipc'

const call = (ch: string) => (...a: unknown[]) => ipcRenderer.invoke(ch, ...a)
const group = (g: string, names: string[]) => Object.fromEntries(names.map((n) => [n, call(`${g}:${n}`)]))

const api: StratumApi = {
  connections: group('connections', ['list', 'save', 'remove', 'test', 'open', 'close']) as StratumApi['connections'],
  db: group('db', ['introspect', 'execute', 'cancel', 'submit']) as StratumApi['db'],
  themes: group('themes', ['list', 'read', 'importVsCodeExtensions']) as StratumApi['themes'],
  settings: group('settings', ['get', 'set']) as StratumApi['settings'],
  dialogs: group('dialogs', ['pickFile']) as StratumApi['dialogs'],
  export: group('export', ['save', 'saveBinary', 'pdf']) as StratumApi['export'],
  onCommand(cb) {
    const l = (_: unknown, cmd: string, arg?: unknown) => cb(cmd, arg)
    ipcRenderer.on('command', l)
    return () => ipcRenderer.removeListener('command', l)
  },
  platform: process.platform,
}
contextBridge.exposeInMainWorld('stratum', api)
