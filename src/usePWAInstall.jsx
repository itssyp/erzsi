import { useEffect, useState } from 'react';

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [canInstall, setCanInstall] = useState(false);
  const [isStandalone, setIsStandalone] = useState(
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator.standalone === true)
  );

  useEffect(() => {
    const onBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setCanInstall(true);
    };
    const onAppInstalled = () => {
      setCanInstall(false);
      setDeferredPrompt(null);
      setIsStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const promptInstall = async () => {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setCanInstall(false);
    return outcome === 'accepted';
  };

  return { canInstall, promptInstall, isStandalone };
}
