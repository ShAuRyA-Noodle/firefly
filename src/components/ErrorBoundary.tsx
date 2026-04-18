import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: (err: Error, reset: () => void) => ReactNode
  onError?: (err: Error, info: ErrorInfo) => void
  label?: string
}

interface State {
  error: Error | null
}

/**
 * Surface-level error boundary. Wrap individual renderers so a bad Zod config
 * or runtime throw doesn't take down the whole app. The `fallback` can render
 * a skip-card that lets the queue keep moving.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? ' ' + this.props.label : ''}]`, error, info)
    this.props.onError?.(error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)

    return (
      <div className="glass-card p-5 space-y-2" role="alert">
        <div className="kicker text-crimson">frame failed</div>
        <p className="text-bone text-xs font-mono">
          {error.message || 'unknown error'}
        </p>
        <button type="button" onClick={this.reset} className="btn-ghost text-[10px] px-3 py-1">
          retry
        </button>
      </div>
    )
  }
}
