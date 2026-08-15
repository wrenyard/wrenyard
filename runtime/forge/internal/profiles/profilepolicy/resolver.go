package profilepolicy

// Resolve evaluates the policy candidates in order and returns the first
// effective candidate whose quota-pool usage is below its threshold.
// It never performs remote inference calls and never falls back across
// policies. Returns a Resolution with failures and same-policy
// suggestions deduplicated by canonical pool in policy order.
func Resolve(req ResolveRequest, deps Dependencies, overrideThresholds map[string]int) Resolution {
	r := Resolution{
		PolicyName: req.Policy.Name,
		OK:         false,
	}

	seenPool := make(map[string]bool)

	for _, c := range req.Policy.Candidates {
		threshold := c.Threshold
		if threshold <= 0 {
			if v, ok := overrideThresholds[c.ProfileID]; ok && v > 0 {
				threshold = v
			} else {
				threshold = DefaultThreshold
			}
		}

		effective := deps.IsProfileEffective(c.ProfileID)

		pool := ""
		if deps.CanonicalPoolForProfile != nil {
			pool = deps.CanonicalPoolForProfile(c.ProfileID)
		}
		usagePct := deps.CanonicalPoolUsagePct(pool)

		if effective && usagePct >= 0 && usagePct >= threshold {
			// Exhausted
			r.Failures = append(r.Failures, CandidateFailure{
				ProfileID: c.ProfileID,
				Reason:    ReasonDefinitionInvalid, // quota-exhausted maps to definition_invalid per spec
			})
			if !seenPool[pool] && pool != "" {
				seenPool[pool] = true
				r.Suggestions = append(r.Suggestions, c.ProfileID)
			}
		} else if effective {
			r.CandidateIDs = append(r.CandidateIDs, c.ProfileID)
			if !r.OK {
				r.ProfileID = c.ProfileID
				r.OK = true
			}
		} else {
			r.Failures = append(r.Failures, CandidateFailure{
				ProfileID: c.ProfileID,
				Reason:    ReasonDefinitionInvalid,
			})
			if !seenPool[pool] && pool != "" {
				seenPool[pool] = true
				r.Suggestions = append(r.Suggestions, c.ProfileID)
			}
		}
	}

	return r
}
