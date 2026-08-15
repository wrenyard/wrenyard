package bashgate

import (
	"fmt"
	"os"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

type pathAccess uint8

const (
	pathAccessExact pathAccess = iota
	pathAccessListing
	pathAccessRecursive

	maxGuardGlobMatches = 256
	maxGuardGlobEntries = 4096
)

func normalizeSensitivePaths(paths []SensitivePath) ([]SensitivePath, error) {
	out := make([]SensitivePath, 0, len(paths))
	seen := map[string]bool{}
	for _, item := range paths {
		path := strings.TrimSpace(item.Path)
		if path == "" || strings.ContainsAny(path, "\x00\r\n") || !filepath.IsAbs(path) {
			return nil, fmt.Errorf("sensitive path is invalid")
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("sensitive path is invalid")
		}
		absolute = filepath.Clean(absolute)
		info, err := os.Stat(absolute)
		if err != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("sensitive path is invalid")
		}
		identities := []string{absolute}
		if canonical := canonicalPath(absolute); pathComparisonKey(canonical) != pathComparisonKey(absolute) {
			identities = append(identities, canonical)
		}
		for _, identity := range identities {
			key := pathComparisonKey(identity)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, SensitivePath{
				Path: identity, DenyContainingDirEnumeration: item.DenyContainingDirEnumeration,
			})
		}
	}
	return out, nil
}

func validSensitivePaths(paths []SensitivePath) bool {
	for _, item := range paths {
		path := strings.TrimSpace(item.Path)
		if path == "" || strings.ContainsAny(path, "\x00\r\n") || !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return false
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func sensitivePath(value, cwd string, access pathAccess, sensitiveEnvKeys []string, sensitivePaths []SensitivePath) bool {
	if sensitiveText(value, sensitiveEnvKeys) {
		return true
	}
	matched, valid := pathTargetsProcessEnvironment(value, cwd, access)
	if !valid || matched {
		return true
	}
	if len(sensitivePaths) > 0 {
		matched, valid = pathTargetsSensitiveFile(value, cwd, access, sensitivePaths)
		if !valid || matched {
			return true
		}
	}
	return false
}

func pathTargetsSensitiveFile(value, cwd string, access pathAccess, sensitivePaths []SensitivePath) (bool, bool) {
	candidate, valid := resolveGuardPath(value, cwd)
	if !valid {
		return false, false
	}
	candidates := []string{candidate}
	if hasPathGlob(candidate) {
		matches, ok := boundedGlob(candidate, maxGuardGlobMatches, maxGuardGlobEntries)
		if !ok {
			return false, false
		}
		candidates = matches
		for _, sensitive := range sensitivePaths {
			if globMatchesProtectedPath(candidate, sensitive.Path) {
				return true, true
			}
		}
	}
	for _, path := range candidates {
		for _, sensitive := range sensitivePaths {
			if samePathOrFile(path, sensitive.Path) {
				return true, true
			}
			switch access {
			case pathAccessListing:
				if sensitive.DenyContainingDirEnumeration && samePathOrFile(path, filepath.Dir(sensitive.Path)) {
					return true, true
				}
			case pathAccessRecursive:
				if pathContainsFile(path, sensitive.Path) {
					return true, true
				}
			}
		}
	}
	return false, true
}

func pathTargetsProcessEnvironment(value, cwd string, access pathAccess) (bool, bool) {
	if processEnvironmentPattern(value, access) {
		return true, true
	}
	candidate, valid := resolveGuardPath(value, cwd)
	if !valid {
		return false, false
	}
	candidates := []string{candidate}
	if hasPathGlob(candidate) {
		matches, ok := boundedGlob(candidate, maxGuardGlobMatches, maxGuardGlobEntries)
		if !ok {
			return false, false
		}
		candidates = matches
		if processEnvironmentPattern(candidate, access) {
			return true, true
		}
	}
	for _, item := range candidates {
		for _, identity := range []string{filepath.Clean(item), canonicalPath(item)} {
			normalized := normalizePathText(identity)
			if processEnvironmentPath.MatchString(normalized) {
				return true, true
			}
			if access != pathAccessExact && processDirectoryPath.MatchString(normalized) {
				return true, true
			}
		}
	}
	return false, true
}

func processEnvironmentPattern(value string, access pathAccess) bool {
	normalized := cleanSlashPath(value)
	if processEnvironmentPath.MatchString(normalized) || access != pathAccessExact && processDirectoryPath.MatchString(normalized) {
		return true
	}
	if !hasPathGlob(normalized) {
		return false
	}
	examples := []string{
		"/proc/self/environ", "/proc/thread-self/environ", "/proc/123/environ",
		"/proc/self/task/self/environ", "/proc/123/task/456/environ",
	}
	if access != pathAccessExact {
		examples = append(examples, "/proc", "/proc/self", "/proc/123", "/proc/123/task/456")
	}
	for _, example := range examples {
		if matched, err := pathpkg.Match(normalized, example); err == nil && matched {
			return true
		}
	}
	return false
}

func cleanSlashPath(value string) string {
	normalized := normalizePathText(value)
	if normalized == "" {
		return normalized
	}
	return pathpkg.Clean(normalized)
}

func resolveGuardPath(value, cwd string) (string, bool) {
	path := strings.TrimSpace(value)
	if path == "" || strings.ContainsAny(path, "\x00\r\n") {
		return "", false
	}
	var valid bool
	path, valid = expandChildHomePath(path)
	if !valid {
		return "", false
	}
	if volume := filepath.VolumeName(path); volume != "" && !filepath.IsAbs(path) {
		return "", false
	}
	if !filepath.IsAbs(path) {
		base, ok := actualWorkingDirectory(cwd)
		if !ok {
			return "", false
		}
		path = filepath.Join(base, path)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", false
	}
	return filepath.Clean(absolute), true
}

func actualWorkingDirectory(cwd string) (string, bool) {
	base := strings.TrimSpace(cwd)
	if base == "" {
		var err error
		base, err = os.Getwd()
		if err != nil {
			return "", false
		}
	} else {
		var valid bool
		base, valid = expandChildHomePath(base)
		if !valid {
			return "", false
		}
	}
	absolute, err := filepath.Abs(base)
	if err != nil {
		return "", false
	}
	info, err := os.Stat(absolute)
	return filepath.Clean(absolute), err == nil && info.IsDir()
}

func expandChildHomePath(path string) (string, bool) {
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		root := firstNonemptyEnv("HOME", "USERPROFILE")
		return joinHomeAlias(root, strings.TrimLeft(path[1:], `/\`))
	}
	if strings.HasPrefix(path, "~") {
		return "", false
	}
	for _, name := range []string{"GROK_HOME", "HOME", "USERPROFILE"} {
		forms := []string{"$" + name, "${" + name + "}", "%" + name + "%", "$env:" + name, "${env:" + name + "}"}
		for _, form := range forms {
			if len(path) < len(form) || !strings.EqualFold(path[:len(form)], form) {
				continue
			}
			if len(path) > len(form) && path[len(form)] != '/' && path[len(form)] != '\\' {
				continue
			}
			return joinHomeAlias(os.Getenv(name), strings.TrimLeft(path[len(form):], `/\`))
		}
	}
	return path, true
}

func joinHomeAlias(root, suffix string) (string, bool) {
	root = strings.TrimSpace(root)
	if root == "" || strings.ContainsAny(root, "\x00\r\n") || !filepath.IsAbs(root) {
		return "", false
	}
	if suffix == "" {
		return filepath.Clean(root), true
	}
	suffix = filepath.FromSlash(strings.ReplaceAll(suffix, `\`, "/"))
	return filepath.Join(root, suffix), true
}

func firstNonemptyEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

func samePathOrFile(left, right string) bool {
	if pathComparisonKey(filepath.Clean(left)) == pathComparisonKey(filepath.Clean(right)) {
		return true
	}
	leftResolved, leftErr := filepath.EvalSymlinks(left)
	rightResolved, rightErr := filepath.EvalSymlinks(right)
	if leftErr == nil && rightErr == nil && pathComparisonKey(filepath.Clean(leftResolved)) == pathComparisonKey(filepath.Clean(rightResolved)) {
		return true
	}
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	return leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo)
}

func pathContainsFile(directory, file string) bool {
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return false
	}
	directory = canonicalPath(directory)
	file = canonicalPath(file)
	relative, err := filepath.Rel(directory, file)
	if err != nil || relative == "." || relative == ".." {
		return false
	}
	return !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func canonicalPath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(path)
}

func globMatchesProtectedPath(pattern, protected string) bool {
	for _, candidate := range []string{filepath.Clean(protected), canonicalPath(protected)} {
		matched, err := filepath.Match(pattern, candidate)
		if err == nil && matched {
			return true
		}
	}
	return false
}

// boundedGlob expands one filesystem pattern without allowing either the
// number of returned matches or the directory entries inspected to grow
// without bound. Any unreadable directory, malformed component, or exceeded
// bound fails closed at the caller.
func boundedGlob(pattern string, matchLimit, entryLimit int) ([]string, bool) {
	if matchLimit <= 0 || entryLimit <= 0 {
		return nil, false
	}
	pattern = filepath.Clean(pattern)
	if !hasPathGlob(pattern) {
		return []string{pattern}, true
	}
	volume := filepath.VolumeName(pattern)
	rest := strings.TrimPrefix(pattern, volume)
	if !filepath.IsAbs(pattern) {
		return nil, false
	}
	rest = strings.TrimLeft(rest, `/\`)
	parts := strings.FieldsFunc(rest, func(r rune) bool { return r == '/' || r == '\\' })
	base := volume + string(filepath.Separator)
	if volume == "" {
		base = string(filepath.Separator)
	}
	states := []string{base}
	inspected := 0
	for partIndex, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, false
		}
		last := partIndex == len(parts)-1
		next := make([]string, 0, len(states))
		for _, state := range states {
			if hasPathGlob(part) {
				entries, err := os.ReadDir(state)
				if err != nil {
					return nil, false
				}
				for _, entry := range entries {
					inspected++
					if inspected > entryLimit {
						return nil, false
					}
					matched, err := filepath.Match(part, entry.Name())
					if err != nil {
						return nil, false
					}
					if !matched {
						continue
					}
					candidate := filepath.Join(state, entry.Name())
					if !last {
						info, err := os.Stat(candidate)
						if err != nil || !info.IsDir() {
							continue
						}
					}
					next = append(next, candidate)
					if len(next) > matchLimit {
						return nil, false
					}
				}
				continue
			}
			candidate := filepath.Join(state, part)
			info, err := os.Stat(candidate)
			if err != nil {
				if os.IsNotExist(err) {
					continue
				}
				return nil, false
			}
			if !last && !info.IsDir() {
				continue
			}
			next = append(next, candidate)
			if len(next) > matchLimit {
				return nil, false
			}
		}
		states = next
		if len(states) == 0 {
			return nil, true
		}
	}
	return states, true
}

func pathComparisonKey(path string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}

func hasPathGlob(path string) bool {
	return strings.ContainsAny(path, "*?[")
}

func commandTargetsSensitivePath(command, cwd string, sensitivePaths []SensitivePath, dialect catalog.BashShellDialect) (bool, bool) {
	segments, valid := commandWordSegments(command, dialect)
	if !valid {
		return false, false
	}
	effectiveCWD, valid := actualWorkingDirectory(cwd)
	if !valid {
		return false, false
	}
	cwdChanged := false
	cwdAmbiguous := false
	backgroundBase := effectiveCWD
	backgroundBaseAmbiguous := false
	for _, segment := range segments {
		words := segment.words
		if cwdChanged && (segment.before == commandSeparatorOr || segment.before == commandSeparatorPipe) {
			cwdAmbiguous = true
		}
		checkPath := func(candidate string, access pathAccess, base string) (bool, bool) {
			if cwdAmbiguous && pathDependsOnWorkingDirectory(candidate) {
				return false, false
			}
			return pathTargetsProtectedFile(candidate, base, access, sensitivePaths)
		}
		searchOperands, searchCommand, searchValid := searchCommandPathOperands(words, dialect, effectiveCWD)
		if searchCommand {
			if !searchValid {
				return false, false
			}
			for _, operand := range searchOperands {
				base := effectiveCWD
				if operand.base != "" {
					base = operand.base
				}
				matched, ok := checkPath(operand.value, operand.access, base)
				if !ok {
					return false, false
				}
				if matched {
					return true, true
				}
			}
		} else {
			access, filesystemCommand := filesystemCommandAccess(words)
			if !filesystemCommand {
				access = pathAccessExact
			}
			optionValues, ok := catalog.RestrictedShortOptionValues(words)
			if !ok {
				return false, false
			}
			for _, candidate := range optionValues {
				matched, valid := checkPath(candidate, access, effectiveCWD)
				if !valid {
					return false, false
				}
				if matched {
					return true, true
				}
			}
			positional := false
			for _, word := range words[1:] {
				if commandOption(word, dialect) {
					for _, candidate := range attachedOptionPathValues(word) {
						matched, ok := checkPath(candidate, access, effectiveCWD)
						if !ok {
							return false, false
						}
						if matched {
							return true, true
						}
					}
					continue
				}
				positional = true
				for _, candidate := range strings.Split(word, ",") {
					matched, ok := checkPath(candidate, access, effectiveCWD)
					if !ok {
						return false, false
					}
					if matched {
						return true, true
					}
				}
			}
			if filesystemCommand && !positional && (access == pathAccessListing || access == pathAccessRecursive) {
				matched, ok := checkPath(".", access, effectiveCWD)
				if !ok {
					return false, false
				}
				if matched {
					return true, true
				}
			}
		}
		if nextCWD, directoryChange, resolved := literalDirectoryChange(words, effectiveCWD); directoryChange {
			cwdChanged = true
			if !resolved || cwdAmbiguous || segment.before == commandSeparatorAnd || segment.before == commandSeparatorOr || segment.before == commandSeparatorPipe {
				cwdAmbiguous = true
				continue
			}
			effectiveCWD = nextCWD
		}
		switch segment.after {
		case commandSeparatorBackground:
			effectiveCWD = backgroundBase
			cwdAmbiguous = backgroundBaseAmbiguous
			cwdChanged = false
		case commandSeparatorSequential:
			backgroundBase = effectiveCWD
			backgroundBaseAmbiguous = cwdAmbiguous
		}
	}
	return false, true
}

func pathDependsOnWorkingDirectory(value string) bool {
	path, valid := expandChildHomePath(strings.TrimSpace(value))
	if !valid || path == "" {
		return true
	}
	if volume := filepath.VolumeName(path); volume != "" && !filepath.IsAbs(path) {
		return true
	}
	return !filepath.IsAbs(path)
}

func literalDirectoryChange(words []string, cwd string) (string, bool, bool) {
	if len(words) == 0 {
		return "", false, false
	}
	name := strings.ToLower(filepath.Base(words[0]))
	name = strings.TrimSuffix(name, ".exe")
	if name != "cd" {
		return "", false, false
	}
	if len(words) != 2 {
		return "", true, false
	}
	path := strings.TrimSpace(words[1])
	if path == "" || strings.HasPrefix(path, "-") || strings.HasPrefix(path, "~") ||
		strings.ContainsAny(path, "$%`{}()*?[") {
		return "", true, false
	}
	resolved, valid := resolveGuardPath(path, cwd)
	if !valid {
		return "", true, false
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", true, false
	}
	return filepath.Clean(resolved), true, true
}

func pathTargetsProtectedFile(value, cwd string, access pathAccess, sensitivePaths []SensitivePath) (bool, bool) {
	matched, valid := pathTargetsProcessEnvironment(value, cwd, access)
	if !valid || matched {
		return matched, valid
	}
	if len(sensitivePaths) == 0 {
		return false, true
	}
	return pathTargetsSensitiveFile(value, cwd, access, sensitivePaths)
}

type guardedPathOperand struct {
	value  string
	base   string
	access pathAccess
}

type searchOptionRole uint8

const (
	searchOptionFlag searchOptionRole = iota
	searchOptionValue
	searchOptionPattern
	searchOptionPatternFile
	searchOptionPath
	searchOptionFilesMode
	searchOptionNoSearch
	searchOptionNoSearchValue
)

type parsedSearchArguments struct {
	beforeSeparator []string
	afterSeparator  []string
	paths           []guardedPathOperand
	separator       bool
	patternProvided bool
	filesMode       bool
	noSearch        bool
}

var ripgrepShortOptions = map[byte]searchOptionRole{
	'a': searchOptionFlag, 's': searchOptionFlag, 'F': searchOptionFlag, 'i': searchOptionFlag,
	'v': searchOptionFlag, 'x': searchOptionFlag, 'U': searchOptionFlag, 'P': searchOptionFlag,
	'S': searchOptionFlag, 'L': searchOptionFlag, '.': searchOptionFlag, 'u': searchOptionFlag,
	'b': searchOptionFlag, 'h': searchOptionNoSearch, 'n': searchOptionFlag, 'N': searchOptionFlag,
	'0': searchOptionFlag, 'o': searchOptionFlag, 'p': searchOptionFlag, 'q': searchOptionFlag,
	'H': searchOptionFlag, 'I': searchOptionFlag, 'c': searchOptionFlag, 'l': searchOptionFlag,
	'V': searchOptionNoSearch, 'z': searchOptionFlag,
	'e': searchOptionPattern, 'f': searchOptionPatternFile, 'E': searchOptionValue,
	'm': searchOptionValue, 'j': searchOptionValue, 'g': searchOptionValue, 'd': searchOptionValue,
	't': searchOptionValue, 'T': searchOptionValue, 'A': searchOptionValue, 'B': searchOptionValue,
	'C': searchOptionValue, 'M': searchOptionValue, 'r': searchOptionValue,
}

var ripgrepLongOptions = map[string]searchOptionRole{
	"--regexp": searchOptionPattern, "--file": searchOptionPatternFile,
	"--ignore-file": searchOptionPath, "--pre": searchOptionPath, "--hostname-bin": searchOptionPath,
	"--pre-glob": searchOptionValue, "--encoding": searchOptionValue, "--engine": searchOptionValue,
	"--dfa-size-limit": searchOptionValue, "--regex-size-limit": searchOptionValue,
	"--max-count": searchOptionValue, "--threads": searchOptionValue, "--glob": searchOptionValue,
	"--iglob": searchOptionValue, "--max-depth": searchOptionValue, "--max-filesize": searchOptionValue,
	"--type": searchOptionValue, "--type-not": searchOptionValue, "--type-add": searchOptionValue,
	"--type-clear": searchOptionValue, "--after-context": searchOptionValue, "--before-context": searchOptionValue,
	"--context": searchOptionValue, "--color": searchOptionValue, "--colors": searchOptionValue,
	"--context-separator": searchOptionValue, "--field-context-separator": searchOptionValue,
	"--field-match-separator": searchOptionValue, "--hyperlink-format": searchOptionValue,
	"--max-columns": searchOptionValue, "--path-separator": searchOptionValue,
	"--replace": searchOptionValue, "--sort": searchOptionValue, "--sortr": searchOptionValue,
	"--generate": searchOptionNoSearchValue,

	"--search-zip": searchOptionFlag, "--case-sensitive": searchOptionFlag, "--crlf": searchOptionFlag,
	"--fixed-strings": searchOptionFlag, "--ignore-case": searchOptionFlag, "--invert-match": searchOptionFlag,
	"--line-regexp": searchOptionFlag, "--mmap": searchOptionFlag, "--multiline": searchOptionFlag,
	"--multiline-dotall": searchOptionFlag, "--no-unicode": searchOptionFlag, "--null-data": searchOptionFlag,
	"--pcre2": searchOptionFlag, "--smart-case": searchOptionFlag, "--stop-on-nonmatch": searchOptionFlag,
	"--text": searchOptionFlag, "--word-regexp": searchOptionFlag, "--auto-hybrid-regex": searchOptionFlag,
	"--no-pcre2-unicode": searchOptionFlag, "--binary": searchOptionFlag, "--follow": searchOptionFlag,
	"--glob-case-insensitive": searchOptionFlag, "--hidden": searchOptionFlag,
	"--ignore-file-case-insensitive": searchOptionFlag, "--no-ignore": searchOptionFlag,
	"--no-ignore-dot": searchOptionFlag, "--no-ignore-exclude": searchOptionFlag,
	"--no-ignore-files": searchOptionFlag, "--no-ignore-global": searchOptionFlag,
	"--no-ignore-parent": searchOptionFlag, "--no-ignore-vcs": searchOptionFlag,
	"--no-require-git": searchOptionFlag, "--one-file-system": searchOptionFlag,
	"--unrestricted": searchOptionFlag, "--block-buffered": searchOptionFlag,
	"--byte-offset": searchOptionFlag, "--column": searchOptionFlag, "--heading": searchOptionFlag,
	"--include-zero": searchOptionFlag, "--line-buffered": searchOptionFlag,
	"--line-number": searchOptionFlag, "--no-line-number": searchOptionFlag,
	"--max-columns-preview": searchOptionFlag, "--null": searchOptionFlag,
	"--only-matching": searchOptionFlag, "--passthru": searchOptionFlag, "--pretty": searchOptionFlag,
	"--quiet": searchOptionFlag, "--trim": searchOptionFlag, "--vimgrep": searchOptionFlag,
	"--with-filename": searchOptionFlag, "--no-filename": searchOptionFlag, "--sort-files": searchOptionFlag,
	"--count": searchOptionFlag, "--count-matches": searchOptionFlag, "--files-with-matches": searchOptionFlag,
	"--files-without-match": searchOptionFlag, "--json": searchOptionFlag, "--debug": searchOptionFlag,
	"--no-ignore-messages": searchOptionFlag, "--no-messages": searchOptionFlag, "--stats": searchOptionFlag,
	"--trace": searchOptionFlag, "--no-config": searchOptionFlag, "--no-pre": searchOptionFlag,
	"--files": searchOptionFilesMode,
	"--help":  searchOptionNoSearch, "--version": searchOptionNoSearch,
	"--pcre2-version": searchOptionNoSearch, "--type-list": searchOptionNoSearch,
}

var grepShortOptions = map[byte]searchOptionRole{
	'E': searchOptionFlag, 'F': searchOptionFlag, 'G': searchOptionFlag, 'P': searchOptionFlag,
	'i': searchOptionFlag, 'w': searchOptionFlag, 'x': searchOptionFlag, 'z': searchOptionFlag,
	's': searchOptionFlag, 'v': searchOptionFlag, 'V': searchOptionNoSearch, 'h': searchOptionFlag,
	'H': searchOptionFlag, 'n': searchOptionFlag, 'b': searchOptionFlag, 'o': searchOptionFlag,
	'q': searchOptionFlag, 'a': searchOptionFlag, 'I': searchOptionFlag, 'R': searchOptionFlag,
	'r': searchOptionFlag, 'L': searchOptionFlag, 'l': searchOptionFlag, 'c': searchOptionFlag,
	'T': searchOptionFlag, 'Z': searchOptionFlag, 'U': searchOptionFlag,
	'e': searchOptionPattern, 'f': searchOptionPatternFile, 'm': searchOptionValue,
	'A': searchOptionValue, 'B': searchOptionValue, 'C': searchOptionValue,
	'd': searchOptionValue, 'D': searchOptionValue,
}

var grepLongOptions = map[string]searchOptionRole{
	"--regexp": searchOptionPattern, "--file": searchOptionPatternFile,
	"--max-count": searchOptionValue, "--after-context": searchOptionValue,
	"--before-context": searchOptionValue, "--context": searchOptionValue,
	"--directories": searchOptionValue, "--devices": searchOptionValue,
	"--include": searchOptionValue, "--exclude": searchOptionValue,
	"--exclude-from": searchOptionPath, "--exclude-dir": searchOptionValue,
	"--binary-files": searchOptionValue, "--label": searchOptionValue,
	"--color": searchOptionValue, "--colour": searchOptionValue,
	"--extended-regexp": searchOptionFlag, "--fixed-strings": searchOptionFlag,
	"--basic-regexp": searchOptionFlag, "--perl-regexp": searchOptionFlag,
	"--ignore-case": searchOptionFlag, "--word-regexp": searchOptionFlag,
	"--line-regexp": searchOptionFlag, "--null-data": searchOptionFlag,
	"--no-messages": searchOptionFlag, "--invert-match": searchOptionFlag,
	"--with-filename": searchOptionFlag, "--no-filename": searchOptionFlag,
	"--line-number": searchOptionFlag, "--byte-offset": searchOptionFlag,
	"--line-buffered": searchOptionFlag, "--initial-tab": searchOptionFlag,
	"--null": searchOptionFlag, "--only-matching": searchOptionFlag,
	"--quiet": searchOptionFlag, "--silent": searchOptionFlag, "--text": searchOptionFlag,
	"--binary": searchOptionFlag, "--recursive": searchOptionFlag,
	"--dereference-recursive": searchOptionFlag, "--files-without-match": searchOptionFlag,
	"--files-with-matches": searchOptionFlag, "--count": searchOptionFlag,
	"--unix-byte-offsets": searchOptionFlag, "--help": searchOptionNoSearch,
	"--version": searchOptionNoSearch,
}

var gitGrepShortSearchOptions = map[byte]searchOptionRole{
	'a': searchOptionFlag, 'I': searchOptionFlag, 'i': searchOptionFlag, 'w': searchOptionFlag,
	'v': searchOptionFlag, 'h': searchOptionFlag, 'H': searchOptionFlag, 'E': searchOptionFlag,
	'G': searchOptionFlag, 'P': searchOptionFlag, 'F': searchOptionFlag, 'n': searchOptionFlag,
	'l': searchOptionFlag, 'L': searchOptionFlag, 'o': searchOptionFlag, 'c': searchOptionFlag,
	'p': searchOptionFlag, 'W': searchOptionFlag, 'q': searchOptionFlag, 'z': searchOptionFlag,
	'r': searchOptionFlag,
	'e': searchOptionPattern, 'f': searchOptionPatternFile, 'm': searchOptionValue,
	'A': searchOptionValue, 'B': searchOptionValue, 'C': searchOptionValue,
	'O': searchOptionValue,
	'0': searchOptionFlag, '1': searchOptionFlag, '2': searchOptionFlag, '3': searchOptionFlag,
	'4': searchOptionFlag, '5': searchOptionFlag, '6': searchOptionFlag, '7': searchOptionFlag,
	'8': searchOptionFlag, '9': searchOptionFlag,
}

var gitGrepLongSearchOptions = map[string]searchOptionRole{
	"--regexp": searchOptionPattern, "--file": searchOptionPatternFile,
	"--max-depth": searchOptionValue, "--max-count": searchOptionValue,
	"--context": searchOptionValue, "--before-context": searchOptionValue,
	"--after-context": searchOptionValue, "--threads": searchOptionValue,
	"--color": searchOptionValue, "--open-files-in-pager": searchOptionValue,
	"--cached": searchOptionFlag, "--no-cached": searchOptionFlag,
	"--no-index": searchOptionFlag, "--index": searchOptionFlag,
	"--untracked": searchOptionFlag, "--no-untracked": searchOptionFlag,
	"--exclude-standard": searchOptionFlag, "--no-exclude-standard": searchOptionFlag,
	"--recurse-submodules": searchOptionFlag, "--no-recurse-submodules": searchOptionFlag,
	"--invert-match": searchOptionFlag, "--no-invert-match": searchOptionFlag,
	"--ignore-case": searchOptionFlag, "--no-ignore-case": searchOptionFlag,
	"--word-regexp": searchOptionFlag, "--no-word-regexp": searchOptionFlag,
	"--text": searchOptionFlag, "--no-text": searchOptionFlag,
	"--recursive": searchOptionFlag, "--no-recursive": searchOptionFlag,
	"--textconv": searchOptionFlag, "--no-textconv": searchOptionFlag,
	"--extended-regexp": searchOptionFlag, "--basic-regexp": searchOptionFlag,
	"--fixed-strings": searchOptionFlag, "--perl-regexp": searchOptionFlag,
	"--line-number": searchOptionFlag, "--column": searchOptionFlag,
	"--full-name": searchOptionFlag, "--files-with-matches": searchOptionFlag,
	"--name-only": searchOptionFlag, "--files-without-match": searchOptionFlag,
	"--null": searchOptionFlag, "--only-matching": searchOptionFlag,
	"--count": searchOptionFlag, "--break": searchOptionFlag,
	"--heading": searchOptionFlag, "--show-function": searchOptionFlag,
	"--function-context": searchOptionFlag, "--and": searchOptionFlag,
	"--or": searchOptionFlag, "--not": searchOptionFlag, "--quiet": searchOptionFlag,
	"--all-match": searchOptionFlag, "--ext-grep": searchOptionFlag,
}

func searchCommandPathOperands(words []string, dialect catalog.BashShellDialect, cwd string) ([]guardedPathOperand, bool, bool) {
	if len(words) == 0 {
		return nil, false, false
	}
	name := strings.ToLower(filepath.Base(words[0]))
	name = strings.TrimSuffix(name, ".exe")
	switch name {
	case "rg":
		parsed, ok := parseDashSearchArguments(words[1:], ripgrepShortOptions, ripgrepLongOptions)
		if !ok {
			return nil, true, false
		}
		operands, ok := finalizeSearchArguments(parsed, true)
		return operands, true, ok
	case "grep":
		parsed, ok := parseDashSearchArguments(words[1:], grepShortOptions, grepLongOptions)
		if !ok {
			return nil, true, false
		}
		operands, ok := finalizeSearchArguments(parsed, false)
		return operands, true, ok
	case "git":
		operands, recognized, ok := gitGrepPathOperands(words[1:], cwd)
		return operands, recognized, ok
	case "findstr":
		operands, ok := findstrPathOperands(words[1:], dialect)
		return operands, true, ok
	case "select-string":
		operands, ok := selectStringPathOperands(words[1:])
		return operands, true, ok
	default:
		return nil, false, true
	}
}

func parseDashSearchArguments(args []string, short map[byte]searchOptionRole, long map[string]searchOptionRole) (parsedSearchArguments, bool) {
	parsed := parsedSearchArguments{}
	options := true
	for index := 0; index < len(args); index++ {
		token := args[index]
		if options && token == "--" {
			if parsed.separator {
				return parsedSearchArguments{}, false
			}
			parsed.separator = true
			options = false
			continue
		}
		if !options || token == "-" || !strings.HasPrefix(token, "-") {
			if parsed.separator {
				parsed.afterSeparator = append(parsed.afterSeparator, token)
			} else {
				parsed.beforeSeparator = append(parsed.beforeSeparator, token)
			}
			continue
		}
		if strings.HasPrefix(token, "--") {
			name, value, attached := strings.Cut(token, "=")
			role, known := long[strings.ToLower(name)]
			if !known || role == searchOptionFlag && attached || role == searchOptionFilesMode && attached || role == searchOptionNoSearch && attached {
				return parsedSearchArguments{}, false
			}
			if role != searchOptionFlag && role != searchOptionFilesMode && role != searchOptionNoSearch && !attached {
				if index+1 >= len(args) || args[index+1] == "--" {
					return parsedSearchArguments{}, false
				}
				index++
				value = args[index]
			}
			if !applySearchOption(&parsed, role, value) {
				return parsedSearchArguments{}, false
			}
			continue
		}
		cluster := token[1:]
		if cluster == "" {
			return parsedSearchArguments{}, false
		}
		for offset := 0; offset < len(cluster); offset++ {
			role, known := short[cluster[offset]]
			if !known {
				return parsedSearchArguments{}, false
			}
			value := ""
			if role != searchOptionFlag && role != searchOptionFilesMode && role != searchOptionNoSearch {
				if offset+1 < len(cluster) {
					value = cluster[offset+1:]
					offset = len(cluster)
				} else {
					if index+1 >= len(args) || args[index+1] == "--" {
						return parsedSearchArguments{}, false
					}
					index++
					value = args[index]
				}
			}
			if !applySearchOption(&parsed, role, value) {
				return parsedSearchArguments{}, false
			}
		}
	}
	return parsed, true
}

func applySearchOption(parsed *parsedSearchArguments, role searchOptionRole, value string) bool {
	switch role {
	case searchOptionFlag, searchOptionValue:
		return role == searchOptionFlag || strings.TrimSpace(value) != ""
	case searchOptionPattern:
		if strings.TrimSpace(value) == "" {
			return false
		}
		parsed.patternProvided = true
	case searchOptionPatternFile:
		if strings.TrimSpace(value) == "" {
			return false
		}
		parsed.patternProvided = true
		parsed.paths = append(parsed.paths, guardedPathOperand{value: value, access: pathAccessExact})
	case searchOptionPath:
		if strings.TrimSpace(value) == "" {
			return false
		}
		parsed.paths = append(parsed.paths, guardedPathOperand{value: value, access: pathAccessExact})
	case searchOptionFilesMode:
		parsed.filesMode = true
	case searchOptionNoSearch:
		parsed.noSearch = true
	case searchOptionNoSearchValue:
		if strings.TrimSpace(value) == "" {
			return false
		}
		parsed.noSearch = true
	default:
		return false
	}
	return true
}

func finalizeSearchArguments(parsed parsedSearchArguments, allowFilesMode bool) ([]guardedPathOperand, bool) {
	if parsed.noSearch {
		if len(parsed.beforeSeparator) != 0 || len(parsed.afterSeparator) != 0 || parsed.patternProvided || parsed.filesMode {
			return nil, false
		}
		return parsed.paths, true
	}
	positionals := append(append([]string(nil), parsed.beforeSeparator...), parsed.afterSeparator...)
	if parsed.filesMode {
		if !allowFilesMode || parsed.patternProvided {
			return nil, false
		}
	} else if !parsed.patternProvided {
		if len(positionals) == 0 {
			return nil, false
		}
		positionals = positionals[1:]
	}
	for _, value := range positionals {
		if strings.TrimSpace(value) == "" {
			return nil, false
		}
		parsed.paths = append(parsed.paths, guardedPathOperand{value: value, access: pathAccessRecursive})
	}
	if len(positionals) == 0 {
		parsed.paths = append(parsed.paths, guardedPathOperand{value: ".", access: pathAccessRecursive})
	}
	return parsed.paths, true
}

func gitGrepPathOperands(args []string, cwd string) ([]guardedPathOperand, bool, bool) {
	subcommand := -1
	for index, token := range args {
		if strings.EqualFold(token, "--no-optional-locks") {
			continue
		}
		if strings.HasPrefix(token, "-") {
			return nil, false, true
		}
		if strings.EqualFold(token, "grep") {
			subcommand = index
		}
		break
	}
	if subcommand < 0 {
		return nil, false, true
	}
	noIndex := false
	for _, token := range args[subcommand+1:] {
		if token == "--" {
			break
		}
		if strings.EqualFold(token, "--no-index") {
			noIndex = true
		}
	}
	parsed, ok := parseDashSearchArguments(args[subcommand+1:], gitGrepShortSearchOptions, gitGrepLongSearchOptions)
	if !ok || parsed.filesMode || parsed.noSearch {
		return nil, true, false
	}
	before := append([]string(nil), parsed.beforeSeparator...)
	if !parsed.patternProvided {
		if len(before) > 0 {
			before = before[1:]
		} else if parsed.separator && len(parsed.afterSeparator) > 0 {
			parsed.afterSeparator = parsed.afterSeparator[1:]
		} else {
			return nil, true, false
		}
	}
	// Before `--`, operands following the pattern may be revisions or paths.
	// That ambiguity is security-relevant, so only the explicit pathspec side
	// of the separator is accepted as a search root.
	if len(before) != 0 {
		return nil, true, false
	}
	if parsed.separator && len(parsed.afterSeparator) > 0 {
		for _, value := range parsed.afterSeparator {
			parsed.paths = append(parsed.paths, guardedPathOperand{value: value, access: pathAccessRecursive})
		}
		return parsed.paths, true, true
	}
	root, ok := "", false
	if !noIndex {
		root, ok = gitRepositoryRoot(cwd)
	}
	if !ok {
		root, ok = actualWorkingDirectory(cwd)
		if !ok {
			return nil, true, false
		}
	}
	parsed.paths = append(parsed.paths, guardedPathOperand{value: root, base: root, access: pathAccessRecursive})
	return parsed.paths, true, true
}

func gitRepositoryRoot(cwd string) (string, bool) {
	root, ok := actualWorkingDirectory(cwd)
	if !ok {
		return "", false
	}
	for {
		if info, err := os.Stat(filepath.Join(root, ".git")); err == nil && (info.IsDir() || info.Mode().IsRegular()) {
			return root, true
		}
		parent := filepath.Dir(root)
		if samePathOrFile(parent, root) {
			return "", false
		}
		root = parent
	}
}

func findstrPathOperands(args []string, dialect catalog.BashShellDialect) ([]guardedPathOperand, bool) {
	var operands []guardedPathOperand
	var positionals []string
	patternProvided := false
	for _, token := range args {
		if strings.HasPrefix(token, "/") && commandOption(token, dialect) {
			lower := strings.ToLower(token)
			switch {
			case strings.HasPrefix(lower, "/c:"):
				patternProvided = strings.TrimSpace(token[3:]) != ""
			case strings.HasPrefix(lower, "/g:") || strings.HasPrefix(lower, "/f:"):
				if len(token) <= 3 {
					return nil, false
				}
				if strings.HasPrefix(lower, "/g:") {
					patternProvided = true
				}
				operands = append(operands, guardedPathOperand{value: token[3:], access: pathAccessExact})
			case strings.HasPrefix(lower, "/d:"):
				for _, root := range strings.Split(token[3:], ";") {
					if strings.TrimSpace(root) == "" {
						return nil, false
					}
					operands = append(operands, guardedPathOperand{value: root, access: pathAccessRecursive})
				}
			case lower == "/b" || lower == "/e" || lower == "/l" || lower == "/r" || lower == "/s" || lower == "/i" || lower == "/x" || lower == "/v" || lower == "/n" || lower == "/m" || lower == "/o" || lower == "/p" || lower == "/off" || lower == "/?":
			default:
				return nil, false
			}
			continue
		}
		positionals = append(positionals, token)
	}
	if !patternProvided {
		if len(positionals) == 0 {
			return nil, false
		}
		positionals = positionals[1:]
	}
	for _, value := range positionals {
		operands = append(operands, guardedPathOperand{value: value, access: pathAccessRecursive})
	}
	if len(positionals) == 0 {
		operands = append(operands, guardedPathOperand{value: ".", access: pathAccessRecursive})
	}
	return operands, true
}

func selectStringPathOperands(args []string) ([]guardedPathOperand, bool) {
	var operands []guardedPathOperand
	var positionals []string
	patternProvided := false
	for index := 0; index < len(args); index++ {
		token := args[index]
		if token == "--" {
			positionals = append(positionals, args[index+1:]...)
			break
		}
		if !strings.HasPrefix(token, "-") || token == "-" {
			positionals = append(positionals, token)
			continue
		}
		name, attached, hasAttached := strings.Cut(token, ":")
		lower := strings.ToLower(name)
		switch lower {
		case "-pattern", "-path", "-literalpath", "-include", "-exclude", "-encoding", "-context", "-culture":
			value := attached
			if !hasAttached {
				if index+1 >= len(args) || args[index+1] == "--" {
					return nil, false
				}
				index++
				value = args[index]
			}
			if strings.TrimSpace(value) == "" {
				return nil, false
			}
			if lower == "-pattern" {
				patternProvided = true
			} else if lower == "-path" || lower == "-literalpath" {
				for _, path := range strings.Split(value, ",") {
					operands = append(operands, guardedPathOperand{value: path, access: pathAccessRecursive})
				}
			}
		case "-simplematch", "-casesensitive", "-quiet", "-list", "-raw", "-allmatches", "-notmatch", "-noemphasis":
			if hasAttached {
				return nil, false
			}
		default:
			return nil, false
		}
	}
	if !patternProvided {
		if len(positionals) == 0 {
			return nil, false
		}
		positionals = positionals[1:]
	}
	for _, value := range positionals {
		operands = append(operands, guardedPathOperand{value: value, access: pathAccessRecursive})
	}
	if len(operands) == 0 {
		operands = append(operands, guardedPathOperand{value: ".", access: pathAccessRecursive})
	}
	return operands, true
}

func filesystemCommandAccess(words []string) (pathAccess, bool) {
	if len(words) == 0 {
		return 0, false
	}
	name := strings.ToLower(filepath.Base(words[0]))
	name = strings.TrimSuffix(name, ".exe")
	switch name {
	case "cat", "head", "tail", "type", "get-content", "gc", "wc", "stat", "du", "file", "get-item", "resolve-path", "findstr", "select-string":
		return pathAccessExact, true
	case "grep", "rg":
		return pathAccessRecursive, true
	case "tree", "find":
		return pathAccessRecursive, true
	case "ls", "dir", "get-childitem", "gci":
		for _, word := range words[1:] {
			if strings.EqualFold(word, "-Recurse") || strings.EqualFold(word, "-R") {
				return pathAccessRecursive, true
			}
		}
		return pathAccessListing, true
	default:
		return 0, false
	}
}

func commandOption(word string, dialect catalog.BashShellDialect) bool {
	if strings.HasPrefix(word, "-") {
		return true
	}
	windowsShell := dialect == catalog.BashShellCmd || dialect == catalog.BashShellPowerShell || dialect == catalog.BashShellWindowsAmbiguous
	return windowsShell && strings.HasPrefix(word, "/") && !strings.ContainsAny(strings.TrimPrefix(word, "/"), `/\`)
}

func attachedOptionPathValues(word string) []string {
	values := []string{}
	for _, delimiter := range []string{"=", ":"} {
		if index := strings.Index(word, delimiter); index > 1 && index+1 < len(word) {
			values = append(values, word[index+1:])
		}
	}
	return values
}

type commandSeparator uint8

const (
	commandSeparatorStart commandSeparator = iota
	commandSeparatorSequential
	commandSeparatorAnd
	commandSeparatorOr
	commandSeparatorPipe
	commandSeparatorBackground
)

type commandWords struct {
	words  []string
	before commandSeparator
	after  commandSeparator
}

func commandWordSegments(command string, dialect catalog.BashShellDialect) ([]commandWords, bool) {
	backslashEscapes := dialect == catalog.BashShellPOSIX
	singleQuotes := dialect != catalog.BashShellCmd
	if !catalog.ValidBashShellDialect(dialect) {
		return nil, false
	}
	var segments []commandWords
	var words []string
	var current strings.Builder
	var quote rune
	escaped := false
	inWord := false
	before := commandSeparatorStart
	flushWord := func() {
		if inWord {
			words = append(words, current.String())
			current.Reset()
			inWord = false
		}
	}
	flushSegment := func(next commandSeparator) bool {
		flushWord()
		if len(words) == 0 {
			return false
		}
		segments = append(segments, commandWords{words: words, before: before, after: next})
		words = nil
		before = next
		return true
	}
	runes := []rune(strings.TrimSpace(command))
	for index := 0; index < len(runes); index++ {
		r := runes[index]
		if escaped {
			current.WriteRune(r)
			inWord = true
			escaped = false
			continue
		}
		if r == '\\' && quote != '\'' && backslashEscapes {
			escaped = true
			inWord = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			} else {
				current.WriteRune(r)
			}
			inWord = true
			continue
		}
		if r == '"' || r == '\'' && singleQuotes {
			quote = r
			inWord = true
			continue
		}
		if unicode.IsSpace(r) && r != '\r' && r != '\n' {
			flushWord()
			continue
		}
		switch r {
		case ';', '|':
			next := commandSeparatorSequential
			if r == '|' && index+1 < len(runes) && runes[index+1] == '|' {
				index++
				next = commandSeparatorOr
			} else if r == '|' {
				next = commandSeparatorPipe
			}
			if !flushSegment(next) {
				return nil, false
			}
		case '&':
			if index+1 < len(runes) && runes[index+1] == '&' {
				index++
				if !flushSegment(commandSeparatorAnd) {
					return nil, false
				}
				continue
			}
			if index+1 < len(runes) && runes[index+1] == '>' {
				return nil, false
			}
			if !flushSegment(commandSeparatorBackground) {
				return nil, false
			}
		case '\r', '\n':
			if r == '\r' && index+1 < len(runes) && runes[index+1] == '\n' {
				index++
			}
			flushWord()
			if len(words) > 0 && !flushSegment(commandSeparatorSequential) {
				return nil, false
			}
		default:
			current.WriteRune(r)
			inWord = true
		}
	}
	if quote != 0 || escaped {
		return nil, false
	}
	flushWord()
	if len(words) > 0 {
		segments = append(segments, commandWords{words: words, before: before})
	}
	return segments, len(segments) > 0
}
