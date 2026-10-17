import { describe, expect, it } from 'vitest'
import { useWorkbench } from '../src/renderer/src/store/workbench'

describe('previewPrefs (local-only dialog preview, no disk write)', () => {
  it('merges the patch into prefs', () => {
    useWorkbench.getState().previewPrefs({ 'workbench.sideBar.position': 'right' })
    expect(useWorkbench.getState().prefs['workbench.sideBar.position']).toBe('right')
  })
  it('keeps unrelated prefs untouched', () => {
    const size = useWorkbench.getState().prefs['editor.fontSize']
    useWorkbench.getState().previewPrefs({ 'editor.fontFamily': 'Fira Code' })
    expect(useWorkbench.getState().prefs['editor.fontFamily']).toBe('Fira Code')
    expect(useWorkbench.getState().prefs['editor.fontSize']).toBe(size)
  })
  it('normalizes values like savePrefs does', () => {
    useWorkbench.getState().previewPrefs({ 'workbench.sideBar.position': 'center' as never })
    expect(useWorkbench.getState().prefs['workbench.sideBar.position']).toBe('left')
  })
})
