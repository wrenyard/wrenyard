package manifest

// LoadManifest returns the source-owned profile manifest. Source profiles were
// retired: no concrete provider/model/client combinations are seeded in Go
// source, so the manifest is empty. Canonical execution resolves profiles
// exclusively from daemon dispatch plans; this DTO is preserved only for
// legacy consumers that still observe a schema-version-1 manifest.
func LoadManifest() Manifest {
	return Manifest{
		SchemaVersion: 1,
		Profiles:      map[string]Profile{},
		OrderedIDs:    []string{},
	}
}
