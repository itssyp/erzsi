import { useParams } from 'react-router-dom'
import { StatusCard } from '../../components/StatusCard'

export function QrLandingPage() {
  const { qrCode } = useParams()

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        background: 'linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)',
      }}
    >
      <div style={{ width: 'min(560px, 100%)' }}>
        <StatusCard
          title="Védett QR-azonosító"
          tone="info"
          body="Ez a QR-kód nyilvános felületen nem jelenít meg résztvevői adatokat. Használd a bejelentkezett staff vagy admin szkennerfolyamatban."
        >
          <p className="helper-text" style={{ marginTop: '12px' }}>
            Azonosító: {qrCode || 'Ismeretlen'}
          </p>
        </StatusCard>
      </div>
    </main>
  )
}
