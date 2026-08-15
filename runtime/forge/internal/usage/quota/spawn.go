package quota

import (
	"os"
	"os/exec"
)

// Spawner spawns a detached refresh subprocess. Injected into
// CachedProvider for testability; nil means use DefaultSpawner.
//
// lockToken is the token written into the lockfile that prevents
// concurrent cross-process refreshes. The implementation MUST
// remove the lockfile when done (or pass the token to a child
// process that will do so).
type Spawner interface {
	Spawn(providerName, cachePath, lockToken string) error
}

// DefaultSpawner spawns the real forge binary as a fully detached subprocess.
// Platform-specific detachment is applied via applyDetached (spawn_*.go).
type DefaultSpawner struct{}

func (DefaultSpawner) Spawn(providerName, cachePath, lockToken string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}

	cmd := exec.Command(exe, "quota", "refresh-provider", providerName)
	// Discard stdout/stderr — detached subprocess has no console.
	cmd.Stdout = nil
	cmd.Stderr = nil
	// Detach from parent process group and console.
	applyDetached(cmd)
	// Inherit the environment so credentials/config paths resolve.
	cmd.Env = os.Environ()

	// Pass the lock token so the subprocess can verify ownership before
	// doing work and can release the lock when done.
	cmd.Env = append(cmd.Env, "FORGE_REFRESH_CACHE_PATH="+cachePath)
	cmd.Env = append(cmd.Env, "FORGE_REFRESH_LOCK_PATH="+cachePath+".refresh.lock")
	cmd.Env = append(cmd.Env, "FORGE_REFRESH_LOCK_TOKEN="+lockToken)

	if err := cmd.Start(); err != nil {
		return err
	}

	// Release the OS handle — the subprocess is fully detached and
	// cleans up the lockfile on its own.
	cmd.Process.Release()

	// NEVER Wait() — the point is detachment. The child removes the
	// lockfile on its own when it finishes.
	return nil
}

// Ensure DefaultSpawner implements Spawner.
var _ Spawner = DefaultSpawner{}

// NoopSpawner is a test-only spawner that records calls and returns success
// without actually spawning. Useful for verifying spawn-decision logic.
type NoopSpawner struct {
	Calls     int
	LastName  string
	LastPath  string
	LastToken string
	ShouldErr error

	// If Hold is set, the spawner blocks until Released is closed,
	// simulating a long-running subprocess.
	Hold     bool
	Released chan struct{}
}

func (n *NoopSpawner) Spawn(providerName, cachePath, lockToken string) error {
	n.Calls++
	n.LastName = providerName
	n.LastPath = cachePath
	n.LastToken = lockToken
	if n.Hold && n.Released != nil {
		<-n.Released
	}
	return n.ShouldErr
}
