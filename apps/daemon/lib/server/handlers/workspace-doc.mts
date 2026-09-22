/**
 * Workspace doc handler — server-side protocol adapter.
 *
 * Registers workspace.doc.* RPC handlers that delegate to an injected
 * WorkspaceDocHandlerService. The service provides the filesystem authority;
 * this module has no node:fs/node:path imports.
 */

import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type { WorkspaceDocListResult, WorkspaceDocReadResult, WorkspaceDocCreateResult, WorkspaceDocUpdateResult } from '../../protocol/methods/workspace-doc.mts'
import type { RpcRouter } from '../rpc-router.mts'

export interface WorkspaceDocHandlerService {
  list(params: { directory?: string }): Promise<WorkspaceDocListResult>
  read(params: { path: string }): Promise<WorkspaceDocReadResult>
  create(params: { path: string; content: string }): Promise<WorkspaceDocCreateResult>
  update(params: { path: string; content: string }): Promise<WorkspaceDocUpdateResult>
}

export function registerWorkspaceDocHandlers(router: RpcRouter, service?: WorkspaceDocHandlerService): void {
  if (!service) {
    const unavailable = () => {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'workspace doc service not available in this runtime' },
        { service: 'workspace.doc', code: 'workspace_doc_unavailable' },
      )
    }
    router.register('workspace.doc.list', unavailable)
    router.register('workspace.doc.read', unavailable)
    router.register('workspace.doc.create', unavailable)
    router.register('workspace.doc.update', unavailable)
    return
  }

  router.register('workspace.doc.list', async (params) => service.list(params))
  router.register('workspace.doc.read', async (params) => service.read(params))
  router.register('workspace.doc.create', async (params) => service.create(params))
  router.register('workspace.doc.update', async (params) => service.update(params))
}
