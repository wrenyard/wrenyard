package doctor

import "fmt"

// FormatCheckLines returns the human-readable lines for one doctor check.
// The installation adapter prints as a nested native-client group:
//
//	installation:
//		claude-code ok
//		dsh missing
func FormatCheckLines(check map[string]interface{}) []string {
	if check == nil {
		return nil
	}
	adapter := fmt.Sprint(check["adapter"])
	if adapter == "installation" {
		rows := InstallationRows(check)
		if len(rows) > 0 {
			lines := []string{adapter + ":"}
			for _, row := range rows {
				lines = append(lines, "\t"+fmt.Sprint(row["id"])+" "+fmt.Sprint(row["status"]))
			}
			return lines
		}
	}
	return []string{fmt.Sprintf("%s: %s - %s", adapter, check["status"], check["message"])}
}
