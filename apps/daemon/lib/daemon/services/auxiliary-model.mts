import type { AuxiliaryRoute } from '@wrenyard/session'
import type { ForemanServiceConfig } from '../../config/index.mts'

/** The config fields one auxiliary model resolution reads. */
export type AuxiliaryModelConfig = Pick<ForemanServiceConfig, 'endpoint' | 'models'>

/**
 * The one model an auxiliary call uses. A configured standard endpoint names it
 * in `models.auxiliary`, and that id is sent unchanged; without an endpoint the
 * built-in gateway's ranked route selection decides, and its first route is the
 * one model.
 */
export async function resolveAuxiliaryModel(
  config: AuxiliaryModelConfig,
  selectRoutes: () => Promise<readonly AuxiliaryRoute[]>,
): Promise<AuxiliaryRoute> {
  if (config.endpoint !== undefined) {
    const auxiliary = config.models?.auxiliary
    if (auxiliary === undefined) {
      throw new Error('The configured endpoint requires models.auxiliary')
    }
    return auxiliary
  }
  const routes = await selectRoutes()
  const route = routes[0]
  if (route === undefined) throw new Error('Auxiliary model: no candidate qualified')
  return route
}
