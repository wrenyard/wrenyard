package forge

import (
	"io"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// directRunOptions is the test-only request shape parsed by the direct runtime.
// It preserves the legacy characterization-test name while delegating parsing
// to parseCommandRunArgs.
type directRunOptions struct {
	Profile      string
	Format       string
	Permission   string
	WorkDir      string
	Capabilities []string
	Prompt       string
}

// directRunResult aliases the production execution result so legacy tests keep
// reading the same wire shape without naming the production package type.
type directRunResult = execution.Result

// directPlanInput is the test-only request shape for building a plan.
type directPlanInput struct {
	Profile string
	Prompt  string
	CWD     string
}

// rawDirectProfile exposes only the root profile fields the characterization
// tests read from the produced plan wrapper.
type rawDirectProfile struct {
	SecretRef *string
}

// directPlan is a test-only wrapper embedding the production driver.CommandPlan
// plus the raw root profile, the resolved client family and the prompt. It lets
// legacy characterization tests observe the new production plan without the
// deleted directPlan production type. No plan/process/output logic lives here.
type directPlan struct {
	driver.CommandPlan
	Profile      rawDirectProfile
	ClientFamily string
	Prompt       string
}

// executeDirectRun converts the legacy options into an execution.Request and
// drives the production execution boundary. It contains no duplicated process
// or output logic.
func executeDirectRun(opts directRunOptions, stdout, stderr io.Writer) (execution.Result, error) {
	perm, _ := execution.ParsePermissionMode(opts.Permission)
	req := execution.Request{
		ProfileName:  opts.Profile,
		Prompt:       opts.Prompt,
		WorkDir:      opts.WorkDir,
		Permission:   perm,
		Format:       protocol.OutputFormat(opts.Format),
		Capabilities: opts.Capabilities,
		Clean:        true,
	}
	return execution.Execute(req, executionDependencies(), stdout, stderr)
}

// parseDirectRunArgs delegates flag parsing/validation to parseCommandRunArgs
// and maps the production request back into the legacy options shape.
func parseDirectRunArgs(args []string) (directRunOptions, error) {
	req, _, err := parseCommandRunArgs(args)
	if err != nil {
		return directRunOptions{}, err
	}
	return directRunOptions{
		Profile:      req.ProfileName,
		Format:       string(req.Format),
		Permission:   string(req.Permission),
		WorkDir:      req.WorkDir,
		Capabilities: req.Capabilities,
		Prompt:       req.Prompt,
	}, nil
}

// combineDirectPrompt delegates to the production prompt-stitching helper.
func combineDirectPrompt(argvPrompt, stdinText string) string {
	return combinePrompt(argvPrompt, stdinText)
}

// buildDirectRunPlan builds a production plan with no resume id and no
// capabilities.
func buildDirectRunPlan(input directPlanInput) (directPlan, error) {
	return buildDirectPlan(input, "")
}

// buildDirectRunPlanWithCapabilities builds a production plan with the supplied
// capability pack names. It delegates to buildDirectPlan.
func buildDirectRunPlanWithCapabilities(input directPlanInput, capabilities []string) (directPlan, error) {
	return buildDirectPlanWithCapabilities(input, "", capabilities)
}

// buildDirectResumePlan builds a production plan carrying the resume id. An
// empty resume id preserves the production empty-resume behavior.
func buildDirectResumePlan(input directPlanInput, resumeID string) (directPlan, error) {
	return buildDirectPlan(input, resumeID)
}

// buildDirectPlan restores the legacy two-argument signature for existing
// characterization tests, delegating to buildDirectPlanWithCapabilities with a
// nil capability pack. It contains no duplicated plan/process/output logic.
func buildDirectPlan(input directPlanInput, resumeID string) (directPlan, error) {
	return buildDirectPlanWithCapabilities(input, resumeID, nil)
}

// buildDirectPlanWithCapabilities drives execution.Prepare through the wired
// production dependencies, then loads the raw root profile only to populate the
// test-only wrapper. It contains no duplicated plan/process/output logic.
func buildDirectPlanWithCapabilities(input directPlanInput, resumeID string, capabilities []string) (directPlan, error) {
	req := execution.Request{
		ProfileName:  input.Profile,
		Prompt:       input.Prompt,
		WorkDir:      input.CWD,
		Clean:        true,
		ResumeID:     resumeID,
		Capabilities: append([]string(nil), capabilities...),
	}
	plan, clientFamily, err := execution.Prepare(req, executionDependencies())
	if err != nil {
		return directPlan{}, err
	}
	raw := rawDirectProfile{}
	if manifest, mErr := loadManifest(); mErr == nil {
		if p, ok := manifest.Profiles[input.Profile]; ok {
			raw.SecretRef = p.SecretRef
		}
	}
	return directPlan{
		CommandPlan:  plan,
		Profile:      raw,
		ClientFamily: clientFamily,
		Prompt:       input.Prompt,
	}, nil
}

// directCCConfigDir/JobDir delegate to the production CC directory helpers so
// characterization tests observe the exact directories the driver creates.
func directCCConfigDir() string {
	return driver.ClaudeConfigDir(forgeDataDir())
}

func directCCJobDir() string {
	return driver.ClaudeJobDir(forgeDataDir())
}

// parseDirectPermissionMode delegates to the production permission parser.
func parseDirectPermissionMode(raw string) (catalog.PermissionMode, error) {
	return execution.ParsePermissionMode(raw)
}
