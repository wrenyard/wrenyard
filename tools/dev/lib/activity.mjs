import { daemonBusy, sourceIdentityFromHealth } from './rpc.mjs';

export function combineActivity(options) {
  const daemon = options.daemonHealth
    ? daemonBusy(options.daemonHealth)
    : { known: false, busy: true };
  const desktop = options.desktopActivity;
  let desktopBusy = false;
  let desktopKnown = true;
  if (desktop == null) {
    desktopKnown = options.desktopRequired === true ? false : true;
    desktopBusy = options.desktopRequired === true;
  } else if (typeof desktop === 'object') {
    if (desktop.known === false) {
      desktopKnown = false;
      desktopBusy = true;
    } else {
      desktopBusy = desktop.streaming === true || desktop.running === true || desktop.busy === true;
    }
  }

  const known = daemon.known && desktopKnown;
  const busy = !known || daemon.busy || desktopBusy;
  return {
    known,
    busy,
    daemon,
    desktop: { known: desktopKnown, busy: desktopBusy, ...((desktop && typeof desktop === 'object') ? desktop : {}) },
  };
}

export function identityMatchesSource(health, expected) {
  const identity = sourceIdentityFromHealth(health);
  if (!identity.verified) return false;
  if (identity.mode !== 'source') return false;
  if (expected.instanceId && identity.instanceId !== expected.instanceId) return false;
  if (expected.checkout && identity.checkout && identity.checkout !== expected.checkout) {
    // Windows checkout compares are done by the caller with sameCheckout.
    return false;
  }
  return true;
}
