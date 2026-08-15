package statusline

import (
	"encoding/json"
	"io"
)

func ParseInput(r io.Reader) (Input, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return Input{}, err
	}
	var input Input
	if err := json.Unmarshal(raw, &input); err != nil {
		return Input{}, err
	}
	return input, nil
}
