/**
 * Workspace doc handler — server-side protocol adapter.
 *
 * Registers workspace.doc.* RPC handlers that delegate to an injected
 * WorkspaceDocHandlerService. The service provides the document authority;
 * this module has no node:fs/node:path imports.
 */

import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type {
  WorkspaceDocListParams, WorkspaceDocListResult,
  WorkspaceDocReadParams, WorkspaceDocReadResult,
  WorkspaceDocCreateParams, WorkspaceDocCreateResult,
  WorkspaceDocUpdateParams, WorkspaceDocUpdateResult,
  WorkspaceDocEditParams,
  WorkspaceDocDeleteParams, WorkspaceDocDeleteResult,
} from '../../protocol/methods/workspace-doc.mts'
import type { RpcRouter } from '../rpc-router.mts'
import { mapServiceError } from './project.mts'

export interface WorkspaceDocHandlerService {
  listDocuments(params: WorkspaceDocListParams): Promise<WorkspaceDocListResult>
  readDocument(params: WorkspaceDocReadParams): Promise<WorkspaceDocReadResult>
  createDocument(params: WorkspaceDocCreateParams): Promise<WorkspaceDocCreateResult>
  updateDocument(params: WorkspaceDocUpdateParams): Promise<WorkspaceDocUpdateResult>
  editDocument(params: WorkspaceDocEditParams): Promise<WorkspaceDocUpdateResult>
  deleteDocument(params: WorkspaceDocDeleteParams): Promise<WorkspaceDocDeleteResult>
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
    router.register('workspace.doc.edit', unavailable)
    router.register('workspace.doc.delete', unavailable)
    return
  }

  // Every method surfaces a WorkspaceDocError.code through the shared
  // mapServiceError, so a rejection arrives as error data { service, code }
  // rather than an opaque INTERNAL_ERROR.
  router.register('workspace.doc.list', async (params) => {
    try {
      return await service.listDocuments(params)
    } catch (error) {
      throw mapServiceError(error, 'workspace-doc', 'doc_error')
    }
  })
  router.register('workspace.doc.read', async (params) => {
    try {
      return await service.readDocument(params)
    } catch (error) {
      throw mapServiceError(error, 'workspace-doc', 'doc_error')
    }
  })
  router.register('workspace.doc.create', async (params) => {
    try {
      return await service.createDocument(params)
    } catch (error) {
      throw mapServiceError(error, 'workspace-doc', 'doc_error')
    }
  })
  router.register('workspace.doc.update', async (params) => {
    try {
      return await service.updateDocument(params)
    } catch (error) {
      throw mapServiceError(error, 'workspace-doc', 'doc_error')
    }
  })
  router.register('workspace.doc.edit', async (params) => {
    try {
      return await service.editDocument(params)
    } catch (error) {
      throw mapServiceError(error, 'workspace-doc', 'doc_error')
    }
  })
  router.register('workspace.doc.delete', async (params) => {
    try {
      return await service.deleteDocument(params)
    } catch (error) {
      throw mapServiceError(error, 'workspace-doc', 'doc_error')
    }
  })
}
