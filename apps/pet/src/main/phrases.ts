export const FLAVORS: Record<string, string[]> = {
  started: [
    '出发！',
    '干活！',
    '来了～',
    '收到！',
    '开工！',
  ],
  progress: [
    '构建中…',
    '搬砖…',
    '努力中…',
    '运转中…',
    '处理中…',
  ],
  checkpoint: [
    '卡住了…',
    '确认下～',
    '暂停…',
    '有情况！',
    '拍板！',
  ],
  done: [
    '收工！',
    '搞定！',
    '完成！',
    '回家～',
    '✅ 收工！',
  ],
  failed: [
    '翻车了…',
    '失败了…',
    '出错了…',
    '搞砸了…',
    '呜呜…',
  ],
  message: [
    '📢 通知',
    '广播！',
    '注意！',
    '消息：',
    '喇叭：',
  ],
};

export const ERROR_FLAVORS: Record<string, string[]> = {
  failed: [
    '翻车了…',
    '失败了…',
    '出错了…',
    '搞砸了…',
    '呜呜…',
  ],
  checkpoint: [
    '紧急！',
    '大事了！',
    '红色警报！',
    '严重错误！',
  ],
};

export function getFlavor(kind: string, severity: string): string {
  const groupName = kindToGroup(kind);
  if (groupName === 'failed' && severity === 'error') {
    const group = ERROR_FLAVORS.failed;
    if (!group || group.length === 0) return '';
    return group[Math.floor(Math.random() * group.length)];
  }
  if (groupName === 'checkpoint' && (severity === 'error' || severity === 'warning')) {
    const group = ERROR_FLAVORS.checkpoint;
    if (!group || group.length === 0) return '';
    return group[Math.floor(Math.random() * group.length)];
  }
  const group = FLAVORS[groupName];
  if (!group || group.length === 0) return '';
  return group[Math.floor(Math.random() * group.length)];
}

function kindToGroup(kind: string): string {
  if (kind.endsWith('.started')) return 'started';
  if (kind === 'progress') return 'progress';
  if (kind === 'flow.checkpoint') return 'checkpoint';
  if (kind.endsWith('.done')) return 'done';
  if (kind.endsWith('.failed')) return 'failed';
  if (kind === 'message') return 'message';
  return 'progress'; // unknown kind
}
