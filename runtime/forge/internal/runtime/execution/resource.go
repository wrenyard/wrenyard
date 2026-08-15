package execution

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
)

func cleanupSuccessfulResources(resources []driver.ExecutionResource) error {
	return cleanupResources(resources, false)
}

func cleanupCompletedResources(resources []driver.ExecutionResource) error {
	return cleanupResources(resources, true)
}

func cleanupResources(resources []driver.ExecutionResource, completion bool) error {
	for _, resource := range resources {
		if completion && !resource.RemoveOnCompletion || !completion && !resource.RemoveOnSuccess {
			continue
		}
		root, err := filepath.Abs(strings.TrimSpace(resource.OwnershipRoot))
		if err != nil || strings.TrimSpace(resource.OwnershipRoot) == "" {
			return fmt.Errorf("refusing runtime resource cleanup with invalid ownership root")
		}
		target, err := filepath.Abs(strings.TrimSpace(resource.Path))
		if err != nil || strings.TrimSpace(resource.Path) == "" {
			return fmt.Errorf("refusing runtime resource cleanup with invalid target")
		}
		rel, err := filepath.Rel(root, target)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return fmt.Errorf("refusing runtime resource cleanup outside ownership root")
		}
		if err := os.RemoveAll(target); err != nil {
			if completion {
				return fmt.Errorf("clean completed runtime resource: %w", err)
			}
			return fmt.Errorf("clean successful runtime resource: %w", err)
		}
	}
	return nil
}
