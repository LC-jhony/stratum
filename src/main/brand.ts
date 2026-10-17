import { app } from 'electron'
import path from 'node:path'

/** Brand asset from `stratum-brand/` in dev; copied to `<resources>/icons/` when packaged (see electron-builder.yml). */
export const brandPath = (p: string) =>
  app.isPackaged ? path.join(process.resourcesPath, 'icons', path.basename(p)) : path.join(app.getAppPath(), 'stratum-brand', p)
