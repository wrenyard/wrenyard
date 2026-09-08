package manifest

import "testing"

// TestEmptyManifestConstructor verifies the remaining manifest constructor
// returns a schema-version-1 manifest with zero profiles and zero ordered ids,
// proving no source concrete profiles are seeded in Go source.
func TestEmptyManifestConstructor(t *testing.T) {
	m := LoadManifest()
	if m.SchemaVersion != 1 {
		t.Fatalf("SchemaVersion = %d, want 1", m.SchemaVersion)
	}
	if len(m.Profiles) != 0 {
		t.Fatalf("Profiles = %v, want zero profiles", m.Profiles)
	}
	if len(m.OrderedIDs) != 0 {
		t.Fatalf("OrderedIDs = %v, want zero ordered ids", m.OrderedIDs)
	}
}
