package grok

import "strings"

// DefaultPermissionArg is the smallest safe default injected when the user
// has not expressed a permission/approval/sandbox intent. Confirmed against
// the installed grok --help, whose --permission-mode accepts bypassPermissions.
const (
	DefaultPermissionFlag  = "--permission-mode"
	DefaultPermissionValue = "bypassPermissions"
)

// conflictFlags are the argv flags that express an explicit
// permission/approval/yolo/sandbox intent. When any is present the safe
// default is not injected and the user argv is respected verbatim.
var conflictFlags = map[string]bool{
	"--permission-mode": true,
	"--always-approve":  true,
	"--sandbox":         true,
	"--yolo":            true, // compatibility spelling
}

// HasConflictingArg reports whether args contains a permission/approval/yolo/
// sandbox-related flag, recognizing both "--flag value" and "--flag=value"
// forms (and relevant compatibility spellings).
func HasConflictingArg(args []string) bool {
	for _, a := range args {
		name := a
		if idx := strings.Index(a, "="); idx >= 0 {
			name = a[:idx]
		}
		if conflictFlags[name] {
			return true
		}
	}
	return false
}

// WithDefaultPermission returns args with the safe default permission flag
// prepended unless args already expresses a conflicting intent. The default
// is never written to config.toml; it only affects the launched process argv.
func WithDefaultPermission(args []string) []string {
	if HasConflictingArg(args) {
		return args
	}
	return append([]string{DefaultPermissionFlag, DefaultPermissionValue}, args...)
}
