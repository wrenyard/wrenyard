import { WrenyardIpcClient, WrenyardRpcError } from '@wrenyard/control-client';

export interface DaemonProbe {
  connected: boolean;
  compatible: boolean;
  daemonVersion?: string;
}

/** Product compatibility is separate from the transport's protocol handshake. */
export async function probeWrenyard(path: string, version: string): Promise<DaemonProbe> {
  const client = new WrenyardIpcClient({ path, requestTimeoutMs: 5_000 });
  try {
    const health = await client.request<{ ok: boolean; identity?: { version?: string } }>('health.ping');
    const daemonVersion = health?.identity?.version;
    return { connected: true, compatible: health?.ok === true && daemonVersion === version, daemonVersion };
  } catch (error) {
    // A protocol rejection still proves that another daemon occupies the endpoint.
    const connected = error instanceof WrenyardRpcError
      || (error instanceof Error && error.message.startsWith('CLI 与 daemon 协议版本不一致'));
    return { connected, compatible: false };
  } finally {
    client.close();
  }
}

export function incompatibleDaemonMessage(probe: DaemonProbe, desktopVersion: string): string {
  return 'daemon 版本 ' + (probe.daemonVersion ?? '未知') + ' 与 Desktop 版本 ' + desktopVersion + ' 不一致，请退出该 daemon 后重启啾啾工坊。';
}
