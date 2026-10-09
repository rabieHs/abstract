import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

/**
 * App-wide error boundary: a render bug in ONE tool card must degrade to a
 * small inline notice, never unmount the whole app into a white screen
 * (observed live: a schema change in a tool output whited the entire UI).
 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override componentDidCatch(error: Error) {
    console.error("[ui] render error caught by boundary:", error)
  }
  override render() {
    if (this.state.error) {
      return (
        <div style={{ fontFamily: "monospace", padding: 24, maxWidth: 640, margin: "0 auto" }}>
          <p style={{ fontWeight: 700 }}>The interface hit a rendering error.</p>
          <p style={{ opacity: 0.75, fontSize: 13 }}>
            Your work is safe — everything lives on the server. Reload the page to continue;
            if this repeats, the error below is what to report:
          </p>
          <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", opacity: 0.6 }}>
            {String(this.state.error)}
          </pre>
          <button
            onClick={() => location.reload()}
            style={{ marginTop: 12, padding: "6px 14px", cursor: "pointer" }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
)
