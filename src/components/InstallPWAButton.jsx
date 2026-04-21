import { usePWAInstall } from '../usePWAInstall'

export default function InstallPWAButton() {
  const { canInstall, promptInstall, isStandalone } = usePWAInstall()

  if (isStandalone) return null

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)

  if (isIos) {
    return (
      <div className="pwa-banner">
        <strong>Telepítés iOS-en:</strong> Nyisd meg a Megosztás menüt, majd válaszd a "Kezdőképernyőhöz adás" lehetőséget.
      </div>
    )
  }

  if (!canInstall) return null

  return (
    <button type="button" className="secondary-button" onClick={() => promptInstall()}>
      Alkalmazás telepítése
    </button>
  )
}
