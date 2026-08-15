package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// UpdateCommandContext holds context for the update command.
type UpdateCommandContext struct {
	Home   string
	Args   []string
	Assets Assets
	Deps   Dependencies
}

// UpdateCommand runs the update pipeline: git pull, go build, versioned install,
// then setup. Setup refreshes shell integration and runs doctor.
func UpdateCommand(ctx UpdateCommandContext) int {
	if len(ctx.Args) > 0 {
		fmt.Fprintln(os.Stderr, "forge update: no arguments expected")
		return 2
	}
	if ctx.Deps.RepoDir == nil {
		fmt.Fprintln(os.Stderr, "forge update: cannot locate repo")
		return 1
	}
	repo, err := ctx.Deps.RepoDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "update requires a source checkout; binary users: download a new forge.exe and run 'forge setup --self-install'")
		return 1
	}

	// Step 1: git pull --ff-only
	fmt.Println("update repository...")
	cmd := exec.Command("git", "pull", "--ff-only")
	cmd.Dir = repo
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		return exitCode(err)
	}

	// Step 2: go build
	fmt.Println("build Forge...")
	lp := layoutFromHome(ctx.Home)
	binPath := filepath.Join(repo, "bin", lp.BinaryArtifactName())
	if err := RunGoBuild(repo, binPath); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitCode(err)
	}

	// Step 3: install the built artifact into the versioned layout
	fmt.Println("install versioned binary...")
	if err := UpdateVersionedInstall(ctx.Home, binPath); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	// Step 4: refresh shell integration and verify the installed environment.
	fmt.Println("run setup and doctor...")
	setup := exec.Command(binPath, "setup")
	setup.Dir = repo
	setup.Stdout = os.Stdout
	setup.Stderr = os.Stderr
	setup.Stdin = os.Stdin
	if err := setup.Run(); err != nil {
		return exitCode(err)
	}
	return 0
}

type layoutFromHome string

func (l layoutFromHome) BinaryArtifactName() string {
	return layoutBinaryName(string(l))
}

func layoutBinaryName(home string) string {
	if os.PathSeparator == '\\' {
		return "forge.exe"
	}
	return "forge"
}
