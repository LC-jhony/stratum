import { Component, type ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * Render-crash guard. Without a boundary React unmounts the whole tree when a render throws,
 * which leaves the window blank; one boundary per editor tab keeps the workbench alive and
 * shows the failing tab's error with a retry action.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error('[stratum] render error', error) }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="empty-state">
        <Icon id="error" />
        <pre className="error-box">{error.message || String(error)}</pre>
        <button onClick={() => this.setState({ error: undefined })}>Retry</button>
      </div>
    )
  }
}
