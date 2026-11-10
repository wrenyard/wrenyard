const NAME_OK = /^[A-Za-z0-9_-]+$/u;
const NUL_ESCAPE = /\\\\|\\0(?![0-9])/gu;
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const SUB_ONE = [
  'items', 'additionalItems', 'unevaluatedItems', 'contains', 'not', 'if', 'then', 'else',
  'propertyNames', 'additionalProperties', 'unevaluatedProperties',
];
const SUB_LIST = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const SUB_MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];

export function safeToolName(name: string, taken: Set<string>): string {
  const base = String(name).replace(/[^A-Za-z0-9_-]/gu, '_') || 'tool';
  let candidate = base;
  for (let i = 2; taken.has(candidate); i += 1) candidate = `${base}_${i}`;
  taken.add(candidate);
  return candidate;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function fitEnum(schema: Record<string, unknown>): boolean {
  if (!('enum' in schema)) return false;
  const values = schema.enum;
  if (!Array.isArray(values) || values.length === 0) {
    delete schema.enum;
    return true;
  }
  const types = [...new Set(values.map((entry) => valueType(entry)))];
  let changed = false;
  if (types.length === 1) {
    if (schema.type !== types[0]) {
      schema.type = types[0];
      changed = true;
    }
  } else if (types.length > 1) {
    const anyOf = types.map((type) => ({ type, enum: values.filter((entry) => valueType(entry) === type) }));
    schema.anyOf = anyOf;
    delete schema.enum;
    delete schema.type;
    changed = true;
  }
  return changed;
}

function subSchema(value: unknown, keyword: string): unknown {
  if (keyword === 'additionalProperties' || keyword === 'unevaluatedProperties') {
    if (value === true || value === false) return value;
  }
  return value;
}

function fitShape(schema: Record<string, unknown>, depth = 0): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 64) return false;
  let changed = false;
  if ('type' in schema) {
    const list = (Array.isArray(schema.type) ? schema.type : [schema.type])
      .map((entry) => (typeof entry === 'string' ? entry.toLowerCase() : entry))
      .filter((entry) => TYPES.has(entry as string));
    const uniq = [...new Set(list)];
    const want = uniq.length === 0 ? undefined : uniq.length === 1 ? uniq[0] : uniq;
    if (JSON.stringify(want) !== JSON.stringify(schema.type)) {
      if (want === undefined) delete schema.type;
      else schema.type = want;
      changed = true;
    }
  }
  if ('required' in schema && !Array.isArray(schema.required)) {
    delete schema.required;
    changed = true;
  } else if (Array.isArray(schema.required) && schema.required.some((entry) => typeof entry !== 'string')) {
    schema.required = schema.required.filter((entry) => typeof entry === 'string');
    changed = true;
  }
  if (fitEnum(schema)) changed = true;
  for (const key of SUB_ONE) {
    if (!(key in schema)) continue;
    const value = subSchema(schema[key], key) as Record<string, unknown>;
    if (value !== schema[key]) {
      schema[key] = value;
      changed = true;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (fitShape(value, depth + 1)) changed = true;
    }
  }
  for (const key of SUB_LIST) {
    if (!Array.isArray(schema[key])) continue;
    for (let index = 0; index < (schema[key] as unknown[]).length; index += 1) {
      const raw = (schema[key] as unknown[])[index];
      const value = subSchema(raw, key) as Record<string, unknown>;
      if (value !== raw) {
        (schema[key] as unknown[])[index] = value;
        changed = true;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (fitShape(value, depth + 1)) changed = true;
      }
    }
  }
  for (const key of SUB_MAP) {
    const map = schema[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
      const value = subSchema(raw, key) as Record<string, unknown>;
      if (value !== raw) {
        (map as Record<string, unknown>)[name] = value;
        changed = true;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (fitShape(value, depth + 1)) changed = true;
      }
    }
  }
  return changed;
}

function fitSchema(schema: Record<string, unknown>, depth = 0): boolean {
  if (!schema || typeof schema !== 'object' || depth > 64) return false;
  let changed = false;
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        if (fitSchema(entry as Record<string, unknown>, depth + 1)) changed = true;
      }
    }
    return changed;
  }
  if (typeof schema.pattern === 'string' && schema.pattern.includes('\\0')) {
    const next = schema.pattern.replace(NUL_ESCAPE, (match) => (match === '\\\\' ? match : '\\u0000'));
    if (next !== schema.pattern) {
      schema.pattern = next;
      changed = true;
    }
  }
  if (Array.isArray(schema.items) && !Array.isArray(schema.prefixItems)) {
    schema.items = { anyOf: schema.items };
    delete schema.type;
    changed = true;
  }
  if (fitShape(schema, depth)) changed = true;
  return changed;
}

function localRef(root: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return schema;
  let at: unknown = root;
  for (const key of ref.slice(2).split('/')) {
    at = at && typeof at === 'object' && !Array.isArray(at)
      ? (at as Record<string, unknown>)[key.replaceAll('~1', '/').replaceAll('~0', '~')]
      : undefined;
  }
  return at && typeof at === 'object' && !Array.isArray(at) ? at as Record<string, unknown> : schema;
}

function objectRoot(parameters: Record<string, unknown>, root = parameters, depth = 0): boolean {
  const unions = ['allOf', 'anyOf', 'oneOf'].filter((key) => Array.isArray(parameters[key]));
  if (parameters.type === 'object' && unions.length === 0) return false;
  const props: Record<string, unknown> = parameters.properties && typeof parameters.properties === 'object'
    ? { ...(parameters.properties as Record<string, unknown>) }
    : {};
  const required: string[] = Array.isArray(parameters.required) ? [...parameters.required] : [];
  for (const branch0 of (parameters.allOf as unknown[] | undefined) ?? []) {
    let branch = localRef(root, branch0 as Record<string, unknown>);
    if (!branch || typeof branch !== 'object') continue;
    if (depth < 8 && ['allOf', 'anyOf', 'oneOf'].some((key) => Array.isArray(branch[key]))) {
      branch = structuredClone(branch);
      objectRoot(branch, root, depth + 1);
    }
    for (const [key, value] of Object.entries(branch.properties ?? {})) {
      if (!(key in props)) props[key] = value;
    }
    if (Array.isArray(branch.required)) required.push(...branch.required);
  }
  const branches: Record<string, unknown>[] = [];
  for (const key of ['anyOf', 'oneOf']) {
    for (const branch0 of (parameters[key] as unknown[] | undefined) ?? []) {
      let branch = localRef(root, branch0 as Record<string, unknown>);
      if (!branch || typeof branch !== 'object') continue;
      if (depth < 8 && ['allOf', 'anyOf', 'oneOf'].some((union) => Array.isArray(branch[union]))) {
        branch = structuredClone(branch);
        objectRoot(branch, root, depth + 1);
      }
      if (branch.type !== 'object' && !branch.properties) continue;
      branches.push(branch);
    }
  }
  const from = new Map<string, unknown[]>();
  for (const branch of branches) {
    for (const [key, value] of Object.entries(branch.properties ?? {})) {
      if (key in props) continue;
      const seen = from.get(key) ?? [];
      if (!seen.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) seen.push(value);
      from.set(key, seen);
    }
  }
  for (const [key, list] of from) props[key] = list.length === 1 ? list[0] : { anyOf: list };
  if (branches.length > 0) {
    for (const key of Object.keys(branches[0].properties ?? {})) {
      if (branches.every((branch) => Array.isArray(branch.required) && branch.required.includes(key))) {
        required.push(key);
      }
    }
  }
  for (const key of unions) delete parameters[key];
  parameters.type = 'object';
  parameters.properties = props;
  const req = [...new Set(required)].filter((key) => typeof key === 'string' && key in props);
  if (req.length > 0) parameters.required = req;
  else delete parameters.required;
  return true;
}

export interface FitToolsResult {
  readonly safeToOriginal: ReadonlyMap<string, string>;
}

export function fitWorkBuddyTools(body: Record<string, unknown>): FitToolsResult {
  const safeToOriginal = new Map<string, string>();
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { safeToOriginal };
  const taken = new Set<string>();
  for (const tool of body.tools) {
    const name = tool?.function?.name;
    if (typeof name === 'string' && NAME_OK.test(name)) taken.add(name);
  }
  const originalToSafe = new Map<string, string>();
  for (const tool of body.tools) {
    const fn = tool?.type === 'function' || tool?.function ? tool.function : null;
    if (!fn || typeof fn !== 'object') continue;
    if (typeof fn.name === 'string' && !NAME_OK.test(fn.name)) {
      const safe = safeToolName(fn.name, taken);
      safeToOriginal.set(safe, fn.name);
      originalToSafe.set(fn.name, safe);
      fn.name = safe;
    }
    if (fn.parameters === undefined) continue;
    if (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) {
      fn.parameters = { type: 'object', properties: {} };
      continue;
    }
    const parameters = fn.parameters as Record<string, unknown>;
    fitSchema(parameters);
    fitShape(parameters);
    objectRoot(parameters);
  }
  if (originalToSafe.size > 0 && Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!message || typeof message !== 'object') continue;
      const entry = message as Record<string, unknown>;
      for (const call of Array.isArray(entry.tool_calls) ? entry.tool_calls : []) {
        const fn = call?.function;
        const safe = typeof fn?.name === 'string' ? originalToSafe.get(fn.name) : undefined;
        if (safe) fn.name = safe;
      }
      if (entry.role === 'tool' && typeof entry.name === 'string' && originalToSafe.has(entry.name)) {
        entry.name = originalToSafe.get(entry.name);
      }
    }
    const choice = body.tool_choice;
    if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
      const fn = (choice as Record<string, unknown>).function;
      if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
        const name = (fn as Record<string, unknown>).name;
        if (typeof name === 'string' && originalToSafe.has(name)) {
          (fn as Record<string, unknown>).name = originalToSafe.get(name);
        }
      }
    }
  }
  return { safeToOriginal };
}

function toolFunctionName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  const entry = tool as Record<string, unknown>;
  if (entry.type !== 'function' && !entry.function) return undefined;
  const fn = entry.function;
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return undefined;
  const name = (fn as Record<string, unknown>).name;
  return typeof name === 'string' ? name : undefined;
}

function retainOnlyNamedTool(
  body: Record<string, unknown>,
  requestedName: string,
  safeToOriginal: ReadonlyMap<string, string>,
): boolean {
  if (!Array.isArray(body.tools)) return false;
  const trimmed = requestedName.trim();
  if (!trimmed) return false;
  const kept = body.tools.filter((tool) => {
    const name = toolFunctionName(tool);
    if (!name) return false;
    if (name === trimmed) return true;
    return safeToOriginal.get(name) === trimmed;
  });
  if (kept.length !== 1) return false;
  body.tools = kept;
  return true;
}

export function normalizeWorkBuddyToolChoice(
  body: Record<string, unknown>,
  safeToOriginal: ReadonlyMap<string, string> = new Map(),
): void {
  if (!('tool_choice' in body)) return;
  const choice = body.tool_choice;
  if (typeof choice === 'string') {
    const trimmed = choice.trim();
    const lower = trimmed.toLowerCase();
    if (lower === 'none') {
      delete body.tool_choice;
      delete body.tools;
      delete body.functions;
      return;
    }
    if (lower === 'auto' || lower === 'required') return;
    if (retainOnlyNamedTool(body, trimmed, safeToOriginal)) {
      body.tool_choice = 'required';
    } else {
      delete body.tool_choice;
    }
    return;
  }
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
    delete body.tool_choice;
    return;
  }
  const entry = choice as Record<string, unknown>;
  const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
  if (type === 'none') {
    delete body.tool_choice;
    delete body.tools;
    delete body.functions;
  } else if (type === 'auto' || type === 'required') {
    body.tool_choice = type;
  } else if (type === 'function') {
    const fn = entry.function && typeof entry.function === 'object' && !Array.isArray(entry.function)
      ? entry.function as Record<string, unknown>
      : undefined;
    const name = typeof fn?.name === 'string' ? fn.name.trim() : '';
    if (name && retainOnlyNamedTool(body, name, safeToOriginal)) {
      body.tool_choice = 'required';
    } else {
      delete body.tool_choice;
    }
  } else {
    delete body.tool_choice;
  }
}

export function namedBackToolCalls(value: unknown, safeToOriginal: ReadonlyMap<string, string>): boolean {
  let changed = false;
  for (const choice of Array.isArray((value as Record<string, unknown>)?.choices)
    ? (value as Record<string, unknown>).choices as unknown[]
    : []) {
    if (!choice || typeof choice !== 'object') continue;
    const entry = choice as Record<string, unknown>;
    for (const at of [entry.message, entry.delta]) {
      if (!at || typeof at !== 'object') continue;
      for (const call of Array.isArray((at as Record<string, unknown>).tool_calls)
        ? (at as Record<string, unknown>).tool_calls as unknown[]
        : []) {
        const fn = call && typeof call === 'object' ? (call as Record<string, unknown>).function : undefined;
        const name = fn && typeof fn === 'object' ? (fn as Record<string, unknown>).name : undefined;
        if (typeof name === 'string') {
          const original = safeToOriginal.get(name);
          if (original) {
            (fn as Record<string, unknown>).name = original;
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

export async function renameWorkBuddyResponse(
  response: Response,
  safeToOriginal: ReadonlyMap<string, string>,
): Promise<Response> {
  if (!safeToOriginal.size || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  const json = /json/i.test(response.headers.get('content-type') ?? '');
  if (json) {
    const text = await response.text();
    try {
      const value = JSON.parse(text) as unknown;
      const body = namedBackToolCalls(value, safeToOriginal) ? JSON.stringify(value) : text;
      return new Response(body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      return new Response(text, { status: response.status, statusText: response.statusText, headers });
    }
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let rest = '';
  const transformLine = (line: string): string => {
    const match = /^data:\s?(.*)$/u.exec(line);
    if (!match || match[1] === '[DONE]') return line;
    try {
      const value = JSON.parse(match[1]) as unknown;
      return namedBackToolCalls(value, safeToOriginal) ? `data: ${JSON.stringify(value)}` : line;
    } catch {
      return line;
    }
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) controller.enqueue(encoder.encode(`${transformLine(line)}\n`));
    },
    flush(controller) {
      if (rest.length > 0) controller.enqueue(encoder.encode(transformLine(rest)));
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
