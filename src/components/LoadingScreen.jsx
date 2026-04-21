export function LoadingScreen({ label = 'Betöltés' }) {
  return (
    <div className="loading-screen">
      <div className="loading-card">
        <div className="spinner" />
        <h2 className="card-title">{label}</h2>
        <p className="helper-text">Kapcsolódás a Firebase hitelesítéshez, a fiókadatokhoz és az aktív esemény állapotához.</p>
      </div>
    </div>
  )
}
