package quota

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// coerceFloat converts a JSON-decoded value into a float64, rejecting
// non-finite results (NaN and infinities) so invalid quota numbers are
// never accepted by callers.
func coerceFloat(v any) (float64, bool) {
	var f float64
	switch t := v.(type) {
	case float64:
		f = t
	case float32:
		f = float64(t)
	case json.Number:
		n, err := t.Float64()
		if err != nil {
			return 0, false
		}
		f = n
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0, false
		}
		f = n
	case int:
		f = float64(t)
	case int64:
		f = float64(t)
	default:
		return 0, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// toString renders a JSON-decoded value as its plain string form, using a
// decimal representation for numbers.
func toString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		return strconv.FormatBool(t)
	case nil:
		return ""
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

// jsonString marshals v as a JSON literal, escaping any characters that
// require escaping.
func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
