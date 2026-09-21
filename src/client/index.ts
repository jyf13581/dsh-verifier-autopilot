import { MODEL_OPTIONS, type SelectionView, type SelectionsListResponse, type State } from '../protocol.js'

declare const require: (name: string) => any

type SlotsService = { inject(name: string, callback: () => void | (() => void)): void; register(options: any, component: any): () => void }
type SettingsValue = { enabled?: boolean; autoFeedback?: boolean; model?: string; selectionMode?: 'off' | 'auto' | 'always'; selectionModelStrategy?: 'quality-first' | 'exploration' }
type SettingsScope = { getSnapshot(): { value?: SettingsValue; status?: string }; subscribe(listener: () => void): () => void; set(field: string, value: unknown): Promise<void> }
type SettingsBinder = { bind(spec: { namespace: string }): SettingsScope }
type ClientContext = { slots: SlotsService; get(name: string): unknown; settingsScope?: SettingsBinder }

type ReactApi = {
  createElement: (type: any, props?: Record<string, any> | null, ...children: any[]) => any
  useEffect: (effect: () => void | (() => void), deps?: any[]) => void
  useState: <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void]
}
const { createElement: h, useEffect, useState } = require('react') as ReactApi

export const inject = ['slots', 'sessions', 'settingsScope']
const API = '/@dsh-external/dsh-verifier-autopilot/api'
const SETTINGS_NAMESPACE = 'dsh-verifier-autopilot'
const panelStyle = { padding: 12, display: 'grid', gap: 8, fontSize: 12, borderTop: '1px solid var(--border-color, #ddd)' }
const rowStyle = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }

function Checkbox(props: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }): any {
  return h('label', { style: { display: 'flex', alignItems: 'center', gap: 5, opacity: props.disabled ? 0.65 : 1 } }, h('input', { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: props.onChange }), props.label)
}

const EFFORT_OPTIONS: Array<'off' | 'low' | 'high' | 'max'> = ['off', 'low', 'high', 'max']
const tinyInputStyle = { fontSize: 12, width: 46, padding: '2px 4px' }
const wideInputStyle = { fontSize: 12, flex: 1, minWidth: 120, padding: '2px 4px' }

/** Enforced-integer config input: invalid or out-of-range entries are ignored,
 *  extremes are clamped before committing. */
function NumberField(props: { value: number; min: number; max: number; disabled?: boolean; title?: string; onCommit: (next: number) => void }): any {
  const commit = (raw: string): void => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    const clamped = Math.max(props.min, Math.min(props.max, Math.round(parsed)))
    if (clamped !== props.value) props.onCommit(clamped)
  }
  return h('input', {
    type: 'number', min: props.min, max: props.max, step: 1, value: props.value, disabled: props.disabled, title: props.title,
    style: tinyInputStyle,
    onChange: (ev: any) => commit(String(ev.target?.value ?? '')),
  })
}

function EffortSelect(props: { value: string; disabled?: boolean; onCommit: (next: 'off' | 'low' | 'high' | 'max') => void }): any {
  return h('select', {
    value: props.value, disabled: props.disabled, title: '验证器思考强度（verifier thinking effort）',
    onChange: (ev: any) => { const next = String(ev.target.value ?? '') as 'off' | 'low' | 'high' | 'max'; if (EFFORT_OPTIONS.includes(next)) props.onCommit(next) },
    style: { fontSize: 12 },
  }, ...EFFORT_OPTIONS.map(option => h('option', { key: option, value: option }, option)))
}

function DurableSettingsPanel(props: { scope: SettingsScope }): any {
  const [snapshot, setSnapshot] = useState(props.scope.getSnapshot())
  const [error, setError] = useState('')
  // Phase 2 fallback: when the durable settings service is unavailable the
  // checkboxes mirror and drive the live Host config instead of showing
  // misleading "off" values.
  const [hostConfig, setHostConfig] = useState<SettingsValue>({})
  useEffect(() => props.scope.subscribe(() => setSnapshot(props.scope.getSnapshot())), [props.scope])
  useEffect(() => {
    let alive = true
    fetch(API + '/state').then(response => response.json() as Promise<State>).then(state => {
      if (alive && state.config) setHostConfig({ enabled: state.config.enabled === true, autoFeedback: state.config.autoFeedback === true })
    }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  const durableReady = snapshot.status === 'ready' && snapshot.value != null
  const value: SettingsValue = snapshot.value ?? hostConfig
  const update = async (field: string, next: boolean): Promise<void> => {
    setError('')
    try {
      if (durableReady) await props.scope.set(field, next)
      else {
        const response = await fetch(API + '/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [field]: next }) })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        setHostConfig(previous => ({ ...previous, [field]: next }))
      }
    } catch (cause) { setError(String(cause).slice(0, 160)) }
  }
  return h('section', { style: { display: 'grid', gap: 8, padding: 12 } },
    h('strong', null, 'Verifier 自动验证'),
    Checkbox({ checked: value.enabled === true, onChange: () => { void update('enabled', value.enabled !== true) }, label: '自动验证' }),
    Checkbox({ checked: value.autoFeedback === true, onChange: () => { void update('autoFeedback', value.autoFeedback !== true) }, label: '低分时请求 Agent 复查' }),
    h('small', null, durableReady ? '设置已由 Host 持久化' : '设置服务不可用——当前直接读写 Host 运行配置'),
    error ? h('small', { style: { color: 'var(--danger-color, #b42318)' } }, '保存失败: ' + error) : null,
  )
}


const STAGE_LABELS: Record<string, string> = {
  workspace: '工作区快照', preflight: '验证器预检', rollout: '候选执行', checks: '客观检查', ranking: '比较排序', settled: '结算',
}

function SelectionPanel(props: { sessionId?: string; settingsScope?: SettingsScope }): any {
  const [data, setData] = useState<SelectionsListResponse | null>(null)
  const [hostState, setHostState] = useState<State | null>(null)
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      const [selectionResponse, stateResponse] = await Promise.all([fetch(API + '/selections'), fetch(API + '/state')])
      if (!selectionResponse.ok || !stateResponse.ok) throw new Error('HTTP ' + (!selectionResponse.ok ? selectionResponse.status : stateResponse.status))
      setData(await selectionResponse.json() as SelectionsListResponse)
      setHostState(await stateResponse.json() as State)
      setStatus('')
    } catch (error) {
      setStatus('状态读取失败: ' + String(error).slice(0, 100))
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  const post = async (path: string, body: Record<string, unknown>): Promise<boolean> => {
    const response = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      setStatus(path + ' 失败: HTTP ' + response.status + ' ' + text.slice(0, 120))
      return false
    }
    return true
  }

  const saveConfig = async (field: string, value: string | number): Promise<void> => {
    setSaving(true)
    setStatus('保存中...')
    try {
      if (props.settingsScope) await props.settingsScope.set(field, value)
      else if (!await post('/config', { [field]: value })) return
      setHostState(previous => previous
        ? ({ ...previous, config: { ...previous.config, [field]: value } } as State)
        : previous)
      setStatus('')
    } catch (error) {
      setStatus('保存失败: ' + String(error).slice(0, 120))
    } finally { setSaving(false) }
  }

  const config = hostState?.config
  const mode = config?.selectionMode ?? 'auto'
  const modelStrategy = config?.selectionModelStrategy ?? 'quality-first'
  const selectionRows = (data?.selections ?? []).slice(0, 8).map((selection) => {
    const candidateLine = (selection.candidates ?? []).map((candidate) => {
      const model = candidate.agentOptions?.model ? ' · ' + candidate.agentOptions.model : ''
      const detail = candidate.error ? ' · ' + candidate.error.slice(0, 64) : ''
      return 'c' + candidate.index + '  ' + candidate.status + model + detail
    }).join('\n')
    const usage = selection.usage
    const usageLine = usage
      ? (usage.calls ?? 0) + ' calls · ' + (usage.input_tokens ?? 0).toLocaleString() + ' in · ' + (usage.cached_input_tokens ?? 0).toLocaleString() + ' cached · ' + (usage.output_tokens ?? 0).toLocaleString() + ' out'
      : ''
    const policy = selection.policy
    const policyLine = policy
      ? (policy.depth ?? 'standard') + ' · ' + (policy.modelStrategy ?? 'legacy') + ' · N=' + (policy.candidateCount ?? '?') + ' · K=' + (policy.nEvaluations ?? '?') + (policy.pivots === undefined ? '' : ' · P=' + policy.pivots) + (policy.verifierEffort ? ' · 强度=' + policy.verifierEffort : '') + ' · ' + (policy.models ?? []).join(' / ')
      : (selection.trigger === 'manual' ? '诊断手动运行' : '')
    const winner = selection.winner
    const fallback = selection.fallback
    const slot = winner ?? fallback
    return h('article', { key: selection.selectionId, style: { display: 'grid', gap: 5, padding: '9px 0', borderTop: '1px solid var(--border-color, #ddd)' } },
      h('div', { style: { ...rowStyle, justifyContent: 'space-between' } },
        h('strong', { style: { fontSize: 12 } }, selection.selectionId.slice(0, 12) + ' · ' + selection.status),
        h('span', null, selection.stage ? (STAGE_LABELS[selection.stage] ?? selection.stage) : ''),
        selection.status === 'running' ? h('button', { type: 'button', disabled: saving, onClick: () => { void post('/selections/cancel', { selectionId: selection.selectionId }).then(refresh) } }, '取消') : null),
      selection.outcome ? h('div', { style: { color: selection.outcome === 'ranked_winner' ? 'var(--ok-color, #067647)' : 'var(--muted-color, #666)' } }, '结果 · ' + selection.outcome + (selection.noSearchSpace ? '（无搜索空间，已去重）' : '') + (selection.llmOnly ? '（仅 LLM 信号）' : '')) : null,
      selection.margin !== undefined ? h('div', { style: { color: 'var(--muted-color, #666)' } }, 'margin ' + selection.margin.toFixed(4) + ' / 阈值 ' + (selection.marginThreshold ?? '?') + (selection.marginProvisional ? '（临时未校准）' : '')) : null,
      policyLine ? h('div', { style: { color: 'var(--muted-color, #666)' } }, policyLine) : null,
      candidateLine ? h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 11 } }, candidateLine) : null,
      typeof selection.nComparisons === 'number' ? h('div', null, selection.nComparisons + ' 次比较' + (usageLine ? ' · ' + usageLine : '')) : null,
      (selection.rankingAttempts ?? 0) > 1 ? h('div', { style: { color: 'var(--muted-color, #666)' } }, '验证器尝试 ' + selection.rankingAttempts + ' 次 · 瞬时错误重试 ' + (selection.rankingRetryErrors?.length ?? 0) + ' 次') : null,
      selection.winnerBasis ? h('div', { style: { color: 'var(--muted-color, #666)' } }, '胜者依据 · ' + selection.winnerBasis + (selection.outcome && selection.outcome !== 'ranked_winner' ? '（非选优）' : '')) : null,
      selection.outcome ? h('div', { style: { color: 'var(--muted-color, #666)' } }, '审计包 · .data/selection-artifacts/' + selection.selectionId + '/（record.json + traces + diffs）' + (selection.delivery ? ' · 交付审计 delivered=' + selection.delivery.delivered : '')) : null,
      selection.error ? h('div', { style: { color: 'var(--danger-color, #b42318)' } }, selection.error) : null,
      slot ? h('div', { style: rowStyle },
        h('span', null, slot.discardedAt ? (winner ? 'winner' : 'fallback') + ' c' + slot.index + ' 已清理' : (winner ? 'winner' : 'fallback（未经候选间比较）') + ' c' + slot.index + ' · ' + slot.workspace),
        !slot.discardedAt && selection.trigger !== 'autopilot' ? h('button', { type: 'button', onClick: () => { void post('/selections/discard', { selectionId: selection.selectionId }).then(refresh) } }, '清理') : null,
      ) : null,
    )
  })

  const modes: Array<{ id: 'off' | 'auto' | 'always'; label: string }> = [
    { id: 'off', label: '关闭' }, { id: 'auto', label: '智能' }, { id: 'always', label: '总是' },
  ]
  return h('section', { style: panelStyle },
    h('div', { style: { ...rowStyle, justifyContent: 'space-between' } },
      h('strong', null, '候选控制'),
      h('span', null, data?.active ? '运行中' : '空闲')),
    h('div', { role: 'group', 'aria-label': '候选控制模式', style: { display: 'flex', width: 'fit-content', border: '1px solid var(--border-color, #ccc)', borderRadius: 6, overflow: 'hidden' } },
      ...modes.map((item) => h('button', {
        key: item.id, type: 'button', disabled: saving, 'aria-pressed': mode === item.id,
        onClick: () => { void saveConfig('selectionMode', item.id) },
        style: { border: 0, borderRight: item.id === 'always' ? 0 : '1px solid var(--border-color, #ccc)', borderRadius: 0, padding: '5px 12px', background: mode === item.id ? 'var(--accent-bg, #e8eef8)' : 'transparent' },
      }, item.label))),
    h('div', { role: 'group', 'aria-label': '候选模型策略', style: { display: 'flex', width: 'fit-content', border: '1px solid var(--border-color, #ccc)', borderRadius: 6, overflow: 'hidden' } },
      h('button', { type: 'button', disabled: saving, 'aria-pressed': modelStrategy === 'quality-first', onClick: () => { void saveConfig('selectionModelStrategy', 'quality-first') }, style: { border: 0, borderRight: '1px solid var(--border-color, #ccc)', borderRadius: 0, padding: '5px 12px', background: modelStrategy === 'quality-first' ? 'var(--accent-bg, #e8eef8)' : 'transparent' } }, '质量优先'),
      h('button', { type: 'button', disabled: saving, 'aria-pressed': modelStrategy === 'exploration', onClick: () => { void saveConfig('selectionModelStrategy', 'exploration') }, style: { border: 0, borderRadius: 0, padding: '5px 12px', background: modelStrategy === 'exploration' ? 'var(--accent-bg, #e8eef8)' : 'transparent' } }, '异质探索')),
    h('div', { style: rowStyle },
      h('span', null, '普通 N'),
      h(NumberField, { value: config?.selectionStandardCandidates ?? 2, min: 2, max: 5, disabled: saving, title: '标准档候选数（并发 rollout 数）', onCommit: (n: number) => { void saveConfig('selectionStandardCandidates', n) } }),
      h('span', null, '深档 N'),
      h(NumberField, { value: config?.selectionDeepCandidates ?? 3, min: 2, max: 5, disabled: saving, title: '深档候选数（并发 rollout 数）', onCommit: (n: number) => { void saveConfig('selectionDeepCandidates', n) } }),
      h('span', null, '评估轮数 K'),
      h(NumberField, { value: config?.selectionEvaluations ?? 1, min: 1, max: 8, disabled: saving, title: '每条准则的重复评估轮数（n_evaluations）', onCommit: (n: number) => { void saveConfig('selectionEvaluations', n) } }),
      h('span', null, '枢轴迭代 P'),
      h(NumberField, { value: config?.selectionPivots ?? 0, min: 0, max: 5, disabled: saving, title: '枢轴轮迭代数（pivots，按幸存者数自动收敛，成本 O(N·P)）', onCommit: (n: number) => { void saveConfig('selectionPivots', n) } })),
    h('div', { style: rowStyle },
      h('span', null, '思考强度'),
      h(EffortSelect, { value: config?.verifierEffort ?? 'low', disabled: saving, onCommit: (v: 'off' | 'low' | 'high' | 'max') => { void saveConfig('verifierEffort', v) } }),
      h('span', null, '噪声阈值'),
      h('input', {
        type: 'number', min: 0, max: 0.5, step: 0.005, value: config?.selectionMarginThreshold ?? 0.03, disabled: saving, style: tinyInputStyle,
        title: 'top-2 margin 噪声门限：低于它一律 abstain（0.03 = 校准首轮 C0 噪声上限的 2.2 倍，暂标 temporary）',
        onChange: (ev: any) => { const v = Number(String(ev.target?.value ?? '')); if (Number.isFinite(v)) void saveConfig('selectionMarginThreshold', Math.max(0, Math.min(0.5, v))) },
      }),
      h('span', null, 'provider'),
      h('input', {
        value: config?.selectionProvider ?? 'kimi', disabled: saving, style: tinyInputStyle, title: '候选 provider 名',
        onChange: (ev: any) => { const v = String(ev.target.value ?? '').trim(); if (v && v !== (config?.selectionProvider ?? 'kimi')) void saveConfig('selectionProvider', v) },
      })),
    h('div', { style: rowStyle },
      h('span', null, '候选模型池'),
      h('input', {
        key: 'models-' + (config?.selectionModels ?? ''), defaultValue: config?.selectionModels ?? '', disabled: saving, style: wideInputStyle, title: '逗号分隔，按质量从高到低（quality-first 时全部候选用第一名）',
        onBlur: (ev: any) => { const v = String(ev.target.value ?? '').trim(); if (v && v !== config?.selectionModels) void saveConfig('selectionModels', v) },
        onKeyDown: (ev: any) => { if (ev.key === 'Enter') ev.target.blur() },
      })),
    config?.selectionModels ? h('div', { style: { color: 'var(--muted-color, #666)', overflowWrap: 'anywhere' } }, '质量顺序 · ' + config.selectionModels.split(',').map((m: string) => m.trim()).filter(Boolean).join(' · ')) : null,
    selectionRows.length ? selectionRows : h('div', null, '尚无候选运行记录'),
    status ? h('div', { style: { whiteSpace: 'pre-wrap', color: status.includes('失败') ? 'var(--danger-color, #b42318)' : undefined } }, status) : null,
  )
}

function VerifierPanel(props: { sessionId?: string; settingsScope?: SettingsScope }): any {
  const [state, setState] = useState<State | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [autoFeedback, setAutoFeedback] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

  const refresh = async (): Promise<State | undefined> => {
    try {
      const response = await fetch(API + '/state')
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const next = await response.json() as State
      setState(next)
      setEnabled(next.config?.enabled === true)
      setAutoFeedback(next.config?.autoFeedback === true)
      setStatus('')
      return next
    } catch (error) {
      setStatus('Host 未连接: ' + String(error).slice(0, 120))
      return undefined
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const savePatch = async (patch: Record<string, unknown>): Promise<void> => {
    setSaving(true)
    setStatus('保存中...')
    try {
      const scope = props.settingsScope
      const scopeSnapshot = scope?.getSnapshot()
      const durableReady = scopeSnapshot?.status === 'ready' && scopeSnapshot.value != null
      if (scope && durableReady) {
        // SettingsScope exposes field writes; serialize the fields so each
        // committed snapshot is observed by the Host in a known order.
        for (const [field, value] of Object.entries(patch)) await scope.set(field, value)
      } else {
        const response = await fetch(API + '/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string }
        if (!response.ok || result.ok !== true) throw new Error(result.error ?? 'HTTP ' + response.status)
      }
      const nextState = await refresh()
      const actual = nextState?.config as Record<string, unknown> | undefined
      const mismatch = Object.entries(patch).find(([field, value]) => actual?.[field] !== value)
      if (mismatch) throw new Error('配置未生效: ' + mismatch[0])
    } catch (error) {
      setStatus('保存失败: ' + String(error).slice(0, 120))
    } finally {
      setSaving(false)
    }
  }

  const verify = async (): Promise<void> => {
    if (!props.sessionId) { setStatus('当前没有可验证的会话'); return }
    setBusy(true)
    setStatus('五路验证中...')
    try {
      const response = await fetch(API + '/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: props.sessionId }) })
      const result = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || !result.ok) throw new Error(result.error ?? 'HTTP ' + response.status)
      await refresh()
    } catch (error) {
      setStatus('验证失败: ' + String(error).slice(0, 160))
    } finally {
      setBusy(false)
    }
  }

  const records = state?.records ?? []
  const lines: string[] = []
  for (const record of records.slice(0, 3)) {
    const score = record.aggregate?.score
    const median = record.aggregate?.median
    const dispersion = record.aggregate?.dispersion
    const confidence = record.aggregate?.confidence
    const valid = record.aggregate?.valid?.length
    const routeCount = state?.config?.routes
    const scoreText = typeof score === 'number' ? ' · mean ' + score.toFixed(2) : ''
    const medianText = typeof median === 'number' ? ' · median ' + median.toFixed(2) : ''
    const spreadText = typeof dispersion === 'number' ? ' · spread ' + dispersion.toFixed(2) : ''
    const confidenceText = confidence ? ' · confidence ' + confidence : ''
    const validText = typeof valid === 'number' ? ' · ' + valid + '/' + (routeCount ?? '?') : ''
    const guardedText = record.suppressedFeedback
      ? ' · 分歧触发已拦截 (median ' + Number(record.suppressedFeedback.median ?? 0).toFixed(2) + ', ' + record.suppressedFeedback.noDefectLanes + '/' + record.suppressedFeedback.validLanes + ' 路 no-defect)'
      : ''
    const evidenceText = record.feedbackSuppressed
      ? ' · feedback 已抑制（缺少独立工具证据）'
      : ''
    const audit = record.citationAudit
    const citationText = audit && audit.defectFindings
      ? ' · 引用 ' + ((audit.defectFindings ?? 0) - (audit.defectFindingsWithoutCitation ?? 0)) + '/' + audit.defectFindings
        + (audit.findingsWithoutIndependentCitation ? ' · 仅声明引用x' + audit.findingsWithoutIndependentCitation : '')
        + (audit.findingsCitingUnknownIds ? ' · 无效引用x' + audit.findingsCitingUnknownIds : '')
        + (audit.findingsCitingHistoricalVerdict ? ' · 引历史结论x' + audit.findingsCitingHistoricalVerdict : '')
      : ''
    lines.push('turn ' + record.turn + ' · ' + record.status + (record.skippedReason ? ' · 跳过(' + record.skippedReason + ')' : '') + scoreText + citationText + medianText + spreadText + confidenceText + validText + guardedText + evidenceText + (record.feedbackSent ? ' · feedback queued' : '') + (record.error ? ' · ' + record.error : '') + (record.feedbackError ? ' · feedback error: ' + record.feedbackError : ''))
    // Per-lane diagnostics: finding, error code, retry flag, source and duration.
    for (const lane of (record.aggregate?.results ?? []).slice(0, 5)) {
      const name = 'L' + (lane.route ?? '?') + '/' + (lane.lane ?? '?')
      if (lane.ok) {
        lines.push('    ✓ ' + name + ' · score ' + (typeof lane.score === 'number' ? lane.score.toFixed(2) : '?') + (lane.scoreSource ? ' (' + lane.scoreSource + ')' : '') + ' · ' + (lane.durationMs ?? 0) + 'ms' + (lane.finding ? ' · ' + String(lane.finding).slice(0, 160) : ''))
      } else {
        lines.push('    ✗ ' + name + ' · ' + (lane.errorCode ?? 'invalid') + (lane.retried ? ' · 已重试' : '') + ' · ' + (lane.durationMs ?? 0) + 'ms' + (lane.error ? ' · ' + String(lane.error).slice(0, 120) : ''))
      }
    }
  }

  return h('section', { style: panelStyle },
    h('strong', null, 'Verifier 自动验证'),
    Checkbox({ checked: enabled, disabled: saving, onChange: () => { void savePatch({ enabled: !enabled }) }, label: '自动验证' }),
    Checkbox({ checked: autoFeedback, disabled: saving, onChange: () => { void savePatch({ autoFeedback: !autoFeedback }) }, label: '低分时请求 Agent 复查' }),
    h('div', { style: rowStyle },
      h('span', null, '验证模型:'),
      h('select', {
        value: MODEL_OPTIONS.some(option => option.id === state?.config?.model) ? (state?.config?.model ?? '') : '__custom__',
        disabled: saving,
        onChange: (ev: any) => {
          const next = String(ev.target.value ?? '')
          if (!next || next === '__custom__') return
          const opt = MODEL_OPTIONS.find(o => o.id === next)
          void savePatch(opt ? { baseURL: opt.baseURL, apiKeyEnv: opt.apiKeyEnv, model: next } : { model: next })
        },
        style: { fontSize: 12 },
      }, ...MODEL_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.id)), h('option', { value: '__custom__' }, '自定义…')),
      h('input', {
        value: state?.config?.model ?? '', disabled: saving, style: wideInputStyle, maxLength: 200,
        placeholder: '输入任意模型 ID', title: '自定义模型 ID；必须支持当前 Verifier 的标签/评分协议',
        onBlur: (ev: any) => {
          const next = String(ev.target.value ?? '').trim()
          if (next && next !== state?.config?.model) void savePatch({ model: next })
        },
        onKeyDown: (ev: any) => { if (ev.key === 'Enter') ev.currentTarget.blur() },
      }),
    ),
    h('small', null, MODEL_OPTIONS.find(option => option.id === state?.config?.model)?.note ?? '自定义模型：需自行确认 logprob/标签门禁'),
    h('div', { style: rowStyle },
      h('span', null, '验证轮数'),
      h(NumberField, { value: state?.config?.routes ?? 5, min: 1, max: 5, disabled: saving, title: '并行验证路数（lanes）', onCommit: (n: number) => { void savePatch({ routes: n }) } }),
      h('span', null, '思考强度'),
      h(EffortSelect, { value: state?.config?.verifierEffort ?? 'low', disabled: saving, onCommit: (v: 'off' | 'low' | 'high' | 'max') => { void savePatch({ verifierEffort: v }) } }),
      h('span', null, '输出上限'),
      h(NumberField, { value: state?.config?.maxTokens ?? 64000, min: 256, max: 65536, disabled: saving, title: '每路最大输出 token（思考会从该预算中扣除）', onCommit: (n: number) => { void savePatch({ maxTokens: n }) } })),
    h('div', { style: rowStyle },
      h('span', null, '锦标赛并发'),
      h(NumberField, { value: state?.config?.selectionVerifierWorkers ?? 0, min: 0, max: 16, disabled: saving, title: '排位锦标赛并发请求数（0=自动4）。中转站按请求轮询分号：并发请求摊到不同账号，单账号限速只卡它自己那一路；建议不超过号池大小', onCommit: (n: number) => { void savePatch({ selectionVerifierWorkers: n }) } }),
      h('span', null, '发送平滑(ms)'),
      h(NumberField, { value: state?.config?.verifierMinIntervalMs ?? 0, min: 0, max: 60000, disabled: saving, title: '验证请求发送的最小间隔（令牌桶平滑，0=关闭）。把并发摊匀，避免突发打满限额', onCommit: (n: number) => { void savePatch({ verifierMinIntervalMs: n }) } }),
      h('span', null, '小模型'),
      h('input', {
        value: state?.config?.verifierSmallModel ?? '', disabled: saving, style: wideInputStyle, maxLength: 200,
        placeholder: '留空=全部用主模型', title: '分层小模型：completion/evidence 这类机械 lane 改用它（如 nvidia/nemotron-3-ultra-550b-a55b）；难 lane 与锦标赛仍用主模型',
        onBlur: (ev: any) => {
          const next = String(ev.target.value ?? '').trim()
          if (next !== (state?.config?.verifierSmallModel ?? '')) void savePatch({ verifierSmallModel: next })
        },
        onKeyDown: (ev: any) => { if (ev.key === 'Enter') ev.currentTarget.blur() },
      })),
    h('div', { style: rowStyle },
      h('button', { type: 'button', disabled: busy || saving, onClick: () => { void verify() } }, busy ? '验证中...' : '验证当前会话'),
      h('span', null, props.sessionId ? '当前会话已选' : '无当前会话'),
    ),
    h('div', { style: { whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' } }, lines.length ? lines.join('\n') : (status || '尚无验证记录')),
  )
}

export function apply(ctx: ClientContext): void {
  const settingsProvider = (ctx.get('webUiSettings') ?? ctx.settingsScope) as SettingsBinder | undefined
  const settingsScope = settingsProvider?.bind({ namespace: SETTINGS_NAMESPACE })
  if (settingsScope) {
    ctx.slots.inject('web-ui.plugin.item', () => ctx.slots.register({
      name: 'web-ui.plugin.item',
      id: '@dsh-external/dsh-verifier-autopilot-settings',
      order: 115,
      label: 'Verifier',
    }, () => h(DurableSettingsPanel, { scope: settingsScope })))
  }
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: '@dsh-external/dsh-verifier-autopilot-panel',
    label: () => 'Verifier',
  }, (props: { sessionId?: string }) => h(VerifierPanel, { ...props, settingsScope })))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: '@dsh-external/dsh-verifier-autopilot-selection',
    label: () => '候选控制',
  }, (props: { sessionId?: string }) => h(SelectionPanel, { ...props, settingsScope })))
}
