package catalog

import (
	"fmt"
	"path"
	"runtime"
	"strings"
	"unicode"
)

// BashRule is a client-neutral command pattern. A trailing " *" accepts
// arguments; all other patterns are exact. Adapters add their native Bash(...)
// wrapper only at the encoding boundary.
type BashRule struct {
	Pattern string
}

// BashShellDialect names the separator/escape contract used by the client
// that will execute a guarded command.
type BashShellDialect string

const (
	BashShellPOSIX            BashShellDialect = "posix"
	BashShellCmd              BashShellDialect = "cmd"
	BashShellPowerShell       BashShellDialect = "powershell"
	BashShellWindowsAmbiguous BashShellDialect = "windows-ambiguous"
)

type bashShellSyntax struct {
	backslashEscapes           bool
	singleQuotes               bool
	denySingleQuotedSeparators bool
	caseInsensitiveExecutable  bool
}

var readonlyBashRules = []BashRule{
	{Pattern: "pwd"}, {Pattern: "ls"}, {Pattern: "ls *"}, {Pattern: "dir"}, {Pattern: "dir *"},
	{Pattern: "cat *"}, {Pattern: "head *"}, {Pattern: "tail *"}, {Pattern: "grep *"}, {Pattern: "rg *"},
	{Pattern: "wc *"}, {Pattern: "stat *"}, {Pattern: "du *"}, {Pattern: "file *"}, {Pattern: "tree *"},
	{Pattern: "which *"}, {Pattern: "where.exe *"}, {Pattern: "cd"}, {Pattern: "cd *"}, {Pattern: "type *"},
	{Pattern: "find *"}, {Pattern: "findstr *"},
	{Pattern: "Get-Location"}, {Pattern: "Get-ChildItem"}, {Pattern: "Get-ChildItem *"},
	{Pattern: "Get-Content *"}, {Pattern: "Select-String *"}, {Pattern: "Measure-Object *"},
	{Pattern: "Get-Item *"}, {Pattern: "Get-Command *"}, {Pattern: "Resolve-Path *"},
	{Pattern: "git --no-optional-locks status"}, {Pattern: "git --no-optional-locks status *"},
	{Pattern: "git --no-optional-locks grep *"},
	{Pattern: "git --no-optional-locks ls-files"}, {Pattern: "git --no-optional-locks ls-files *"},
	{Pattern: "git --no-optional-locks rev-parse *"}, {Pattern: "git --no-optional-locks branch --show-current"},
}

var editOnlyBashRules = []BashRule{
	{Pattern: "mkdir *"}, {Pattern: "cp *"}, {Pattern: "copy *"}, {Pattern: "mv *"}, {Pattern: "move *"},
	// The encoded deletion surface is the recoverable tracked-file form
	// git rm -- <operand>. The trailing wildcard only authorizes a command
	// shape; semanticGitRmBoundary rejects any other git rm invocation.
	{Pattern: "git rm -- *"},
	{Pattern: "touch *"}, {Pattern: "chmod *"}, {Pattern: "ln *"},
	{Pattern: "New-Item *"}, {Pattern: "Copy-Item *"}, {Pattern: "Move-Item *"}, {Pattern: "Remove-Item *"},
}

// BashDenyRules are explicit safety denials retained even when a native client
// also applies an allowlist. Unsafe option patterns are retained here for
// native-only adapters such as OpenCode. Hooked adapters filter those ambiguous
// patterns and use the shared argv parser instead: a native tree(*-o*) glob
// would both miss clustered -ao and wrongly deny a harmless filename containing
// "-o". The list intentionally does not include Bash(*); unrestricted mode
// remains a separate explicit policy choice.
var BashDenyRules = []BashRule{
	{Pattern: "*$*"},
	{Pattern: "*`*"},
	{Pattern: "*>*"},
	{Pattern: "*<*"},
	{Pattern: "*%*"},
	{Pattern: "*^*"},
	{Pattern: "*&*"},
	{Pattern: "*{*"},
	{Pattern: "*}*"},
	{Pattern: "*(*"},
	{Pattern: "*)*"},
	{Pattern: "*@(*"},
	{Pattern: "find *-delete*"},
	{Pattern: "find *-exec*"},
	{Pattern: "find *-ok*"},
	{Pattern: "find *-fprint*"},
	{Pattern: "find *-fprintf*"},
	{Pattern: "find *-fls*"},
	{Pattern: "rg *--pre*"},
	{Pattern: "rg *--hostname-bin*"},
	{Pattern: "rg *--search-zip*"},
	{Pattern: "rg -z*"},
	{Pattern: "rg * -z*"},
	{Pattern: "git *--output *"},
	{Pattern: "git *--output=*"},
	{Pattern: "git *--output"},
	{Pattern: "git *--ext-diff*"},
	{Pattern: "git *--textconv*"},
	{Pattern: "git *--show-signature*"},
	{Pattern: "git *--open-files-in-pager*"},
	{Pattern: "git *--ext-grep*"},
	{Pattern: "git *--recurse-submodules*"},
	{Pattern: "git *grep *-O*"},
	{Pattern: "tree *-o*"},
	{Pattern: "tree *--output*"},
	{Pattern: "file *-C*"},
	{Pattern: "file *--compile*"},
}

func sharedGuardOwnsNativeDeny(rule BashRule) bool {
	pattern := strings.TrimSpace(rule.Pattern)
	return strings.HasPrefix(pattern, "find ") || strings.HasPrefix(pattern, "rg ") ||
		strings.HasPrefix(pattern, "git ") || strings.HasPrefix(pattern, "tree ") ||
		strings.HasPrefix(pattern, "file ")
}

// BashAllowed evaluates every command segment separated by &&, ||, semicolon,
// pipe, CR, or LF. Every segment must independently match a builtin or capability rule;
// a malformed split, command substitution, redirection, expansion, unsafe
// command option, or a single background '&' fails closed. An unrestricted
// policy delegates the command to the native shell without Forge Bash rules.
func BashAllowed(policy PermissionPolicy, command string) bool {
	return BashAllowedForPlatform(policy, command, runtime.GOOS)
}

// BashAllowedForPlatform applies the restricted command policy using the
// separator and escape rules of the execution platform. Windows cmd and
// PowerShell both treat backslash as an ordinary path character, while POSIX
// shells use it to escape the following byte. Unknown platforms fail closed
// because their client shell cannot be inferred safely.
func BashAllowedForPlatform(policy PermissionPolicy, command, goos string) bool {
	dialect, ok := BashShellDialectForPlatform(goos)
	if !ok {
		return policy.BashUnrestricted && strings.TrimSpace(command) != ""
	}
	return BashAllowedForShell(policy, command, dialect)
}

// BashShellDialectForPlatform maps an execution platform to the shell
// contract used by restricted command matching. Callers that plan for a child
// platform different from the host must carry this result in their payload.
func BashShellDialectForPlatform(goos string) (BashShellDialect, bool) {
	return platformShellDialect(goos)
}

// BashAllowedForShell evaluates a command against one explicit shell dialect.
// The ambiguous Windows mode accepts only syntax whose separator meaning is
// shared by cmd and PowerShell.
func BashAllowedForShell(policy PermissionPolicy, command string, dialect BashShellDialect) bool {
	if strings.TrimSpace(command) == "" {
		return false
	}
	if policy.BashUnrestricted {
		return true
	}
	syntax, ok := shellSyntax(dialect)
	if !ok {
		return false
	}
	segments, ok := splitCommandSegments(command, syntax)
	if !ok || len(segments) == 0 {
		return false
	}
	if !semanticGitRmBoundary(segments, syntax) {
		return false
	}
	for _, segment := range segments {
		if unsafeBashSegment(segment, syntax) {
			return false
		}
		if !matchesAnyBashRule(segment, append(cloneBashRules(policy.BashGate.Builtin), policy.BashGate.Cap...), syntax.caseInsensitiveExecutable) {
			return false
		}
	}
	return true
}

func platformShellDialect(goos string) (BashShellDialect, bool) {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "windows":
		return BashShellWindowsAmbiguous, true
	case "aix", "android", "darwin", "dragonfly", "freebsd", "illumos", "ios", "linux", "netbsd", "openbsd", "solaris":
		return BashShellPOSIX, true
	default:
		return "", false
	}
}

func shellSyntax(dialect BashShellDialect) (bashShellSyntax, bool) {
	switch dialect {
	case BashShellPOSIX:
		return bashShellSyntax{backslashEscapes: true, singleQuotes: true}, true
	case BashShellCmd:
		return bashShellSyntax{caseInsensitiveExecutable: true}, true
	case BashShellPowerShell:
		return bashShellSyntax{singleQuotes: true, caseInsensitiveExecutable: true}, true
	case BashShellWindowsAmbiguous:
		return bashShellSyntax{singleQuotes: true, denySingleQuotedSeparators: true, caseInsensitiveExecutable: true}, true
	default:
		return bashShellSyntax{}, false
	}
}

// ValidBashShellDialect validates a dialect at payload boundaries without
// exposing the internal parsing configuration.
func ValidBashShellDialect(dialect BashShellDialect) bool {
	_, ok := shellSyntax(dialect)
	return ok
}

// EffectiveBashAllow returns the complete restricted Bash allowlist after
// capability contribution. Native adapters and per-run execution guards must
// both consume this function so their approved command scope cannot drift.
// Yolo is represented by BashUnrestricted and deliberately has no finite
// allowlist.
func EffectiveBashAllow(policy PermissionPolicy, capBash []BashRule) ([]BashRule, error) {
	if err := ValidateCapabilityBashRules(capBash); err != nil {
		return nil, err
	}
	if policy.BashUnrestricted {
		return nil, nil
	}
	return append(cloneBashRules(policy.BashGate.Builtin), capBash...), nil
}

func EncodeBashRule(rule BashRule) string {
	return "Bash(" + rule.Pattern + ")"
}

func splitCommandSegments(command string, syntax bashShellSyntax) ([]string, bool) {
	var segments []string
	var current strings.Builder
	var quote rune
	escaped := false
	flush := func() bool {
		segment := strings.TrimSpace(current.String())
		current.Reset()
		if segment == "" {
			return false
		}
		segments = append(segments, segment)
		return true
	}
	runes := []rune(strings.TrimSpace(command))
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if escaped {
			if r == '\n' {
				escaped = false
				continue
			}
			if r == '\r' && i+1 < len(runes) && runes[i+1] == '\n' {
				i++
				escaped = false
				continue
			}
			current.WriteRune('\\')
			current.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' && quote != '\'' && syntax.backslashEscapes {
			escaped = true
			continue
		}
		if quote != 0 {
			if quote == '\'' && syntax.denySingleQuotedSeparators && strings.ContainsRune(";|&\r\n", r) {
				return nil, false
			}
			current.WriteRune(r)
			if r == quote {
				quote = 0
			}
			continue
		}
		if r == '"' || r == '\'' && syntax.singleQuotes {
			quote = r
			current.WriteRune(r)
			continue
		}
		switch r {
		case ';', '|':
			if r == '|' && i+1 < len(runes) && runes[i+1] == '|' {
				i++
			}
			if !flush() {
				return nil, false
			}
		case '&':
			if i+1 >= len(runes) || runes[i+1] != '&' {
				return nil, false
			}
			i++
			if !flush() {
				return nil, false
			}
		case '\r', '\n':
			if r == '\r' && i+1 < len(runes) && runes[i+1] == '\n' {
				i++
			}
			// Shell line separators are compound-command boundaries too. Blank
			// lines and a line immediately following an explicit separator do
			// not create an empty executable segment.
			if strings.TrimSpace(current.String()) != "" && !flush() {
				return nil, false
			}
		default:
			current.WriteRune(r)
		}
	}
	if quote != 0 || escaped {
		return nil, false
	}
	if strings.TrimSpace(current.String()) != "" {
		if !flush() {
			return nil, false
		}
	} else if len(segments) == 0 {
		return nil, false
	}
	return segments, true
}

func unsafeBashSegment(segment string, syntax bashShellSyntax) bool {
	// Restricted native adapters cannot distinguish quoted literals from
	// executable PowerShell expression syntax. Keep the neutral evaluator at
	// least as strict as those downstream rules: script blocks, grouping,
	// subexpressions, array expressions, and invocation operators all fail
	// closed before an allowlisted command prefix can authorize them.
	if containsUnsafeShellSyntax(segment, syntax.backslashEscapes) || strings.Contains(segment, "$(") || strings.Contains(segment, "@(") {
		return true
	}
	trimmed := strings.TrimSpace(segment)
	if strings.HasPrefix(trimmed, "(") || strings.HasSuffix(trimmed, ")") {
		return true
	}
	for i, r := range trimmed {
		if unicode.IsSpace(r) {
			break
		}
		if r == '=' && i > 0 {
			return true
		}
	}
	args, ok := splitBashWords(trimmed)
	return !ok || unsafeBashArguments(args, syntax.caseInsensitiveExecutable)
}

func containsUnsafeShellSyntax(segment string, backslashEscapes bool) bool {
	escaped := false
	for _, r := range segment {
		if escaped {
			escaped = false
			continue
		}
		if r == '\\' && backslashEscapes {
			escaped = true
			continue
		}
		if strings.ContainsRune("$`<>%^&{}()\r\n", r) {
			return true
		}
	}
	return escaped
}

func splitBashWords(segment string) ([]string, bool) {
	var words []string
	var current strings.Builder
	var quote rune
	escaped := false
	inWord := false
	flush := func() {
		if !inWord {
			return
		}
		words = append(words, current.String())
		current.Reset()
		inWord = false
	}
	for _, r := range segment {
		if escaped {
			current.WriteRune(r)
			inWord = true
			escaped = false
			continue
		}
		if r == '\\' && quote != '\'' {
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
		if r == '\'' || r == '"' {
			quote = r
			inWord = true
			continue
		}
		if unicode.IsSpace(r) {
			flush()
			continue
		}
		current.WriteRune(r)
		inWord = true
	}
	if quote != 0 || escaped {
		return nil, false
	}
	flush()
	return words, len(words) > 0
}

func unsafeBashArguments(args []string, caseInsensitiveExecutable bool) bool {
	if len(args) == 0 {
		return true
	}
	switch {
	case executableEqual(args[0], "find", caseInsensitiveExecutable):
		return hasFindUnsafeOption(args[1:])
	case executableEqual(args[0], "rg", caseInsensitiveExecutable):
		return hasRipgrepUnsafeOption(args[1:])
	case executableEqual(args[0], "git", caseInsensitiveExecutable):
		return hasGitUnsafeOption(args[1:])
	case executableEqual(args[0], "tree", caseInsensitiveExecutable):
		return hasTreeUnsafeOption(args[1:])
	case executableEqual(args[0], "file", caseInsensitiveExecutable):
		return hasFileUnsafeOption(args[1:])
	default:
		return false
	}
}

// semanticGitRmBoundary is the fail-closed semantic gate behind the encoded
// deletion rule Bash(git rm -- *). That wildcard rule authorizes a command
// shape, not arbitrary operands: the whole command must be exactly one segment
// invoking git rm with exactly one forward-slash relative file path operand.
// Chaining, extra operands, glob or pathspec metacharacters, flags,
// absolute/tilde/drive/UNC paths, parent traversal, dot targets, trailing
// separators, and quoted or escaped operands all fail closed.
func semanticGitRmBoundary(segments []string, syntax bashShellSyntax) bool {
	gitRmSegments := 0
	for _, segment := range segments {
		if isGitRmInvocation(segment, syntax) {
			gitRmSegments++
		}
	}
	if gitRmSegments == 0 {
		return true
	}
	if len(segments) != 1 || gitRmSegments != 1 {
		return false
	}
	segment := strings.TrimSpace(segments[0])
	if strings.ContainsAny(segment, `'"\\`) {
		return false
	}
	args, ok := splitBashWords(segment)
	if !ok || len(args) != 4 {
		return false
	}
	return validSinglePathOperand(args[3])
}

func isGitRmInvocation(segment string, syntax bashShellSyntax) bool {
	args, ok := splitBashWords(strings.TrimSpace(segment))
	if !ok || len(args) < 3 {
		return false
	}
	return executableEqual(args[0], "git", syntax.caseInsensitiveExecutable) &&
		executableEqual(args[1], "rm", syntax.caseInsensitiveExecutable) &&
		args[2] == "--"
}

// validSinglePathOperand accepts one forward-slash relative file path after
// optional normalization of a single leading "./".
func validSinglePathOperand(operand string) bool {
	if operand == "" || strings.HasPrefix(operand, "-") {
		return false
	}
	for _, r := range operand {
		if unicode.IsSpace(r) {
			return false
		}
	}
	if strings.ContainsAny(operand, "'\"\\*?[]<>$\x60&{}()") {
		return false
	}
	if strings.HasPrefix(operand, "~") {
		return false
	}
	if len(operand) >= 2 && operand[1] == ':' &&
		(operand[0] >= 'a' && operand[0] <= 'z' || operand[0] >= 'A' && operand[0] <= 'Z') {
		return false
	}
	if strings.HasSuffix(operand, "/") {
		return false
	}
	for index, component := range strings.Split(operand, "/") {
		if component == ".." {
			return false
		}
		if component == "." && index != 0 {
			return false
		}
	}
	normalized := path.Clean(operand)
	if normalized == "" || normalized == "." || normalized == ".." ||
		strings.HasPrefix(normalized, "/") || strings.HasPrefix(normalized, "../") ||
		strings.HasPrefix(normalized, "~") || strings.HasPrefix(normalized, "-") {
		return false
	}
	return true
}

func hasFindUnsafeOption(args []string) bool {
	unsafe := map[string]bool{
		"-delete": true, "-exec": true, "-execdir": true, "-ok": true, "-okdir": true,
		"-fprint": true, "-fprint0": true, "-fprintf": true, "-fls": true,
	}
	for _, arg := range args {
		if unsafe[strings.ToLower(arg)] {
			return true
		}
	}
	return false
}

func hasRipgrepUnsafeOption(args []string) bool {
	for _, arg := range args {
		lower := strings.ToLower(arg)
		if longOption(lower, "--pre") || longOption(lower, "--pre-glob") ||
			longOption(lower, "--hostname-bin") || lower == "--search-zip" {
			return true
		}
		if strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") && strings.Contains(arg[1:], "z") {
			return true
		}
	}
	return false
}

func hasGitUnsafeOption(args []string) bool {
	subcommand := ""
	subcommandIndex := -1
	for index, arg := range args {
		if arg == "--" {
			break
		}
		if strings.EqualFold(arg, "--no-optional-locks") {
			continue
		}
		if !strings.HasPrefix(arg, "-") {
			subcommand = strings.ToLower(arg)
			subcommandIndex = index
			break
		}
	}
	for _, arg := range args {
		if arg == "--" {
			break
		}
		lower := strings.ToLower(arg)
		if longOption(lower, "--output") || lower == "--ext-diff" || lower == "--textconv" ||
			lower == "--show-signature" || longOption(lower, "--open-files-in-pager") ||
			lower == "--ext-grep" || lower == "--recurse-submodules" {
			return true
		}
	}
	if subcommand == "grep" && subcommandIndex >= 0 {
		return hasGitGrepUnsafeShortOption(args[subcommandIndex+1:])
	}
	return false
}

func hasTreeUnsafeOption(args []string) bool {
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			return false
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			continue
		}
		lower := strings.ToLower(arg)
		if strings.HasPrefix(lower, "--") {
			if longOption(lower, "--output") {
				return true
			}
			continue
		}
		options, consumed, ok := parseShortOptionCluster(args, index, treeShortOptionGrammar)
		if !ok {
			return true
		}
		index += consumed
		for _, option := range options {
			if option.name == 'o' {
				return true
			}
		}
	}
	return false
}

func hasFileUnsafeOption(args []string) bool {
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			return false
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			continue
		}
		lower := strings.ToLower(arg)
		if strings.HasPrefix(lower, "--") {
			if longOption(lower, "--compile") || longOption(lower, "--magic-file") {
				return true
			}
			continue
		}
		options, consumed, ok := parseShortOptionCluster(args, index, fileShortOptionGrammar)
		if !ok {
			return true
		}
		index += consumed
		for _, option := range options {
			if option.name == 'C' || option.name == 'm' {
				return true
			}
		}
	}
	return false
}

type shortOptionValueMode uint8

const (
	shortOptionFlag shortOptionValueMode = iota
	shortOptionRequiredValue
	shortOptionOptionalAttachedValue
)

type parsedShortOption struct {
	name  byte
	value string
}

// parseShortOptionCluster is the single short-option grammar boundary used by
// restricted commands whose dangerous switches may follow benign switches in
// the same token. A required value consumes the rest of its cluster or the
// following argv token; an optional value is attached-only. Unknown options,
// missing values, and malformed non-option inputs fail closed.
func parseShortOptionCluster(args []string, index int, grammar map[byte]shortOptionValueMode) ([]parsedShortOption, int, bool) {
	if index < 0 || index >= len(args) {
		return nil, 0, false
	}
	token := args[index]
	if len(token) < 2 || token[0] != '-' || token == "-" || strings.HasPrefix(token, "--") {
		return nil, 0, false
	}
	cluster := token[1:]
	options := make([]parsedShortOption, 0, len(cluster))
	for offset := 0; offset < len(cluster); offset++ {
		name := cluster[offset]
		mode, known := grammar[name]
		if !known {
			return nil, 0, false
		}
		option := parsedShortOption{name: name}
		switch mode {
		case shortOptionFlag:
			options = append(options, option)
		case shortOptionRequiredValue:
			if offset+1 < len(cluster) {
				option.value = cluster[offset+1:]
				options = append(options, option)
				return options, 0, true
			}
			if index+1 >= len(args) || args[index+1] == "" {
				return nil, 0, false
			}
			option.value = args[index+1]
			options = append(options, option)
			return options, 1, true
		case shortOptionOptionalAttachedValue:
			if offset+1 < len(cluster) {
				option.value = cluster[offset+1:]
			}
			options = append(options, option)
			return options, 0, true
		default:
			return nil, 0, false
		}
	}
	return options, 0, len(options) > 0
}

var treeShortOptionGrammar = map[byte]shortOptionValueMode{
	'a': shortOptionFlag, 'd': shortOptionFlag, 'l': shortOptionFlag, 'f': shortOptionFlag,
	'x': shortOptionFlag, 'L': shortOptionRequiredValue, 'R': shortOptionFlag,
	'P': shortOptionRequiredValue, 'I': shortOptionRequiredValue, 'o': shortOptionRequiredValue,
	'i': shortOptionFlag, 'q': shortOptionFlag, 'N': shortOptionFlag, 'Q': shortOptionFlag,
	'p': shortOptionFlag, 'u': shortOptionFlag, 'g': shortOptionFlag, 's': shortOptionFlag,
	'h': shortOptionFlag, 'D': shortOptionFlag, 'F': shortOptionFlag, 'v': shortOptionFlag,
	'X': shortOptionFlag, 'J': shortOptionFlag, 'H': shortOptionRequiredValue,
	'T': shortOptionRequiredValue, 'r': shortOptionFlag, 'U': shortOptionFlag,
}

var fileShortOptionGrammar = map[byte]shortOptionValueMode{
	'b': shortOptionFlag, 'C': shortOptionFlag, 'c': shortOptionFlag, 'd': shortOptionFlag,
	'E': shortOptionFlag, 'e': shortOptionRequiredValue, 'F': shortOptionRequiredValue,
	'f': shortOptionRequiredValue, 'h': shortOptionFlag, 'i': shortOptionFlag,
	'k': shortOptionFlag, 'l': shortOptionFlag, 'L': shortOptionFlag,
	'm': shortOptionRequiredValue, 'N': shortOptionFlag, 'n': shortOptionFlag,
	'p': shortOptionFlag, 'P': shortOptionRequiredValue, 'r': shortOptionFlag,
	's': shortOptionFlag, 'S': shortOptionFlag, 'v': shortOptionFlag,
	'z': shortOptionFlag, 'Z': shortOptionFlag, '0': shortOptionFlag,
}

var gitGrepShortOptionGrammar = map[byte]shortOptionValueMode{
	'a': shortOptionFlag, 'I': shortOptionFlag, 'i': shortOptionFlag, 'w': shortOptionFlag,
	'v': shortOptionFlag, 'h': shortOptionFlag, 'H': shortOptionFlag,
	'E': shortOptionFlag, 'G': shortOptionFlag, 'P': shortOptionFlag, 'F': shortOptionFlag,
	'n': shortOptionFlag, 'l': shortOptionFlag, 'L': shortOptionFlag, 'o': shortOptionFlag,
	'c': shortOptionFlag, 'p': shortOptionFlag, 'W': shortOptionFlag, 'q': shortOptionFlag,
	'z': shortOptionFlag, 'e': shortOptionRequiredValue, 'f': shortOptionRequiredValue,
	'm': shortOptionRequiredValue, 'A': shortOptionRequiredValue, 'B': shortOptionRequiredValue,
	'C': shortOptionRequiredValue, 'O': shortOptionOptionalAttachedValue,
	'0': shortOptionFlag, '1': shortOptionFlag, '2': shortOptionFlag, '3': shortOptionFlag,
	'4': shortOptionFlag, '5': shortOptionFlag, '6': shortOptionFlag, '7': shortOptionFlag,
	'8': shortOptionFlag, '9': shortOptionFlag,
}

func hasGitGrepUnsafeShortOption(args []string) bool {
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			return false
		}
		if !strings.HasPrefix(arg, "-") || strings.HasPrefix(arg, "--") {
			continue
		}
		options, consumed, ok := parseShortOptionCluster(args, index, gitGrepShortOptionGrammar)
		if !ok {
			return true
		}
		index += consumed
		for _, option := range options {
			if option.name == 'O' {
				return true
			}
		}
	}
	return false
}

// RestrictedShortOptionValues returns attached and following-token values from
// the same verified short-option grammars used by restricted command safety.
// BashGate uses these values as conservative path operands so forms such as
// file -f/path or git grep -f/path cannot bypass canonical sensitive-path
// checks. Commands outside this small grammar have no values to contribute.
func RestrictedShortOptionValues(args []string) ([]string, bool) {
	if len(args) == 0 {
		return nil, false
	}
	name := strings.ToLower(strings.TrimSuffix(filepathBase(args[0]), ".exe"))
	switch name {
	case "tree":
		return shortOptionValues(args[1:], treeShortOptionGrammar)
	case "file":
		return shortOptionValues(args[1:], fileShortOptionGrammar)
	case "git":
		subcommandIndex := -1
		for index, arg := range args[1:] {
			if arg == "--" {
				break
			}
			if strings.EqualFold(arg, "--no-optional-locks") || strings.HasPrefix(arg, "-") {
				continue
			}
			if strings.EqualFold(arg, "grep") {
				subcommandIndex = index + 1
			}
			break
		}
		if subcommandIndex >= 0 {
			return shortOptionValues(args[subcommandIndex+1:], gitGrepShortOptionGrammar)
		}
		return nil, true
	default:
		return nil, true
	}
}

func shortOptionValues(args []string, grammar map[byte]shortOptionValueMode) ([]string, bool) {
	var values []string
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			return values, true
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" || strings.HasPrefix(arg, "--") {
			continue
		}
		options, consumed, ok := parseShortOptionCluster(args, index, grammar)
		if !ok {
			return nil, false
		}
		index += consumed
		for _, option := range options {
			if option.value != "" {
				values = append(values, option.value)
			}
		}
	}
	return values, true
}

func filepathBase(value string) string {
	value = strings.ReplaceAll(value, `\`, "/")
	if index := strings.LastIndex(value, "/"); index >= 0 {
		return value[index+1:]
	}
	return value
}

func longOption(arg, option string) bool {
	return arg == option || strings.HasPrefix(arg, option+"=")
}

func matchesAnyBashRule(segment string, rules []BashRule, caseInsensitiveExecutable bool) bool {
	segment = strings.TrimSpace(segment)
	for _, rule := range rules {
		pattern := strings.TrimSpace(rule.Pattern)
		if strings.HasSuffix(pattern, " *") {
			prefix := strings.TrimSpace(strings.TrimSuffix(pattern, " *"))
			if len(segment) > len(prefix) && executablePrefixEqual(segment[:len(prefix)], prefix, caseInsensitiveExecutable) && unicode.IsSpace(rune(segment[len(prefix)])) {
				return true
			}
			continue
		}
		if executablePrefixEqual(segment, pattern, caseInsensitiveExecutable) {
			return true
		}
	}
	return false
}

func executableEqual(value, want string, caseInsensitive bool) bool {
	if caseInsensitive {
		return strings.EqualFold(value, want)
	}
	return value == want
}

func executablePrefixEqual(value, want string, caseInsensitive bool) bool {
	if caseInsensitive {
		return strings.EqualFold(value, want)
	}
	return value == want
}

func cloneBashRules(values []BashRule) []BashRule {
	return append([]BashRule(nil), values...)
}

// ValidateCapabilityBashRule enforces the complete capability Bash grammar:
//
//	command (" " literal-argument)* [" *"]
//
// The primary command is a literal executable name. Fixed arguments are
// literal tokens, and the only wildcard form is one final argument wildcard
// introduced by a single space. Shell operators, redirection, grouping,
// expansion, quoting, escaping, glob syntax, and line separators are outside
// this grammar. This validation must run before client-specific encoding.
func ValidateCapabilityBashRule(rule BashRule) error {
	pattern := rule.Pattern
	if pattern == "" || pattern != strings.TrimSpace(pattern) {
		return invalidCapabilityBashRule(rule)
	}

	literal := pattern
	switch strings.Count(pattern, "*") {
	case 0:
	case 1:
		if !strings.HasSuffix(pattern, " *") {
			return invalidCapabilityBashRule(rule)
		}
		literal = strings.TrimSuffix(pattern, " *")
	default:
		return invalidCapabilityBashRule(rule)
	}

	tokens := strings.Split(literal, " ")
	if len(tokens) == 0 || !validCapabilityCommandToken(tokens[0]) {
		return invalidCapabilityBashRule(rule)
	}
	for _, token := range tokens[1:] {
		if !validCapabilityArgumentToken(token) {
			return invalidCapabilityBashRule(rule)
		}
	}
	return nil
}

func ValidateCapabilityBashRules(rules []BashRule) error {
	for _, rule := range rules {
		if err := ValidateCapabilityBashRule(rule); err != nil {
			return err
		}
	}
	return nil
}

func invalidCapabilityBashRule(rule BashRule) error {
	return fmt.Errorf("unsafe capability Bash rule %q: expected a literal command with optional literal arguments and at most one trailing argument wildcard", rule.Pattern)
}

func validCapabilityCommandToken(token string) bool {
	if token == "" {
		return false
	}
	for index, r := range token {
		if index == 0 && !asciiLetterOrDigit(r) {
			return false
		}
		if !asciiLetterOrDigit(r) && !strings.ContainsRune("._+-", r) {
			return false
		}
	}
	return true
}

func validCapabilityArgumentToken(token string) bool {
	if token == "" {
		return false
	}
	for _, r := range token {
		if !asciiLetterOrDigit(r) && !strings.ContainsRune("._:/=,+-", r) {
			return false
		}
	}
	return true
}

func asciiLetterOrDigit(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9'
}
