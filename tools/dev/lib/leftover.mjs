import { EXIT } from './constants.mjs';
import { sameCheckout } from './paths.mjs';
import { sourceIdentityFromHealth } from './rpc.mjs';

/**
 * Decide what a control client may do when the supervisor socket is gone.
 * Never kill by process name and never touch an installed daemon.
 */
export function leftoverControlDecision(input) {
  const command = input.command;
  const record = input.record ?? null;
  const checkout = input.checkout;
  const platform = input.platform;

  if (command === 'restart') {
    return {
      action: 'fail',
      exit: EXIT.failed,
      touchInstalled: false,
      message: 'No source-development supervisor is running. Start it with pnpm dev first. Installed Wrenyard was not modified.',
    };
  }

  if (!record) {
    return {
      action: 'ok-idle',
      exit: EXIT.ok,
      touchInstalled: false,
      message: 'No source-development instance is running.',
    };
  }

  if (!sameCheckout(record.checkout, checkout, platform)) {
    return {
      action: 'fail',
      exit: EXIT.failed,
      touchInstalled: false,
      message: `A leftover instance record belongs to ${record.checkout}. Not stopping a different checkout.`,
    };
  }

  if (input.healthUnreachable) {
    if (input.supervisorAlive || input.daemonAlive || input.desktopAlive) {
      return {
        action: 'fail-unverified',
        exit: EXIT.failed,
        touchInstalled: false,
        message: `Control endpoint is down and leftover PIDs still look alive (supervisor ${record.supervisorPid}, daemon ${record.daemonPid}, desktop ${record.desktopPid}). Ownership could not be verified; processes were not killed.`,
      };
    }
    return {
      action: 'ok-idle',
      exit: EXIT.ok,
      touchInstalled: false,
      message: 'No source-development instance is running.',
    };
  }

  const identity = sourceIdentityFromHealth(input.health);
  if (identity.mode === 'source' && identity.instanceId === record.instanceId) {
    return {
      action: 'shutdown-source',
      exit: EXIT.ok,
      touchInstalled: false,
      message: 'Supervisor control was down; the matching source daemon was shut down via business IPC.\nIf Desktop is still open, quit it from the tray. Unknown processes were not killed.',
    };
  }

  return {
    action: 'fail-foreign',
    exit: EXIT.failed,
    touchInstalled: false,
    message: `Control endpoint is down, but the running daemon is ${identity.mode ?? 'unknown'} (instance ${identity.instanceId ?? 'none'}). Not stopping the installed service. Recover the leftover supervisor (pid ${record.supervisorPid}, alive=${Boolean(input.supervisorAlive)}) manually.`,
  };
}
