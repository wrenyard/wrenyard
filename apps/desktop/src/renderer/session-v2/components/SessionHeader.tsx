import type { ModelEntry } from '../types.js';

interface Props {
  title: string;
  models: ModelEntry[];
  modelId: string;
  effort: string;
  showRaw: boolean;
  onModelChange(value: string): void;
  onEffortChange(value: string): void;
  onRawChange(value: boolean): void;
}

export function SessionHeader(props: Props) {
  const model = props.models.find((entry) => entry.publicId === props.modelId);
  return <header className="sv2-header">
    <strong className="sv2-title">{props.title}</strong>
    <select className="sv2-model" aria-label="模型" value={props.modelId}
      disabled={!props.models.length} onChange={(event) => props.onModelChange(event.target.value)}>
      {!props.models.length && <option value="">暂无可用模型</option>}
      {props.models.map((entry) => <option key={entry.publicId} value={entry.publicId}>
        {entry.displayName} · {entry.provider}
      </option>)}
    </select>
    <select className="sv2-effort" aria-label="推理强度" value={props.effort}
      onChange={(event) => props.onEffortChange(event.target.value)}>
      <option value="">默认推理强度</option>
      {model?.thinkingLevels?.map((level) => <option key={level} value={level}>{level}</option>)}
    </select>
    <label><input type="checkbox" checked={props.showRaw}
      onChange={(event) => props.onRawChange(event.target.checked)} /> 账本原文</label>
  </header>;
}
