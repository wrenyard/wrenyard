package driver

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func materializeRuntimePreparation(prep RuntimePreparation) (string, error) {
	parent, err := filepath.Abs(strings.TrimSpace(prep.HomeParent))
	if err != nil || strings.TrimSpace(prep.HomeParent) == "" {
		return "", fmt.Errorf("runtime home parent is invalid")
	}
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return "", fmt.Errorf("create runtime home parent: %w", err)
	}
	home, err := createUniqueRunHome(parent)
	if err != nil {
		return "", err
	}
	for _, file := range prep.Files {
		target, err := preparedTarget(home, file.RelativePath)
		if err != nil {
			return home, err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return home, fmt.Errorf("create prepared file parent: %w", err)
		}
		mode := os.FileMode(file.Mode)
		if mode == 0 {
			mode = 0o600
		}
		if err := os.WriteFile(target, file.Data, mode); err != nil {
			return home, fmt.Errorf("write prepared runtime file %q: %w", file.RelativePath, err)
		}
	}
	for _, copySpec := range prep.Copies {
		target, err := preparedTarget(home, copySpec.RelativePath)
		if err != nil {
			return home, err
		}
		if err := copyPreparedFile(copySpec.SourcePath, target, os.FileMode(copySpec.Mode)); err != nil {
			return home, err
		}
	}
	return home, nil
}

func createUniqueRunHome(parent string) (string, error) {
	for attempt := 0; attempt < 16; attempt++ {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", fmt.Errorf("generate runtime run id: %w", err)
		}
		name := "run-" + time.Now().UTC().Format("20060102T150405.000000000Z") + "-" + hex.EncodeToString(random[:])
		home := filepath.Join(parent, name)
		if err := os.Mkdir(home, 0o700); err == nil {
			return home, nil
		} else if !os.IsExist(err) {
			return "", fmt.Errorf("create runtime run home: %w", err)
		}
	}
	return "", fmt.Errorf("create runtime run home: collision retry limit reached")
}

func preparedTarget(home, relative string) (string, error) {
	relative = filepath.Clean(strings.TrimSpace(relative))
	if relative == "." || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("prepared runtime path %q is not a safe relative path", relative)
	}
	return filepath.Join(home, relative), nil
}

func copyPreparedFile(source, target string, mode os.FileMode) error {
	sourceFile, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("copy prepared auth file: source is not readable")
	}
	defer sourceFile.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("copy prepared auth file: create target parent: %w", err)
	}
	if mode == 0 {
		mode = 0o600
	}
	targetFile, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return fmt.Errorf("copy prepared auth file: create target: %w", err)
	}
	_, copyErr := io.Copy(targetFile, sourceFile)
	closeErr := targetFile.Close()
	if copyErr != nil {
		return fmt.Errorf("copy prepared auth file: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("copy prepared auth file: %w", closeErr)
	}
	return nil
}
