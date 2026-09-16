import { WrenyardIpcClient } from '@wrenyard/control-client';
import type { ConversationActivityItem } from './shell-contract.js';

// This is the same bounded display-only activity projection used by Pet.
interface ActivitySnapshot {
  tasks: Array<{ task_run_id: string; task_label?: string; task_id?: string; status: string; project?: string; resolved_profile?: string }>;
  taskgraphs: Array<{ taskgraph_id: string; title?: string; state: string; project?: string; nodes: Array<{ node_id: string; state: string; task_run_id?: string; display_label?: string; resolved_profile?: string }> }>;
}

export async function readConversationActivity(ipcPath: string): Promise<ConversationActivityItem[]> {
  const client = new WrenyardIpcClient({ path: ipcPath, requestTimeoutMs: 3000 });
  try {
    const snapshot = await client.request<ActivitySnapshot>('activity.snapshot', {});
    const items: ConversationActivityItem[] = snapshot.tasks.map((task) => ({
      id: task.task_run_id, taskRunId: task.task_run_id,
      label: task.task_label ?? task.task_id ?? '任务', status: task.status,
      project: task.project, runtime: task.resolved_profile,
    }));
    const ids = new Set(items.map((item) => item.id));
    for (const graph of snapshot.taskgraphs) {
      if (graph.state !== 'running' && graph.state !== 'paused') continue;
      items.push({ id: graph.taskgraph_id, label: graph.title ?? '任务图', status: graph.state, project: graph.project });
      for (const node of graph.nodes) {
        if (node.state !== 'running' && node.state !== 'waiting') continue;
        const id = node.task_run_id ?? `${graph.taskgraph_id}:${node.node_id}`;
        if (ids.has(id)) continue;
        ids.add(id);
        items.push({ id, label: node.display_label ?? node.node_id, status: node.state,
          taskRunId: node.task_run_id, project: graph.project, runtime: node.resolved_profile });
      }
    }
    return items;
  } finally { client.close(); }
}
