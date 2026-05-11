export function LoadingScreen({ label = 'Betöltés' }) {
  return (
    <div className="loading-screen">
      <div className="loading-wrap">
        <div className="loading-burger" aria-hidden="true">
          <div className="burger-bun burger-bun--top lb-bun-top"><span /></div>
          <div className="burger-layer burger-layer--tomato lb-ing lb-ing-1">
            <span className="burger-layer-sprite" />
          </div>
          <div className="burger-layer burger-layer--lettuce lb-ing lb-ing-2">
            <span className="burger-layer-sprite" />
          </div>
          <div className="burger-layer burger-layer--cheese lb-ing lb-ing-3">
            <span className="burger-layer-sprite" />
          </div>
          <div className="burger-layer burger-layer--patty lb-ing lb-ing-4">
            <span className="burger-layer-sprite" />
          </div>
          <div className="burger-bun burger-bun--bottom"><span /></div>
        </div>
        <p className="loading-label" role="status" aria-live="polite">{label}</p>
      </div>
    </div>
  )
}
