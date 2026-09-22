// Delivering a new build to a device that already has the PWA.
//
// The service worker precaches the app shell, so a deploy does NOT reach a rep who already has
// the app open: the old shell keeps serving the old bundle. sw.js does skipWaiting() +
// clientsClaim(), so a new worker takes control as soon as it installs — but the page is still
// running the JS it booted with, and vite-plugin-pwa's generated registerSW.js does nothing
// about it. A rep could work a whole tradeshow on a stale build. Reloading when control actually
// changes is what swaps the running code.
//
// Extracted from main.jsx so the guards are testable: a reload LOOP in a rep's hands mid-order
// would be far worse than a stale build, so both guards below are asserted in ssr-smoke.
export function keepAppFresh(nav, reload, addWindowListener, setTimer) {
  if (!nav || !('serviceWorker' in nav)) return false;
  // On a FIRST install there is no previous controller and the page is already running the code
  // it just downloaded — reloading there is a pointless flash, not an update.
  const hadController = !!nav.serviceWorker.controller;
  let reloaded = false;
  nav.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    reload();
  });

  // Ask whether a new build exists: on focus (a rep returning to the tablet) and hourly for a
  // device left open all day. Cheap — a conditional GET of sw.js.
  const check = () => {
    try {
      const p = nav.serviceWorker.getRegistration();
      if (p && typeof p.then === 'function') p.then((r) => r && r.update()).catch(() => {});
    } catch {
      /* never let an update check break the app */
    }
  };
  addWindowListener('focus', check);
  setTimer(check, 60 * 60 * 1000);
  return true;
}
