import '@vscode/codicons/dist/codicon.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { useWorkbench } from './store/workbench'
import { themes } from './theme/themeManager'

document.documentElement.dataset.platform = window.stratum.platform
void themes.init().finally(() => createRoot(document.getElementById('root')!).render(<App />))
if (location.search.includes('smoke=1')) Object.assign(window, { __wb: useWorkbench, __themes: themes }) // test hook, only with ?smoke=1
