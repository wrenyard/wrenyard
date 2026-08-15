package change

// FileWrite is a change-plan action that writes content to a file path.
type FileWrite struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

// CommandAction is a change-plan action that runs a command.
type CommandAction struct {
	Command     []string          `json:"command"`
	Cwd         string            `json:"cwd,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	Description string            `json:"description,omitempty"`
}

// Action is a single change-plan action. Exactly one of File or Command is set.
type Action struct {
	Type    string
	File    *FileWrite
	Command *CommandAction
}

// Plan is a named ordered list of change actions.
type Plan struct {
	Name    string
	Actions []Action
}

// Result summarizes the outcome of applying a plan.
type Result struct {
	Succeeded   bool                     `json:"succeeded"`
	Entries     []map[string]interface{} `json:"entries"`
	JournalPath *string                  `json:"journal_path"`
}
