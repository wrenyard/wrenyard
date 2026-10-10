/**
 * session workspace snapshot: the frozen workspace facts taken when a session
 * is created, plus the builder that freezes them for a new session.
 */

import { readdirSync, existsSync, statSync } from 'node:fs';

import type { SnapshotInput, SnapshotProjectInput, SessionHost } from './ports.ts';
import type { WorkspaceSnapshot } from './ledger.ts';
import { readInternal, WorkspaceFileSource, safePath } from './workspace.ts';

export async function createWorkspaceSnapshot(input: SnapshotInput): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = {
    takenAt: input.takenAt.toISOString(), deviceName: input.deviceName,
    agents: readInternal(input.workspaceRoot, 'AGENTS.md'),
    memoryIndex: readInternal(input.workspaceRoot, 'memories/INDEX.md'),
    builtinTasks: input.builtinTasks.map((task) => ({ ...task })),
    projects: input.projects.map((project) => ({ ...project, tasks: project.tasks.map((task) => ({ ...task })), recentDocs: [] })),
  };
  const source = new WorkspaceFileSource({ workspaceRoot: input.workspaceRoot, snapshot });
  const today = Date.UTC(input.takenAt.getFullYear(), input.takenAt.getMonth(), input.takenAt.getDate());
  for (const project of snapshot.projects) {
    const walk = (dir: string): void => {
      let absolute: string;
      try { absolute = safePath(input.workspaceRoot, dir); } catch { return; }
      if (!existsSync(absolute)) return;
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const path = dir + '/' + entry.name;
        let target: string;
        try { target = safePath(input.workspaceRoot, path); } catch { continue; }
        if (statSync(target).isDirectory()) { walk(path); continue; }
        const match = /^(\d{4}-\d{2}-\d{2})-.+\.md$/u.exec(entry.name);
        if (!match) continue;
        const date = Date.parse(match[1]! + 'T00:00:00Z');
        const age = (today - date) / 86400000;
        if (!Number.isFinite(age) || age < 0 || age >= 7) continue;
        const owner = snapshot.projects.filter((candidate) => path.startsWith(candidate.workspaceDir + '/docs/'))
          .sort((a, b) => b.workspaceDir.length - a.workspaceDir.length)[0];
        if (owner?.id !== project.id) continue;
        const doc = source.read(path);
        if (doc) project.recentDocs.push({ path, title: doc.title });
      }
    };
    for (const type of ['specs', 'plans', 'reports', 'handoff']) walk(project.workspaceDir + '/docs/' + type);
  }
  return snapshot;
}

/**
 * Build the frozen workspace snapshot a new session would take right now.
 * Shared by `createSession` and the new-session context inspection, so both
 * freeze the same facts instead of inspecting a different shape.
 */
export async function buildSnapshot(host: SessionHost): Promise<WorkspaceSnapshot> {
  const takenAt = host.now ? host.now() : new Date();
  const projects = await host.listProjects();
  const taskDefinitions = await host.listTaskDefinitions();

  const snapshotProjects: SnapshotProjectInput[] = [];
  for (const project of projects) {
    const head = project.checkoutPath ? await host.gitHead(project.checkoutPath) : {};
    snapshotProjects.push({
      id: project.id,
      ...(project.displayName === undefined ? {} : { displayName: project.displayName }),
      workspaceDir: project.workspaceDir,
      ...(project.checkoutPath === undefined ? {} : { checkoutPath: project.checkoutPath }),
      ...(project.gitRemote === undefined ? {} : { gitRemote: project.gitRemote }),
      ...(project.defaultBranch === undefined ? {} : { defaultBranch: project.defaultBranch }),
      ...(head.branch === undefined ? {} : { branch: head.branch }),
      ...(head.head === undefined ? {} : { head: head.head }),
      tasks: taskDefinitions
        .filter((definition) => definition.project === project.id)
        .map((definition) => ({
          id: definition.id,
          description: definition.description,
          inputSummary: definition.inputSummary,
        })),
    });
  }

  return createWorkspaceSnapshot({
    workspaceRoot: host.workspaceRoot,
    deviceName: host.deviceName,
    takenAt,
    projects: snapshotProjects,
    builtinTasks: taskDefinitions
      .filter((definition) => definition.project === undefined)
      .map((definition) => ({
        id: definition.id,
        description: definition.description,
        inputSummary: definition.inputSummary,
      })),
  });
}
