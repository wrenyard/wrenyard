/**
 * Pure search/filter model for the settings page. Tokenizing, the `@modified`
 * and `@id:` filters, field matching and highlight segmentation are all
 * framework-free so they can be reasoned about and tested directly.
 */

export interface SearchQuery {
  /** The trimmed raw input, kept for the input control. */
  raw: string;
  /** Lowercased free-text terms; every term must match (AND). */
  terms: string[];
  /** `@modified`: only settings whose value differs from the default. */
  modifiedOnly: boolean;
  /** `@id:<setting-id>`: an exact setting id filter. */
  id: string | null;
}

export const MODIFIED_FILTER = '@modified';
export const ID_FILTER_PREFIX = '@id:';

export function parseSearchQuery(raw: string): SearchQuery {
  const terms: string[] = [];
  let modifiedOnly = false;
  let id: string | null = null;
  for (const token of raw.trim().split(/\s+/)) {
    if (token === '') continue;
    if (token === MODIFIED_FILTER) {
      modifiedOnly = true;
      continue;
    }
    if (token.startsWith(ID_FILTER_PREFIX)) {
      const value = token.slice(ID_FILTER_PREFIX.length);
      if (value !== '') id = value;
      continue;
    }
    terms.push(token.toLowerCase());
  }
  return { raw, terms, modifiedOnly, id };
}

export function isEmptyQuery(query: SearchQuery): boolean {
  return query.terms.length === 0 && !query.modifiedOnly && query.id === null;
}

export interface SearchTextFields {
  id: string;
  title: string;
  description?: string;
  categoryLabel: string;
  keywords?: string[];
  /** Whether the current value differs from its default. */
  modified?: boolean;
}

function matchesQuery(haystack: string, query: SearchQuery): boolean {
  return query.terms.every((term) => haystack.includes(term));
}

/** A setting matches when every active filter (terms, id, modified) matches. */
export function settingMatches(fields: SearchTextFields, query: SearchQuery): boolean {
  if (query.id !== null && fields.id !== query.id) return false;
  if (query.modifiedOnly && fields.modified !== true) return false;
  if (query.terms.length === 0) return true;
  const haystack = [
    fields.id,
    fields.title,
    fields.description ?? '',
    fields.categoryLabel,
    ...(fields.keywords ?? []),
  ].join(' ').toLowerCase();
  return matchesQuery(haystack, query);
}

export interface ShortcutSearchFields {
  title: string;
  category: string;
  scope: string;
  /** Platform-resolved key text, if the shortcut exists on this platform. */
  keys: string | null;
}

/** Shortcut rows match the same terms against the command name and key text. */
export function shortcutMatches(fields: ShortcutSearchFields, query: SearchQuery): boolean {
  if (query.id !== null) return false;
  if (query.modifiedOnly) return false;
  if (query.terms.length === 0) return true;
  const haystack = [fields.title, fields.category, fields.scope, fields.keys ?? '']
    .join(' ')
    .toLowerCase();
  return matchesQuery(haystack, query);
}

export interface HighlightSegment {
  text: string;
  /** True when the segment is a term hit and should be wrapped in `mark`. */
  match: boolean;
}

/**
 * Splits text into hit and non-hit segments for `mark` highlighting. All term
 * occurrences are highlighted; overlapping terms collapse to the longest span.
 */
export function highlightText(text: string, terms: readonly string[]): HighlightSegment[] {
  if (text === '' || terms.length === 0) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    if (term === '') continue;
    let from = 0;
    for (;;) {
      const index = lower.indexOf(term, from);
      if (index === -1) break;
      ranges.push([index, index + term.length]);
      from = index + term.length;
    }
  }
  if (ranges.length === 0) return [{ text, match: false }];
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
