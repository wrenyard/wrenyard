import type { TaskSettingsInstructionTemplate } from '../shell-contract.js';
import { renderRichText } from './conversation.js';

const PLACEHOLDER_MARKER_PREFIX = '\u0000wrenyard-preview-slot-';
const PLACEHOLDER_MARKER_SUFFIX = '\u0000';

/**
 * Collects every text node in document order so inline markers can be replaced
 * wherever the rich-text renderer placed them (paragraphs, list items, headings).
 */
function collectTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      nodes.push(node as Text);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return nodes;
}

/**
 * Read-only static instruction-template preview. Static fragments are
 * concatenated with unique inline placeholder markers into one markdown string,
 * rendered once through the safe rich-text renderer, and then each marker text
 * node is swapped for an inline span chip. Text is never interpreted as HTML and
 * no task function is invoked or evaluated; the preview only displays what the
 * template declares.
 */
export function renderInstructionTemplatePreview(
  segments: TaskSettingsInstructionTemplate,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const markers = new Map<string, { label: string; source: string }>();
  const staticText = segments.filter((s) => s.kind === 'text').map((s) => s.text).join('');
  let prefix = PLACEHOLDER_MARKER_PREFIX;
  while (staticText.includes(prefix)) prefix += 'x';
  let markdown = '';
  for (const segment of segments) {
    if (segment.kind === 'text') {
      markdown += segment.text;
      continue;
    }
    const marker = `${prefix}${markers.size}${PLACEHOLDER_MARKER_SUFFIX}`;
    markers.set(marker, { label: segment.label, source: segment.source });
    markdown += marker;
  }
  fragment.append(renderRichText(markdown));
  if (markers.size === 0) return fragment;

  for (const node of collectTextNodes(fragment)) {
    const parts = node.textContent?.split(
      new RegExp(`(${prefix}\\d+${PLACEHOLDER_MARKER_SUFFIX})`, 'g'),
    );
    if (!parts || parts.length === 1) continue;
    const replacement = document.createDocumentFragment();
    for (const part of parts) {
      if (!part) continue;
      const placeholder = markers.get(part);
      if (placeholder) {
        const chip = document.createElement('span');
        chip.className = 'tasks-preview-placeholder';
        chip.textContent = placeholder.label;
        chip.setAttribute('title', placeholder.source);
        replacement.append(chip);
        continue;
      }
      replacement.append(document.createTextNode(part));
    }
    node.parentNode?.replaceChild(replacement, node);
  }
  return fragment;
}
