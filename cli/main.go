package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/openclaw/vps-beast/cli/internal/config"
	"github.com/openclaw/vps-beast/cli/internal/tui"
)

func main() {
	root, err := config.FindProjectRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	cfg, err := config.LoadConfig(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	claws, err := config.DiscoverClaws(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error discovering claws: %v\n", err)
		os.Exit(1)
	}

	if len(claws) == 0 {
		// Fallback: if deploy/openclaws/ doesn't exist yet, assume main-claw
		claws = []string{"main-claw"}
	}

	m := tui.New(cfg, claws)
	p := tea.NewProgram(m, tea.WithAltScreen())

	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
