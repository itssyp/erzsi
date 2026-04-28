import { usePWAInstall } from '../usePWAInstall'

export default function InstallPWAButton() {
  const { canInstall, promptInstall, isStandalone } = usePWAInstall()

  if (isStandalone) return null

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const isAndroid = /android/i.test(navigator.userAgent)

  if (isIos) {
    return (
      <div className="pwa-banner">
        <strong>Telepítés iOS-en:</strong> Nyisd meg a Megosztás menüt, majd válaszd a "Kezdőképernyőhöz adás" lehetőséget.
      </div>
    )
  }

  if (isAndroid && !canInstall) {
    return (
      <div className="pwa-banner">
        <strong>Telepítés Androidon:</strong> Nyisd meg a böngésző menüjét, majd válaszd az "Alkalmazás telepítése" vagy a "Kezdőképernyőhöz adás" lehetőséget.
      </div>
    )
  }

  if (!canInstall) return null

  if (isAndroid) {
    return (
      <div className="pwa-install-stack">
        <button type="button" className="secondary-button" onClick={() => promptInstall()}>
          Alkalmazás telepítése
        </button>
        <p className="pwa-helper-text">Androidon a telepítés után az app a kezdőképernyőről is indítható.</p>
      </div>
    )
  }

  return (
    <button type="button" className="secondary-button" onClick={() => promptInstall()}>
      Alkalmazás telepítése
    </button>
  )
}
