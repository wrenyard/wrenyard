import { ListFilter, Search } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/renderer/components/ui/input-group';
import {
  SEARCH_FILTER_ID_LABEL,
  SEARCH_FILTER_ID_PREFIX,
  SEARCH_FILTER_MODIFIED,
  SEARCH_FILTER_MODIFIED_LABEL,
  SEARCH_PLACEHOLDER,
  SEARCH_RESULT_SUFFIX,
} from '../model/describe.js';

export interface SettingsSearchProps {
  value: string;
  resultCount: number;
  onChange: (value: string) => void;
}

/** Appends a filter token without clobbering the current query. */
function appendToken(value: string, token: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? token : `${trimmed} ${token}`;
}

/**
 * The fixed search row: input, filter menu and result count. Selecting a
 * filter inserts its token into the box, matching VS Code; Escape clears.
 */
export function SettingsSearch({ value, resultCount, onChange }: SettingsSearchProps) {
  return (
    <InputGroup>
      <InputGroupAddon align="inline-start">
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        value={value}
        placeholder={SEARCH_PLACEHOLDER}
        spellCheck={false}
        autoComplete="off"
        aria-label={SEARCH_PLACEHOLDER}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onChange('');
          }
        }}
      />
      <InputGroupAddon align="inline-end" className="gap-1">
        <span className="text-xs tabular-nums text-muted-foreground">{`${resultCount}${SEARCH_RESULT_SUFFIX}`}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={(<InputGroupButton size="icon-xs" aria-label="筛选设置" />)}
          >
            <ListFilter />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => onChange(appendToken(value, SEARCH_FILTER_MODIFIED))}>
              {SEARCH_FILTER_MODIFIED_LABEL}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onChange(appendToken(value, SEARCH_FILTER_ID_PREFIX))}>
              {SEARCH_FILTER_ID_LABEL}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </InputGroupAddon>
    </InputGroup>
  );
}
