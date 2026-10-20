import type { RpcMethod } from '../common/methods.ts'
import type {
  CleanupPreviewParams,
  CleanupPreviewResult,
  CleanupRunParams,
  CleanupRunResult,
  StorageUsageParams,
  StorageUsageResult,
} from './types.ts'

export interface StorageMethods {
  'storage.usage': RpcMethod<StorageUsageParams, StorageUsageResult>
  'storage.cleanup.preview': RpcMethod<CleanupPreviewParams, CleanupPreviewResult>
  'storage.cleanup.run': RpcMethod<CleanupRunParams, CleanupRunResult>
}
