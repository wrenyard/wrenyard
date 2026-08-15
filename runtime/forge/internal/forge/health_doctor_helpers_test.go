package forge

import "github.com/wrenyard/wrenyard/runtime/forge/internal/health/doctor"

func codexConfigCheck() map[string]interface{} {
	return doctor.CodexConfigCheck(newDoctorDeps())
}

func codebuddyCLIDoctorCheck() map[string]interface{} {
	return doctor.CodebuddyCLIDoctorCheck(newDoctorDeps())
}

func cbModelWhitelistCheck() map[string]interface{} {
	return doctor.CBModelWhitelistCheck(newDoctorDeps())
}

func secretsDoctorCheck() map[string]interface{} {
	return doctor.SecretsDoctorCheck(newDoctorDeps())
}

func codebuddyProfileModel(p profile) string {
	return doctor.CodebuddyProfileModel(p.Launcher, p.Env, stringSliceField)
}

func clientsDoctorChecks() []map[string]interface{} {
	return doctor.ClientsDoctorChecks(newDoctorDeps())
}

func providersDoctorChecks() []map[string]interface{} {
	return doctor.ProvidersDoctorChecks(newDoctorDeps())
}

func sortedProfileKeys(values map[string]profile) []string {
	converted := make(map[string]doctor.Profile, len(values))
	for k, v := range values {
		converted[k] = doctor.Profile{Client: v.Client, Provider: v.Provider, Launcher: v.Launcher, Env: v.Env, SecretRef: v.SecretRef}
	}
	return doctor.SortedProfileKeys(converted)
}

func profilesDoctorChecks() []map[string]interface{} {
	return doctor.ProfilesDoctorChecks(newDoctorDeps())
}
