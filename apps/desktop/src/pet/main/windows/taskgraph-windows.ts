import type { PageLoader } from '../../../pages.js';
import { BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'node:path';
import type { DaemonClient } from '../../../main/daemon-client/client';
import { ForemanTaskGraphReader } from '../../../main/daemon-client/foreman-taskgraph-reader';
import { SerializedAsyncPoller } from '../../../main/daemon-client/serialized-async-poller';
import type { TaskGraphEntityDtoWithPresentation, TaskGraphNodeState, GraphSlipSnapshotDto, TaskGraphInspectResult } from '../../shared/taskgraph';
import { projectGraphSlipFromActivity, activityAllowsTranscript } from './graph-slip-snapshot-dto';
import type { ActivityPresence, ActivityTaskGraphPresence } from '../../shared/activity-snapshot';
import { clampRectToRect } from './entity-geometry';
import {
  ENTITY_WINDOW_HEIGHT,
  GRAPH_SLIP_MIN_HEIGHT,
  GRAPH_SLIP_MIN_WIDTH,
  WREN_DISPLAY_HEIGHT,
  WREN_DISPLAY_WIDTH,
  fitGraphSlipWindowSize,
  placeWrenWindow,
  type SizeArea,
  type WrenWindowPlacement,
} from './placement';
import { createTaskGraphEntityWindow } from './entity-window';
import { createGraphSlipWindow } from './slip-window';
import {
  TRANSCRIPT_HEIGHT,
  TRANSCRIPT_WIDTH,
  createTranscriptWindow,
  standaloneTranscriptNodeId,
} from './transcript-window';

const GRAPH_SLIP_INITIAL_SIZE_WAIT_MS = 750;

const MAX_TRANSCRIPT_WINDOWS = 8;

const POLL_INTERVAL_MS = 2000;
const ENTITY_EXIT_MS = 800;

const TERMINAL_NODE_STATES: ReadonlySet<TaskGraphNodeState> = new Set(['done', 'failed', 'interrupted', 'cancelled']);

export interface TaskGraphWindowOwnerOptions {
  daemonClient: DaemonClient;
  pageLoader: PageLoader;
  preloadDir: string;
  getHouseWindow: () => BrowserWindow | null;
  graphSlipGeometry?: { x?: number; y?: number; width?: number; height?: number };
  onGraphSlipGeometryChange?: (geometry: { x?: number; y?: number; width?: number; height?: number }) => void;
  /** Whether Blueprint Wren entity windows are currently visible. */
  entitiesVisible?: boolean;
  /**
   * Register themed windows (the task transcript) with the appearance
   * controller. Transparent Pet overlays are never attached.
   */
  attachAppearance?: (window: BrowserWindow) => void;
  /** Capture harness only: render windows without ever showing or focusing them. */
  stayHidden?: boolean;
  logger?: Pick<Console, 'warn' | 'error' | 'log'>;
  onCleanup?: () => void;
}

interface EntityState {
  id: string;
  dto: TaskGraphEntityDtoWithPresentation;
  window: BrowserWindow;
  stale: boolean;
  exiting: boolean;
  manuallyPositioned: boolean;
  birdBounds: { x: number; y: number; width: number; height: number };
  placement: WrenWindowPlacement;
}

interface GraphSlipState {
  id: string;
  window: BrowserWindow;
  /** Dynamic presence from the single activity snapshot. */
  presence: ActivityTaskGraphPresence | null;
  lastProjectedDto: GraphSlipSnapshotDto | null;
  manualSize: boolean;
  manualResizeArmed: boolean;
  manualMoveArmed: boolean;
  autoResizeGuardUntil: number;
  initialAutoSizeApplied: boolean;
  readyToShow: boolean;
  shown: boolean;
  initialSizeWaitElapsed: boolean;
  initialSizeWaitTimer?: ReturnType<typeof setTimeout>;
}

/** Shared static-structure cache entry (taskgraph.inspect), keyed by graph id.
 * Loaded at most once per graph per structure_revision and shared by the Wren
 * entity fact-slip counts and any open Graph Slip. */
interface GraphStructureState {
  structure: TaskGraphInspectResult | null;
  loading: boolean;
}

export class TaskGraphWindowOwner {
  private readonly entities = new Map<string, EntityState>();
  private readonly graphSlips = new Map<string, GraphSlipState>();
  private readonly transcriptWindows = new Map<string, BrowserWindow>();
  private readonly reader: ForemanTaskGraphReader;
  private readonly pageLoader: PageLoader;
  private readonly preloadDir: string;
  private readonly getHouseWindow: () => BrowserWindow | null;
  private graphSlipGeometry: { x?: number; y?: number; width?: number; height?: number } | undefined;
  private readonly onGraphSlipGeometryChange?: TaskGraphWindowOwnerOptions['onGraphSlipGeometryChange'];
  private readonly attachAppearance?: TaskGraphWindowOwnerOptions['attachAppearance'];
  private readonly stayHidden: boolean;
  private entitiesVisible: boolean;
  private readonly logger: Pick<Console, 'warn' | 'error' | 'log'>;
  private readonly onCleanup?: () => void;
  private destroyed = false;
  private lastPresence: ActivityPresence | null = null;
  private readonly structureCache = new Map<string, GraphStructureState>();
  private readonly structureLoads = new Map<string, Promise<unknown>>();
  private connectionGeneration = 0;
  private readonly transcriptPoller = new SerializedAsyncPoller(POLL_INTERVAL_MS);
  private readonly liveTranscriptRuns = new Set<string>();
  private readonly transcriptLoadGenerations = new Map<string, number>();
  private transcriptLoadGeneration = 0;
  private entityExitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly transcriptGraphOwners = new Map<string, string>();
  private entityDrag: { entityId: string; offsetX: number; offsetY: number } | null = null;

  private readonly handleEntityDragStart = (event: Electron.IpcMainEvent): void => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!sender || sender.isDestroyed()) return;
    const entityId = this.findEntityIdByWindow(sender);
    if (!entityId) return;
    const entity = this.entities.get(entityId);
    if (!entity || entity.stale || entity.exiting) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = entity.birdBounds;
    this.entityDrag = {
      entityId,
      offsetX: cursor.x - bounds.x,
      offsetY: cursor.y - bounds.y,
    };
  };

  private readonly handleEntityDragMove = (event: Electron.IpcMainEvent): void => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!sender || sender.isDestroyed()) return;
    const entityId = this.findEntityIdByWindow(sender);
    const drag = this.entityDrag;
    if (!entityId || !drag || drag.entityId !== entityId) return;
    const entity = this.entities.get(entityId);
    if (!entity || entity.stale || entity.exiting) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const desiredBird = {
      x: cursor.x - drag.offsetX,
      y: cursor.y - drag.offsetY,
    };
    entity.manuallyPositioned = true;
    this.applyEntityPlacement(entity, desiredBird, display.workArea);
  };

  private readonly handleEntityDragEnd = (event: Electron.IpcMainEvent): void => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!sender || sender.isDestroyed()) return;
    const entityId = this.findEntityIdByWindow(sender);
    if (entityId && this.entityDrag?.entityId === entityId) {
      this.entityDrag = null;
    }
  };

  constructor(opts: TaskGraphWindowOwnerOptions) {
    this.reader = new ForemanTaskGraphReader(opts.daemonClient);
    this.pageLoader = opts.pageLoader;
    this.preloadDir = opts.preloadDir;
    this.getHouseWindow = opts.getHouseWindow;
    this.graphSlipGeometry = opts.graphSlipGeometry;
    this.onGraphSlipGeometryChange = opts.onGraphSlipGeometryChange;
    this.attachAppearance = opts.attachAppearance;
    this.stayHidden = opts.stayHidden ?? false;
    this.entitiesVisible = opts.entitiesVisible ?? true;
    this.logger = opts.logger ?? console;
    this.onCleanup = opts.onCleanup;
    this.registerIpcHandlers();
  }

  reconnect(): void {
    this.connectionGeneration += 1;
    this.structureCache.clear();
    this.structureLoads.clear();
    this.transcriptLoadGenerations.clear();
    for (const slip of this.graphSlips.values()) this.refreshSlipProjection(slip);
    for (const taskRunId of this.transcriptWindows.keys()) void this.loadTranscriptPage(taskRunId);
  }

  private registerIpcHandlers(): void {
    ipcMain.on('entity:drag-start', this.handleEntityDragStart);
    ipcMain.on('entity:drag-move', this.handleEntityDragMove);
    ipcMain.on('entity:drag-end', this.handleEntityDragEnd);

    ipcMain.handle('entity:open-self', async (event) => {
      // Do NOT take an entityId argument — infer identity solely from sender window
      const sender = BrowserWindow.fromWebContents(event.sender);
      if (!sender || sender.isDestroyed()) return;
      const entityId = this.findEntityIdByWindow(sender);
      if (!entityId) return;
      const entity = this.entities.get(entityId);
      if (!entity || entity.stale || entity.exiting) return;
      this.openGraphSlip(entityId);
    });

    ipcMain.handle('slip:close', async (event) => {
      const sender = BrowserWindow.fromWebContents(event.sender);
      if (!sender || sender.isDestroyed()) return;
      const graphId = this.findGraphSlipIdByWindow(sender);
      if (!graphId) return;
      this.closeGraphSlip(graphId);
    });

    ipcMain.handle('slip:report-content-size', async (event, width: unknown, height: unknown) => {
      if (this.stayHidden) return;
      if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > 10_000) return;
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || height > 20_000) return;
      const sender = BrowserWindow.fromWebContents(event.sender);
      if (!sender || sender.isDestroyed()) return;
      const graphId = this.findGraphSlipIdByWindow(sender);
      if (!graphId) return;
      const slip = this.graphSlips.get(graphId);
      if (!slip || slip.manualSize || slip.initialAutoSizeApplied) return;
      this.applyInitialGraphSlipSize(slip, { width, height });
    });

    ipcMain.handle('slip:open-transcript', async (event, nodeId: unknown, taskRunId: unknown) => {
      // Do NOT take a graphId argument — infer identity solely from sender window
      if (typeof nodeId !== 'string' || typeof taskRunId !== 'string') return;
      const sender = BrowserWindow.fromWebContents(event.sender);
      if (!sender || sender.isDestroyed()) return;
      const graphId = this.findGraphSlipIdByWindow(sender);
      if (!graphId) return;
      const slip = this.graphSlips.get(graphId);
      if (!slip) return;
      const structure = this.structureCache.get(graphId)?.structure ?? null;
      if (!activityAllowsTranscript(structure, slip.presence, graphId, nodeId, taskRunId)) {
        this.logger.warn('slip:open-transcript rejected: node/task run does not match slip snapshot');
        return;
      }
      const nodeState = slip.presence?.nodes.find((n) => n.nodeId === nodeId)?.state;
      const projectedNode = slip.lastProjectedDto?.nodes[nodeId];
      const taskLabel = projectedNode?.task_title ?? projectedNode?.display_label ?? '任务对话';
      this.openTranscriptWindow(
        nodeId,
        taskRunId,
        nodeState !== undefined && !TERMINAL_NODE_STATES.has(nodeState),
        graphId,
        taskLabel,
      );
    });

    ipcMain.handle('entity:set-mouse-passthrough', async (event, passthrough: unknown) => {
      if (typeof passthrough !== 'boolean') return;
      const sender = BrowserWindow.fromWebContents(event.sender);
      if (!sender || sender.isDestroyed()) return;
      const entityId = this.findEntityIdByWindow(sender);
      if (!entityId) return;
      sender.setIgnoreMouseEvents(passthrough, { forward: true });
    });

    ipcMain.handle('entity:get-state', async (event) => {
      // Infer entity exclusively from sender window — no renderer-supplied id
      const sender = BrowserWindow.fromWebContents(event.sender);
      if (!sender || sender.isDestroyed()) return null;
      const entityId = this.findEntityIdByWindow(sender);
      if (!entityId) return null;
      const entity = this.entities.get(entityId);
      if (!entity) return null;
      return {
        id: entity.id,
        state: entity.dto.state,
        stale: entity.stale,
        exiting: entity.exiting,
        ...(entity.dto.terminal !== undefined ? { terminal: entity.dto.terminal } : {}),
        ...(entity.dto.terminal_reason !== undefined ? { terminal_reason: entity.dto.terminal_reason } : {}),
        ...(entity.dto.error_paused !== undefined ? { error_paused: entity.dto.error_paused } : {}),
        ...(entity.dto.title !== undefined ? { title: entity.dto.title } : {}),
        ...(entity.dto.nodeCounts !== undefined ? { nodeCounts: entity.dto.nodeCounts } : {}),
        placement: this.entityPlacementPayload(entity),
      };
    });

    ipcMain.handle('transcript:retry', async (event, taskRunId: unknown) => {
      if (typeof taskRunId !== 'string' || !this.isTranscriptSender(event, taskRunId)) return;
      await this.loadTranscriptPage(taskRunId);
    });

    ipcMain.handle('transcript:close', async (event) => {
      const sender = BrowserWindow.fromWebContents(event.sender);
      if (!sender || sender.isDestroyed()) return;
      for (const win of this.transcriptWindows.values()) {
        if (win === sender) {
          sender.close();
          return;
        }
      }
    });
  }

  /**
   * Trusted-host entry point: render the shared read-only transcript preview
   * for a task run, independently of any open Graph Slip / Wren entity. The
   * run id is validated against the daemon (task.run.status is authoritative
   * for existence/terminal state; task.run.events is authoritative for
   * existence plus the derived label), so a nonexistent run is rejected and
   * the label/status come from real run data rather than caller input. The
   * preview reuses the single transcript window implementation — there is no
   * duplicated transcript UI or content pipeline. A graph association is
   * recorded only when the current activity snapshot genuinely knows which
   * graph and node the run belongs to; standalone runs keep the canonical
   * standalone node id and are never attached to an arbitrary graph.
   */
  async openTaskTranscript(taskRunId: string): Promise<void> {
    if (this.destroyed) throw new Error('TaskGraph: window owner is destroyed');
    if (typeof taskRunId !== 'string' || taskRunId.length === 0) {
      throw new Error('TaskGraph: invalid task run id');
    }

    // Existence + terminal state from the authoritative run status. Both the
    // status and the events request must succeed and agree on the run id, so
    // a stale/foreign run id can never reach the transcript window.
    const isTerminal = await this.reader.taskRunIsTerminal(taskRunId);
    await this.reader.loadTaskEvents(taskRunId, undefined, 1);

    const association = this.findRunAssociation(taskRunId);
    const taskLabel = association?.taskLabel ?? '任务对话';
    const nodeId = association?.nodeId ?? standaloneTranscriptNodeId(taskRunId);

    this.openTranscriptWindow(nodeId, taskRunId, !isTerminal, association?.graphId, taskLabel);
  }

  /**
   * Trusted-host entry point: open the Graph Slip window for a live task graph.
   * The graph id is validated for shape only; existence is decided by the same
   * live activity/entity state that drives Wren entities and slips (`openGraphSlip`
   * ignores an unknown, stale or exiting graph), so a foreign id can never open
   * an arbitrary window. This is the native Graph Slip surface — never a
   * transcript — and it stays reachable while entity windows are hidden or the
   * Pet module is disabled, because the shared activity round keeps entities
   * reconciled regardless of visibility.
   */
  async openTaskGraph(taskGraphId: string): Promise<void> {
    if (this.destroyed) throw new Error('TaskGraph: window owner is destroyed');
    if (typeof taskGraphId !== 'string' || taskGraphId.length === 0) {
      throw new Error('TaskGraph: invalid task graph id');
    }
    this.openGraphSlip(taskGraphId);
  }

  /**
   * Map a task run to its graph/node only when the current activity snapshot
   * genuinely carries the association. Taskgraph node presence is the
   * canonical source; a standalone task (direct run) has no graph and is
   * therefore never guessed onto one.
   */
  private findRunAssociation(
    taskRunId: string,
  ): { graphId: string; nodeId: string; taskLabel: string } | undefined {
    const presence = this.lastPresence;
    if (!presence) return undefined;

    for (const graph of presence.taskgraphs) {
      const node = graph.nodes.find((n) => n.taskRunId === taskRunId);
      if (!node) continue;
      const projectedNode = this.graphSlips.get(graph.taskgraphId)?.lastProjectedDto?.nodes[node.nodeId];
      const taskLabel = projectedNode?.task_title
        ?? projectedNode?.display_label
        ?? node.taskCategoryLabel
        ?? node.displayLabel
        ?? '任务对话';
      return { graphId: graph.taskgraphId, nodeId: node.nodeId, taskLabel };
    }

    const task = presence.tasks.find((t) => t.taskRunId === taskRunId);
    if (task?.taskgraphId && task.nodeId) {
      return { graphId: task.taskgraphId, nodeId: task.nodeId, taskLabel: task.taskLabel ?? '任务对话' };
    }

    return undefined;
  }

  private findEntityIdByWindow(win: BrowserWindow): string | undefined {
    for (const [id, entity] of this.entities) {
      if (entity.window === win) return id;
    }
    return undefined;
  }

  private findGraphSlipIdByWindow(win: BrowserWindow): string | undefined {
    for (const [id, slip] of this.graphSlips) {
      if (slip.window === win) return id;
    }
    return undefined;
  }

  private isTranscriptSender(event: Electron.IpcMainInvokeEvent, taskRunId: string): boolean {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!sender || sender.isDestroyed()) return false;
    return this.transcriptWindows.get(taskRunId) === sender;
  }

  /**
   * Single entry point for the shared activity snapshot. Wren entity presence
   * and Graph Slip dynamic state are both derived here — the owner performs no
   * per-graph taskgraph.list/status/slip N+1 polling. A stale round keeps every
   * surface unchanged and marks entities stale.
   */
  applyActivity(presence: ActivityPresence): void {
    if (this.destroyed) return;
    this.lastPresence = presence;
    if (presence.stale) {
      this.markAllEntitiesStale();
      this.reemitSlipProjections();
      return;
    }
    this.reconcileEntities(presence);
    this.reconcileSlips(presence);
  }

  /**
   * Terminal graph ids Pet still holds (visible entities + open slips) so the
   * daemon returns each terminal graph at most once while Pet is alive.
   */
  getTrackedTaskgraphIds(): string[] {
    const ids = new Set<string>();
    for (const id of this.entities.keys()) ids.add(id);
    for (const id of this.graphSlips.keys()) ids.add(id);
    return [...ids];
  }

  setEntitiesVisible(visible: boolean): void {
    this.entitiesVisible = visible;
    for (const entity of this.entities.values()) {
      if (entity.window.isDestroyed()) continue;
      if (visible && !this.stayHidden) entity.window.showInactive();
      else entity.window.hide();
    }
  }

  getEntitiesVisible(): boolean {
    return this.entitiesVisible;
  }

  private markAllEntitiesStale(): void {
    for (const entity of this.entities.values()) {
      if (!entity.stale) {
        entity.stale = true;
        this.pushEntityState(entity);
      }
    }
  }

  private reemitSlipProjections(): void {
    for (const slip of this.graphSlips.values()) {
      if (slip.window.isDestroyed()) continue;
      if (slip.lastProjectedDto) {
        slip.window.webContents.send('slip:snapshot', slip.lastProjectedDto);
      }
    }
  }

  private reconcileEntities(presence: ActivityPresence): void {
    const active = presence.taskgraphs.filter((g) => g.state !== 'done' && g.state !== 'cancelled');
    const terminal = presence.taskgraphs.filter((g) => g.state === 'done' || g.state === 'cancelled');
    const activeIds = new Set(active.map((g) => g.taskgraphId));
    const ordered = [...active].sort((a, b) => a.taskgraphId.localeCompare(b.taskgraphId));

    for (let i = 0; i < ordered.length; i++) {
      const graph = ordered[i];
      const entityId = graph.taskgraphId;
      const existing = this.entities.get(entityId);
      const dto = this.buildEntityDto(graph, presence.sampledAt, existing?.dto.created_at, existing?.dto);
      if (existing) {
        existing.stale = false;
        if (existing.exiting) {
          existing.exiting = false;
          this.clearEntityExitTimer(entityId);
        }
        existing.dto = dto;
        this.pushEntityState(existing);
        if (!existing.manuallyPositioned) this.positionEntity(existing, i);
      } else {
        this.createEntity(entityId, dto, i);
      }
      // One bounded inspect load per graph per structure_revision feeds the
      // revision-safe fact-slip counts (deduplicated, shared with Graph Slips).
      this.ensureStructureLoad(entityId, graph.structureRevision);
    }

    // Graphs gone from the snapshot leave — except tracked terminal graphs,
    // which the terminal loop below plays their one-time exit feedback first.
    const terminalIds = new Set(terminal.map((g) => g.taskgraphId));
    for (const [id, entity] of this.entities) {
      if (activeIds.has(id)) continue;
      if (terminalIds.has(id)) continue;
      this.scheduleEntityExit(id);
    }

    // Tracked terminal graphs: play their one-time terminal exit feedback.
    for (const graph of terminal) {
      const entity = this.entities.get(graph.taskgraphId);
      if (entity && !entity.exiting) {
        // Push the terminal state (done/cancelled + reason) so the renderer
        // shows the one-time badge/fold pose during the brief exit window
        // before the entity leaves for good. Counts are preserved from the
        // last validated same-revision label.
        entity.dto = this.buildEntityDto(graph, presence.sampledAt, entity.dto.created_at, entity.dto);
        this.pushEntityState(entity);
        this.scheduleEntityExit(graph.taskgraphId);
      }
    }
  }

  private buildEntityDto(
    graph: ActivityTaskGraphPresence,
    sampledAt: string,
    prevCreatedAt?: string,
    previous?: TaskGraphEntityDtoWithPresentation,
  ): TaskGraphEntityDtoWithPresentation {
    const state = graph.state === 'running' || graph.state === 'paused' || graph.state === 'created'
      ? graph.state
      : 'paused';
    const dto: TaskGraphEntityDtoWithPresentation = {
      id: graph.taskgraphId,
      state,
      revision: graph.structureRevision,
      created_at: prevCreatedAt ?? sampledAt,
    };
    if (graph.state === 'done' || graph.state === 'cancelled') {
      dto.terminal = graph.state;
    }
    if (graph.terminalReason !== undefined) dto.terminal_reason = graph.terminalReason;
    // paused + failed node renders the terracotta crack; otherwise manual pause.
    if (state === 'paused' && graph.nodeCounts.failed > 0) dto.error_paused = true;
    if (graph.title !== undefined) dto.title = graph.title;

    // Revision-safe fact-slip counts: cached same-revision structure nodes
    // whose action.type === 'task', numerator = task nodes whose activity
    // presence state === 'done'. Missing/loading/mismatched structure omits
    // counts; a previously validated label for the SAME revision is preserved
    // so stale/terminal rounds never regress the visible label.
    const structure = this.structureCache.get(graph.taskgraphId)?.structure ?? null;
    if (structure && structure.graph.revision === graph.structureRevision) {
      dto.nodeCounts = countDoneTaskNodes(structure, graph);
    } else if (previous?.nodeCounts && previous.revision === graph.structureRevision) {
      dto.nodeCounts = previous.nodeCounts;
    }
    return dto;
  }

  private reconcileSlips(presence: ActivityPresence): void {
    for (const slip of this.graphSlips.values()) {
      const graph = presence.taskgraphs.find((g) => g.taskgraphId === slip.id);
      if (!graph) continue; // reconcileEntities closes slips for gone graphs
      slip.presence = graph;
      this.refreshSlipProjection(slip);
    }
  }

  private refreshSlipProjection(slip: GraphSlipState): void {
    if (slip.window.isDestroyed()) return;
    if (!slip.presence) return;
    const structure = this.structureCache.get(slip.id)?.structure ?? null;
    if (structure && structure.graph.revision === slip.presence.structureRevision) {
      this.pushSlipProjection(slip, structure);
    } else {
      this.ensureStructureLoad(slip.id, slip.presence.structureRevision);
    }
  }

  /**
   * Bounded, deduplicated static-structure load shared by Wren entities and
   * Graph Slips. At most one taskgraph.inspect request runs per graph at a
   * time; a cached structure for the expected revision short-circuits. The
   * result is cached in the shared structure cache and pushed to whatever
   * entity/slip matches the loaded revision.
   */
  private ensureStructureLoad(graphId: string, expectedRevision: number): void {
    if (this.structureLoads.has(graphId)) return; // dedupe in-flight loads
    const entry = this.structureCache.get(graphId);
    if (entry?.structure && entry.structure.graph.revision === expectedRevision) return;
    if (entry) {
      entry.loading = true;
    } else {
      this.structureCache.set(graphId, { structure: null, loading: true });
    }

    const generation = this.connectionGeneration;
    const load = this.reader.loadStructure(graphId)
      .then((structure) => {
        if (generation !== this.connectionGeneration || this.destroyed) return;
        const current = this.structureCache.get(graphId);
        if (current) {
          current.structure = structure;
          current.loading = false;
        }
        this.onStructureLoaded(graphId, structure);
        return structure;
      })
      .catch((err) => {
        if (generation !== this.connectionGeneration || this.destroyed) return;
        this.logger.warn(`structure load failed for ${graphId}:`, err);
        const current = this.structureCache.get(graphId);
        if (current) current.loading = false;
        // Preserve the last complete slip projection and surface the error so
        // the next activity round retries. Counts simply stay omitted.
        const slip = this.graphSlips.get(graphId);
        if (slip && !slip.window.isDestroyed()) {
          if (slip.lastProjectedDto) {
            slip.window.webContents.send('slip:snapshot', slip.lastProjectedDto);
          }
          slip.window.webContents.send('slip:error', 'Failed to load graph snapshot');
        }
      });
    this.structureLoads.set(graphId, load);
    // Clear the in-flight marker once settled so a later revision mismatch or
    // a failed retry can issue a fresh bounded load.
    void load.finally(() => {
      if (this.structureLoads.get(graphId) === load) {
        this.structureLoads.delete(graphId);
      }
    });
  }

  private onStructureLoaded(graphId: string, structure: TaskGraphInspectResult): void {
    // Wren entity: recompute the revision-safe counts when the presence still
    // matches the freshly loaded structure revision.
    const entity = this.entities.get(graphId);
    if (entity && this.lastPresence) {
      const graph = this.lastPresence.taskgraphs.find((g) => g.taskgraphId === graphId);
      if (graph && structure.graph.revision === graph.structureRevision) {
        entity.dto = this.buildEntityDto(graph, this.lastPresence.sampledAt, entity.dto.created_at, entity.dto);
        this.pushEntityState(entity);
      }
    }
    // Graph Slip: only project when the loaded structure matches the current
    // presence revision; otherwise wait for the next activity round.
    const slip = this.graphSlips.get(graphId);
    if (slip && slip.presence && structure.graph.revision === slip.presence.structureRevision) {
      this.pushSlipProjection(slip, structure);
    }
  }

  private pushSlipProjection(slip: GraphSlipState, structure: TaskGraphInspectResult): void {
    if (slip.window.isDestroyed()) return;
    if (!slip.presence) return;
    const projected = projectGraphSlipFromActivity(structure, slip.presence);
    slip.lastProjectedDto = projected;
    slip.window.webContents.send('slip:snapshot', projected);
  }

  /** Drop shared structure cache entries no longer referenced by any surface. */
  private pruneStructureCache(): void {
    for (const graphId of this.structureCache.keys()) {
      if (!this.entities.has(graphId) && !this.graphSlips.has(graphId)) {
        this.structureCache.delete(graphId);
      }
    }
  }

  private createEntity(id: string, dto: TaskGraphEntityDtoWithPresentation, positionIndex: number): void {
    // The factory only wires window-scoped behaviour; entityState is assigned
    // synchronously right after it returns and the async window events fire
    // later, so the callbacks observe the populated state.
    let entityState!: EntityState;
    const win = createTaskGraphEntityWindow({
      preloadPath: path.join(this.preloadDir, 'entity.cjs'),
      pageLoader: this.pageLoader,
      windowId: id,
      stayHidden: this.stayHidden,
      onLoadFailure: () => {
        this.logger.warn(`entity ${id} load failed`);
        this.removeEntity(id);
      },
      onReady: () => {
        if (this.entities.get(id) !== entityState) return;
        this.pushEntityPlacement(entityState);
        this.pushEntityState(entityState);
      },
      isVisible: () => this.entitiesVisible,
    });

    entityState = {
      id,
      dto,
      window: win,
      stale: false,
      exiting: false,
      manuallyPositioned: false,
      birdBounds: { x: 0, y: 0, width: WREN_DISPLAY_WIDTH, height: WREN_DISPLAY_HEIGHT },
      placement: placeWrenWindow({ x: 0, y: 0 }, screen.getPrimaryDisplay().workArea),
    };
    this.entities.set(id, entityState);
    this.positionEntity(entityState, positionIndex);

    win.on('closed', () => {
      if (this.entities.get(id) !== entityState) return;
      this.closeGraphSlip(id);
      this.entities.delete(id);
      this.clearEntityExitTimer(id);
    });
  }

  private positionEntity(entity: EntityState, index: number): void {
    if (entity.manuallyPositioned || this.entityDrag?.entityId === entity.id) return;
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea;
    const house = this.getHouseWindow();
    let x: number;
    let y: number;
    if (house && !house.isDestroyed()) {
      const houseBounds = house.getBounds();
      x = Math.round(houseBounds.x + houseBounds.width + 8);
      y = Math.round(houseBounds.y + 8 + index * (ENTITY_WINDOW_HEIGHT + 4));
    } else {
      // Bottom-right fallback
      x = Math.round(workArea.x + workArea.width - WREN_DISPLAY_WIDTH - 8);
      y = Math.round(workArea.y + workArea.height - WREN_DISPLAY_HEIGHT - 8 - index * (ENTITY_WINDOW_HEIGHT + 4));
    }
    this.applyEntityPlacement(entity, { x, y }, workArea);
  }

  private applyEntityPlacement(
    entity: EntityState,
    desiredBird: { x: number; y: number },
    workArea: { x: number; y: number; width: number; height: number },
  ): void {
    if (entity.window.isDestroyed()) return;
    const placement = placeWrenWindow(desiredBird, workArea);
    entity.placement = placement;
    entity.birdBounds = {
      x: placement.windowBounds.x + placement.birdOffsetX,
      y: placement.windowBounds.y + placement.birdOffsetY,
      width: WREN_DISPLAY_WIDTH,
      height: WREN_DISPLAY_HEIGHT,
    };
    entity.window.setBounds(placement.windowBounds);
    this.pushEntityPlacement(entity);
  }

  private scheduleEntityExit(id: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    if (entity.exiting) return; // already scheduled
    entity.stale = true;
    entity.exiting = true;
    this.pushEntityState(entity);
    this.closeGraphSlip(id);
    this.closeGraphOwnedTranscriptWindows(id);
    this.entityExitTimers.set(id, setTimeout(() => {
      this.removeEntity(id);
    }, ENTITY_EXIT_MS));
  }

  private clearEntityExitTimer(id: string): void {
    const timer = this.entityExitTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.entityExitTimers.delete(id);
    }
  }

  private removeEntity(id: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    if (this.entityDrag?.entityId === id) this.entityDrag = null;
    this.clearEntityExitTimer(id);
    this.closeGraphSlip(id);
    this.closeGraphOwnedTranscriptWindows(id);
    if (!entity.window.isDestroyed()) {
      entity.window.destroy();
    }
    this.entities.delete(id);
    this.pruneStructureCache();
  }

  private pushEntityState(entity: EntityState): void {
    if (entity.window.isDestroyed()) return;
    const payload: Record<string, unknown> = {
      id: entity.id,
      state: entity.dto.state,
      stale: entity.stale,
      exiting: entity.exiting,
    };
    if (entity.dto.terminal !== undefined) payload.terminal = entity.dto.terminal;
    if (entity.dto.terminal_reason !== undefined) payload.terminal_reason = entity.dto.terminal_reason;
    if (entity.dto.error_paused !== undefined) payload.error_paused = entity.dto.error_paused;
    if (entity.dto.title !== undefined) payload.title = entity.dto.title;
    if (entity.dto.nodeCounts !== undefined) payload.nodeCounts = entity.dto.nodeCounts;
    entity.window.webContents.send('entity:state', payload);
  }

  private pushEntityPlacement(entity: EntityState): void {
    if (entity.window.isDestroyed()) return;
    entity.window.webContents.send('entity:placement', this.entityPlacementPayload(entity));
  }

  private entityPlacementPayload(entity: EntityState): Record<string, unknown> {
    return {
      bird_x: entity.placement.birdOffsetX,
      bird_y: entity.placement.birdOffsetY,
      tip_side: entity.placement.tipSide,
    };
  }

  private openGraphSlip(graphId: string): void {
    if (!this.entities.has(graphId) || this.destroyed) return;
    const entity = this.entities.get(graphId);
    if (!entity || entity.stale || entity.exiting) return;

    const existing = this.graphSlips.get(graphId);
    if (existing && !existing.window.isDestroyed()) {
      if (!this.stayHidden) existing.window.focus();
      return;
    }
    if (existing) {
      this.graphSlips.delete(graphId);
    }

    const hasSavedPosition = typeof this.graphSlipGeometry?.x === 'number'
      && Number.isFinite(this.graphSlipGeometry.x)
      && typeof this.graphSlipGeometry?.y === 'number'
      && Number.isFinite(this.graphSlipGeometry.y);
    const targetDisplay = hasSavedPosition
      ? screen.getDisplayNearestPoint({ x: this.graphSlipGeometry!.x!, y: this.graphSlipGeometry!.y! })
      : screen.getPrimaryDisplay();
    const workArea = targetDisplay.workArea;
    const hasSavedSize = typeof this.graphSlipGeometry?.width === 'number'
      && Number.isFinite(this.graphSlipGeometry.width)
      && typeof this.graphSlipGeometry?.height === 'number'
      && Number.isFinite(this.graphSlipGeometry.height);
    const initialSize = fitGraphSlipWindowSize(
      { width: 0, height: 0 },
      workArea,
      hasSavedSize ? this.graphSlipGeometry : undefined,
    );

    const initialBounds = clampRectToRect({
      x: hasSavedPosition
        ? this.graphSlipGeometry!.x!
        : Math.round(workArea.x + (workArea.width - initialSize.width) / 2),
      y: hasSavedPosition
        ? this.graphSlipGeometry!.y!
        : Math.round(workArea.y + (workArea.height - initialSize.height) / 2),
      width: initialSize.width,
      height: initialSize.height,
    }, workArea);

    let slipState!: GraphSlipState;
    const win = createGraphSlipWindow({
      bounds: initialBounds,
      minWidth: GRAPH_SLIP_MIN_WIDTH,
      minHeight: GRAPH_SLIP_MIN_HEIGHT,
      preloadPath: path.join(this.preloadDir, 'graph-slip.cjs'),
      stayHidden: this.stayHidden,
      pageLoader: this.pageLoader,
      graphId,
      onLoadFailure: () => {
        this.logger.warn(`graph slip ${graphId} load failed`);
        if (!slipState.window.isDestroyed()) slipState.window.close();
      },
      onDidFinishLoad: () => {
        if (this.graphSlips.get(graphId) === slipState) this.refreshSlipProjection(slipState);
      },
      onReady: () => {
        if (this.graphSlips.get(graphId) !== slipState) return;
        slipState.readyToShow = true;
        this.maybeShowGraphSlip(slipState);
      },
      onWillResize: () => {
        if (!this.stayHidden && Date.now() >= slipState.autoResizeGuardUntil) {
          slipState.manualResizeArmed = true;
        }
      },
      onWillMove: () => {
        // Electron emits will-move only for a user-initiated move, so unlike
        // resize this needs no guard against the initial programmatic fit.
        if (!this.stayHidden) slipState.manualMoveArmed = true;
      },
      onMove: (bounds) => {
        if (!slipState.manualMoveArmed) return;
        this.persistGraphSlipGeometry({ x: bounds.x, y: bounds.y });
      },
      onResize: (bounds) => {
        if (!slipState.manualResizeArmed) return;
        slipState.manualResizeArmed = false;
        slipState.manualSize = true;
        slipState.initialAutoSizeApplied = true;
        this.persistGraphSlipGeometry(bounds);
      },
      onClosed: () => {
        if (this.graphSlips.get(graphId) !== slipState) return;
        if (slipState.initialSizeWaitTimer) clearTimeout(slipState.initialSizeWaitTimer);
        this.graphSlips.delete(graphId);
      },
    });

    slipState = {
      id: graphId,
      window: win,
      presence: this.lastPresence?.taskgraphs.find((g) => g.taskgraphId === graphId) ?? null,
      lastProjectedDto: null,
      manualSize: hasSavedSize,
      manualResizeArmed: false,
      manualMoveArmed: false,
      autoResizeGuardUntil: 0,
      initialAutoSizeApplied: hasSavedSize,
      readyToShow: false,
      shown: false,
      initialSizeWaitElapsed: hasSavedSize,
    };
    this.graphSlips.set(graphId, slipState);
    if (!hasSavedSize && !this.stayHidden) {
      slipState.initialSizeWaitTimer = setTimeout(() => {
        slipState.initialSizeWaitElapsed = true;
        this.maybeShowGraphSlip(slipState);
      }, GRAPH_SLIP_INITIAL_SIZE_WAIT_MS);
    }

  }

  private applyInitialGraphSlipSize(slip: GraphSlipState, content: SizeArea): void {
    if (slip.window.isDestroyed() || slip.manualSize || slip.initialAutoSizeApplied) return;
    const hasSavedPosition = typeof this.graphSlipGeometry?.x === 'number'
      && Number.isFinite(this.graphSlipGeometry.x)
      && typeof this.graphSlipGeometry?.y === 'number'
      && Number.isFinite(this.graphSlipGeometry.y);
    const targetDisplay = hasSavedPosition
      ? screen.getDisplayNearestPoint({ x: this.graphSlipGeometry!.x!, y: this.graphSlipGeometry!.y! })
      : screen.getPrimaryDisplay();
    const workArea = targetDisplay.workArea;
    const size = fitGraphSlipWindowSize(content, workArea);
    slip.initialAutoSizeApplied = true;
    slip.initialSizeWaitElapsed = true;
    slip.autoResizeGuardUntil = Date.now() + 250;
    if (slip.initialSizeWaitTimer) {
      clearTimeout(slip.initialSizeWaitTimer);
      slip.initialSizeWaitTimer = undefined;
    }
    slip.window.setBounds(clampRectToRect({
      x: hasSavedPosition
        ? this.graphSlipGeometry!.x!
        : Math.round(workArea.x + (workArea.width - size.width) / 2),
      y: hasSavedPosition
        ? this.graphSlipGeometry!.y!
        : Math.round(workArea.y + (workArea.height - size.height) / 2),
      width: size.width,
      height: size.height,
    }, workArea));
    this.maybeShowGraphSlip(slip);
  }

  private persistGraphSlipGeometry(
    patch: { x?: number; y?: number; width?: number; height?: number },
  ): void {
    const geometry = { ...this.graphSlipGeometry, ...patch };
    this.graphSlipGeometry = geometry;
    this.onGraphSlipGeometryChange?.(geometry);
  }

  private maybeShowGraphSlip(slip: GraphSlipState): void {
    if (this.stayHidden || slip.window.isDestroyed() || !slip.readyToShow || slip.shown) return;
    if (!slip.initialAutoSizeApplied && !slip.initialSizeWaitElapsed) return;
    slip.shown = true;
    slip.window.showInactive();
  }

  private closeGraphSlip(graphId: string): void {
    const slip = this.graphSlips.get(graphId);
    if (!slip) return;
    if (slip.initialSizeWaitTimer) clearTimeout(slip.initialSizeWaitTimer);
    if (!slip.window.isDestroyed()) {
      slip.window.destroy();
    }
    this.graphSlips.delete(graphId);
    this.pruneStructureCache();
  }

  private closeGraphOwnedTranscriptWindows(graphId: string): void {
    for (const [taskRunId, ownerGraphId] of this.transcriptGraphOwners) {
      if (ownerGraphId !== graphId) continue;
      this.transcriptGraphOwners.delete(taskRunId);
      this.stopTranscriptPolling(taskRunId);
      const win = this.transcriptWindows.get(taskRunId);
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
      this.transcriptWindows.delete(taskRunId);
      this.transcriptLoadGenerations.delete(taskRunId);
      this.liveTranscriptRuns.delete(taskRunId);
    }
  }

  private openTranscriptWindow(
    nodeId: string,
    taskRunId: string,
    isLive: boolean,
    graphId?: string,
    taskLabel: string = '任务对话',
  ): void {
    if (this.transcriptWindows.has(taskRunId)) {
      const existing = this.transcriptWindows.get(taskRunId);
      if (existing && !existing.isDestroyed()) {
        if (isLive) this.liveTranscriptRuns.add(taskRunId);
        if (!this.stayHidden) {
          existing.show();
          existing.focus();
        }
        return;
      }
      this.transcriptWindows.delete(taskRunId);
      this.transcriptGraphOwners.delete(taskRunId);
    }
    if (this.transcriptWindows.size >= MAX_TRANSCRIPT_WINDOWS) {
      this.logger.warn('Max transcript windows reached');
      return;
    }
    if (isLive) this.liveTranscriptRuns.add(taskRunId);
    if (graphId) this.transcriptGraphOwners.set(taskRunId, graphId);

    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea;
    const x = Math.round(workArea.x + (workArea.width - TRANSCRIPT_WIDTH) / 2);
    const y = Math.round(workArea.y + (workArea.height - TRANSCRIPT_HEIGHT) / 2);

    let win!: BrowserWindow;
    win = createTranscriptWindow({
      taskRunId,
      nodeId,
      taskLabel,
      bounds: { x, y },
      preloadPath: path.join(this.preloadDir, 'transcript.cjs'),
      stayHidden: this.stayHidden,
      pageLoader: this.pageLoader,
      attachAppearance: this.attachAppearance,
      onLoadFailure: () => {
        this.logger.warn(`transcript panel ${taskRunId} load failed`);
        if (!win.isDestroyed()) win.close();
      },
      onDidFinishLoad: () => {
        if (this.transcriptWindows.get(taskRunId) === win) void this.loadTranscriptPage(taskRunId);
      },
      onReady: () => {
        if (this.stayHidden) return;
        win.show();
        win.focus();
      },
      onClosed: () => {
        if (this.transcriptWindows.get(taskRunId) !== win) return;
        this.transcriptWindows.delete(taskRunId);
        this.transcriptGraphOwners.delete(taskRunId);
        this.stopTranscriptPolling(taskRunId);
        this.transcriptLoadGenerations.delete(taskRunId);
        this.liveTranscriptRuns.delete(taskRunId);
      },
    });

    this.transcriptWindows.set(taskRunId, win);
  }

  private async loadTranscriptPage(taskRunId: string, afterSeq?: number): Promise<void> {
    const expectedWin = this.transcriptWindows.get(taskRunId);
    if (!expectedWin || expectedWin.isDestroyed()) return;
    this.stopTranscriptPolling(taskRunId);
    const loadGeneration = ++this.transcriptLoadGeneration;
    this.transcriptLoadGenerations.set(taskRunId, loadGeneration);

    const isCurrent = (): boolean => (
      this.transcriptLoadGenerations.get(taskRunId) === loadGeneration
      && this.transcriptWindows.get(taskRunId) === expectedWin
      && !expectedWin.isDestroyed()
    );

    try {
      const result = await this.reader.loadTaskEvents(taskRunId, afterSeq);
      if (!isCurrent()) return;
      this.pushTranscriptData(taskRunId, result);

      if (result.has_more || this.liveTranscriptRuns.has(taskRunId)) {
        this.startTranscriptPolling(taskRunId, result.next_seq);
      }
    } catch (err) {
      if (!isCurrent()) return;
      this.logger.warn(`loadTranscriptPage error for ${taskRunId}:`, err);
      expectedWin.webContents.send('transcript:error', 'Failed to load events');
    }
  }

  private startTranscriptPolling(taskRunId: string, nextSeq?: number): void {
    const expectedWin = this.transcriptWindows.get(taskRunId);
    if (!expectedWin || expectedWin.isDestroyed()) return;

    this.transcriptPoller.start(
      taskRunId,
      async (pollIsCurrent) => {
        if (!pollIsCurrent() || this.transcriptWindows.get(taskRunId) !== expectedWin || expectedWin.isDestroyed()) {
          return false;
        }
        const result = await this.reader.loadTaskEvents(taskRunId, nextSeq);
        if (!pollIsCurrent() || this.transcriptWindows.get(taskRunId) !== expectedWin || expectedWin.isDestroyed()) {
          return false;
        }
        this.pushTranscriptData(taskRunId, result);
        nextSeq = result.next_seq;
        if (!result.has_more && !this.liveTranscriptRuns.has(taskRunId)) {
          return false;
        }
        if (!result.has_more) {
          const isTerminal = await this.reader.taskRunIsTerminal(taskRunId);
          if (!pollIsCurrent() || this.transcriptWindows.get(taskRunId) !== expectedWin || expectedWin.isDestroyed()) {
            return false;
          }
          if (isTerminal) {
            this.liveTranscriptRuns.delete(taskRunId);
            return false;
          }
        }
        return true;
      },
      (err) => {
        this.logger.warn(`transcript incremental poll error for ${taskRunId}:`, err);
      },
    );
  }

  private stopTranscriptPolling(key: string): void {
    this.transcriptPoller.stop(key);
  }

  private pushTranscriptData(taskRunId: string, data: import('../../shared/taskgraph').SafeTaskRunEventsResult): void {
    const win = this.transcriptWindows.get(taskRunId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(`transcript:data-${taskRunId}`, data);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Remove all IPC handlers registered by this owner
    ipcMain.removeHandler('entity:open-self');
    ipcMain.removeHandler('entity:set-mouse-passthrough');
    ipcMain.removeHandler('entity:get-state');
    ipcMain.removeHandler('slip:open-transcript');
    ipcMain.removeHandler('slip:report-content-size');
    ipcMain.removeHandler('slip:close');
    ipcMain.removeHandler('transcript:retry');
    ipcMain.removeHandler('transcript:close');
    ipcMain.removeListener('entity:drag-start', this.handleEntityDragStart);
    ipcMain.removeListener('entity:drag-move', this.handleEntityDragMove);
    ipcMain.removeListener('entity:drag-end', this.handleEntityDragEnd);
    this.entityDrag = null;
    this.transcriptPoller.stopAll();
    this.transcriptLoadGenerations.clear();

    for (const [id, timer] of this.entityExitTimers) {
      clearTimeout(timer);
    }
    this.entityExitTimers.clear();

    for (const [id, entity] of this.entities) {
      if (!entity.window.isDestroyed()) entity.window.destroy();
    }
    this.entities.clear();

    for (const [id, slip] of this.graphSlips) {
      if (slip.initialSizeWaitTimer) clearTimeout(slip.initialSizeWaitTimer);
      if (!slip.window.isDestroyed()) slip.window.destroy();
    }
    this.graphSlips.clear();

    for (const [key, win] of this.transcriptWindows) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.transcriptWindows.clear();
    this.transcriptGraphOwners.clear();
    this.liveTranscriptRuns.clear();
    this.structureCache.clear();
    this.structureLoads.clear();
    this.onCleanup?.();
  }
}

/**
 * The narrow external surface of the TaskGraph window owner. Desktop main
 * wires this handle and never constructs the owner directly, so the concrete
 * class stays private to the Pet module.
 */
export interface TaskGraphWindowsHandle {
  applyActivity(presence: ActivityPresence): void;
  reconnect(): void;
  getTrackedTaskgraphIds(): string[];
  setEntitiesVisible(visible: boolean): void;
  openTaskTranscript(taskRunId: string): Promise<void>;
  openTaskGraph(taskGraphId: string): Promise<void>;
  destroy(): void;
}

/** Factory for the shared TaskGraph window owner (see the Pet controller). */
export function createTaskGraphWindows(options: TaskGraphWindowOwnerOptions): TaskGraphWindowsHandle {
  return new TaskGraphWindowOwner(options);
}

/**
 * Revision-safe avatar fact-slip counts from the cached static structure plus
 * the single activity presence. `total` counts structure nodes whose
 * action.type === 'task' only — start/end/condition/checkpoint/convert/join/
 * fanout and unknown controls are excluded even when their node state is done.
 * `done` counts those task nodes whose activity presence state === 'done'.
 * Graph-level node_counts are never used.
 */
export function countDoneTaskNodes(
  structure: TaskGraphInspectResult,
  graph: ActivityTaskGraphPresence,
): { done: number; total: number } {
  const presenceState = new Map(graph.nodes.map((node) => [node.nodeId, node.state]));
  let total = 0;
  let done = 0;
  for (const node of Object.values(structure.graph.nodes)) {
    if (node.action.type !== 'task') continue;
    total += 1;
    if (presenceState.get(node.id) === 'done') done += 1;
  }
  return { done, total };
}
