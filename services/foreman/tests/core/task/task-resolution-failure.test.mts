import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CATALOG_EXCLUSION_CODE_MAP,
  TASK_RESOLUTION_FAILURE_CODES,
  TASK_RESOLUTION_FAILURE_MESSAGES,
  codeFromCatalogExclusion,
  selectTaskResolutionFailure,
  taskResolutionFailure,
  type TaskResolutionElimination,
} from '../../../lib/core/task/task-resolution-failure.mts'

describe('task resolution failure closed contract', () => {
  it('exposes exactly the six public codes in stable order', () => {
    assert.deepEqual(TASK_RESOLUTION_FAILURE_CODES, [
      'no_available_provider',
      'price_limit',
      'intelligence_requirement',
      'speed_requirement',
      'quota_unavailable',
      'quota_insufficient',
    ])
  })

  it('pins every exact Chinese message', () => {
    assert.deepEqual(TASK_RESOLUTION_FAILURE_MESSAGES, {
      no_available_provider: '没有可用的服务商，请检查登录或凭据',
      price_limit: '允许价格内没有可用模型，请调整价格上限',
      intelligence_requirement: '没有模型满足智能要求，请调整智能要求',
      speed_requirement: '没有模型满足速度要求，请调整速度要求',
      quota_unavailable: '模型额度不可用，请检查额度状态',
      quota_insufficient: '模型额度不足，请等待额度恢复',
    })
    // Raw English diagnostic fragments never appear inside user-facing copy.
    // The codes are intentional English machine identifiers and JSON stringify
    // wraps the map keys, so assert each fragment against the message values
    // only, never against the whole serialized map.
    for (const message of Object.values(TASK_RESOLUTION_FAILURE_MESSAGES)) {
      for (const fragment of [
        'no eligible',
        'provider',
        'model',
        'quota',
        'price',
        'cap',
        'tps',
        'reference',
        'credential',
        'token',
        'error',
      ]) {
        assert.equal(message.includes(fragment), false, `leaks raw fragment '${fragment}'`)
      }
    }
  })

  it('builds failures through the closed code-to-message construction', () => {
    assert.deepEqual(taskResolutionFailure('quota_unavailable'), {
      code: 'quota_unavailable',
      message: '模型额度不可用，请检查额度状态',
    })
    assert.deepEqual(taskResolutionFailure('quota_insufficient'), {
      code: 'quota_insufficient',
      message: '模型额度不足，请等待额度恢复',
    })
  })
})

describe('task resolution failure catalog exclusion mapping', () => {
  it('maps real auto-routing exclusion reasons to the closed code set', () => {
    assert.equal(CATALOG_EXCLUSION_CODE_MAP['reference_above_cap'], 'price_limit')
    assert.equal(CATALOG_EXCLUSION_CODE_MAP['marginal_above_reference'], 'price_limit')
    assert.equal(CATALOG_EXCLUSION_CODE_MAP['speed_below_minimum'], 'speed_requirement')
    assert.equal(CATALOG_EXCLUSION_CODE_MAP['intelligence_out_of_range'], 'intelligence_requirement')
    assert.equal(CATALOG_EXCLUSION_CODE_MAP['quota_blocked'], 'quota_unavailable')
  })

  it('no longer maps the obsolete reference_price_gate', () => {
    // Unknown/incomplete quota is neutral regardless of listed price: there is
    // no reference-price gate exclusion reason left to classify.
    assert.equal(CATALOG_EXCLUSION_CODE_MAP['reference_price_gate'], undefined)
    assert.equal(codeFromCatalogExclusion('reference_price_gate'), undefined)
  })

  it('maps quota_blocked to quota_unavailable', () => {
    assert.equal(codeFromCatalogExclusion('quota_blocked'), 'quota_unavailable')
  })

  it('does not invent quota eliminations for unknown or strained quota states', () => {
    // Unknown/strained/incomplete quota are not hard eliminations and must not
    // classify as quota_unavailable or quota_insufficient.
    assert.equal(codeFromCatalogExclusion('quota_unknown'), undefined)
    assert.equal(codeFromCatalogExclusion('quota_incomplete'), undefined)
    assert.equal(codeFromCatalogExclusion('quota_strained'), undefined)
    assert.equal(codeFromCatalogExclusion('quota_headroom_unknown'), undefined)
  })

  it('returns undefined for unknown exclusion reasons', () => {
    assert.equal(codeFromCatalogExclusion('something_unexpected'), undefined)
  })
})

describe('task resolution failure deterministic mixed selection', () => {
  const all: TaskResolutionElimination[] = [
    { code: 'intelligence_requirement', priceUsdPerMillion: 30 },
    { code: 'price_limit', priceUsdPerMillion: 8 },
    { code: 'speed_requirement', priceUsdPerMillion: 12 },
    { code: 'quota_unavailable', priceUsdPerMillion: 4 },
  ]

  it('prefers the elimination of the routing-most-relevant candidate regardless of input order', () => {
    const shuffled: TaskResolutionElimination[][] = [
      [...all],
      [...all].reverse(),
      [all[2] as TaskResolutionElimination, all[0] as TaskResolutionElimination,
        all[3] as TaskResolutionElimination, all[1] as TaskResolutionElimination],
    ]
    for (const eliminations of shuffled) {
      assert.deepEqual(selectTaskResolutionFailure(eliminations), taskResolutionFailure('quota_unavailable'))
    }
  })

  it('applies the fixed stable code tie-break when bounded prices tie', () => {
    const tied: TaskResolutionElimination[] = [
      { code: 'speed_requirement', priceUsdPerMillion: 10 },
      { code: 'price_limit', priceUsdPerMillion: 10 },
      { code: 'intelligence_requirement', priceUsdPerMillion: 10 },
    ]
    // price_limit precedes intelligence_requirement/speed_requirement in the
    // fixed code order, and the winner is the same regardless of shuffle.
    for (const order of [[...tied], [...tied].reverse()]) {
      assert.deepEqual(selectTaskResolutionFailure(order), taskResolutionFailure('price_limit'))
    }
  })

  it('ranks candidates without a bounded price below priced candidates', () => {
    const unpriced: TaskResolutionElimination[] = [
      { code: 'no_available_provider' },
      { code: 'price_limit', priceUsdPerMillion: 3 },
    ]
    assert.deepEqual(selectTaskResolutionFailure(unpriced), taskResolutionFailure('price_limit'))
    assert.deepEqual(selectTaskResolutionFailure([{ code: 'no_available_provider' }]), taskResolutionFailure('no_available_provider'))
  })

  it('returns undefined when no structured elimination exists', () => {
    assert.equal(selectTaskResolutionFailure([]), undefined)
  })
})

describe('task resolution failure no-leakage boundary', () => {
  it('serialized failure objects contain only the closed code and Chinese message', () => {
    for (const code of TASK_RESOLUTION_FAILURE_CODES) {
      const failure = taskResolutionFailure(code)
      assert.deepEqual(Object.keys(failure).sort(), ['code', 'message'])
      const serialized = JSON.stringify(failure)
      // The code value is an intentional English machine identifier and JSON
      // syntax itself carries colons/quotes/braces, so scan only for the
      // diagnostic content closed copy must never embed: raw exception text,
      // task names, canonical provider/model:client ids, numeric
      // price/TPS/score fields, the -ioa suffix, and token/authorization/
      // secret fixture values.
      for (const fragment of [
        'gpt',
        'claude',
        'codex',
        'deepseek',
        'openai',
        'codebuddy',
        'cb:',
        '-ioa',
        'token',
        'authorization',
        'secret',
        'error',
        'taskName',
        '$',
        'tps',
        'score',
      ]) {
        assert.equal(serialized.includes(fragment), false, `code '${code}' leaks '${fragment}'`)
      }
      // No numeric price/TPS/score payload rides on the closed object.
      assert.doesNotMatch(serialized, /\d/u)
    }
  })

  it('never serializes raw English in messages', () => {
    for (const message of Object.values(TASK_RESOLUTION_FAILURE_MESSAGES)) {
      assert.match(message, /[\u4e00-\u9fff]/)
    }
  })
})
