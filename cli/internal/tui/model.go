package tui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/openclaw/vps-beast/cli/internal/config"
	"github.com/openclaw/vps-beast/cli/internal/ssh"
)

type state int

const (
	statePicking state = iota
	stateMenu
)

// processFinishedMsg is sent when an ExecProcess completes.
type processFinishedMsg struct{ err error }

// Model is the root BubbleTea model.
type Model struct {
	state    state
	cfg      config.Config
	claws    []string
	selected string // selected claw name

	picker clawPicker
	menu   actionMenu

	width  int
	height int
	err    error
}

// New creates the initial model. If there's only one claw, it skips the picker.
func New(cfg config.Config, claws []string) Model {
	m := Model{
		cfg:   cfg,
		claws: claws,
	}

	if len(claws) == 1 {
		m.selected = claws[0]
		m.state = stateMenu
		m.menu = newActionMenu(claws[0])
	} else {
		m.state = statePicking
		m.picker = newClawPicker(claws)
	}

	return m
}

func (m Model) Init() tea.Cmd {
	switch m.state {
	case statePicking:
		return m.picker.list.StartSpinner()
	default:
		return nil
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		// Propagate to sub-components
		if m.state == statePicking {
			m.picker.list.SetSize(msg.Width, msg.Height-2)
		}
		if m.state == stateMenu {
			m.menu.list.SetSize(msg.Width, msg.Height-2)
		}
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "q":
			if m.state == statePicking {
				return m, tea.Quit
			}
			if m.state == stateMenu {
				// If multiple claws, go back to picker
				if len(m.claws) > 1 {
					m.state = statePicking
					m.selected = ""
					m.picker = newClawPicker(m.claws)
					return m, nil
				}
				return m, tea.Quit
			}
		case "esc":
			if m.state == stateMenu && len(m.claws) > 1 {
				m.state = statePicking
				m.selected = ""
				m.picker = newClawPicker(m.claws)
				return m, nil
			}
		}

	case processFinishedMsg:
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		// Return to action menu after a process exits
		m.menu = newActionMenu(m.selected)
		if m.width > 0 {
			m.menu.list.SetSize(m.width, m.height-2)
		}
		m.state = stateMenu
		return m, nil
	}

	switch m.state {
	case statePicking:
		return m.updatePicker(msg)
	case stateMenu:
		return m.updateMenu(msg)
	}

	return m, nil
}

func (m Model) updatePicker(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	m.picker.list, cmd = m.picker.list.Update(msg)

	// Check for selection
	if key, ok := msg.(tea.KeyMsg); ok && key.String() == "enter" {
		if item, ok := m.picker.list.SelectedItem().(clawItem); ok {
			m.selected = string(item)
			m.state = stateMenu
			m.menu = newActionMenu(m.selected)
			if m.width > 0 {
				m.menu.list.SetSize(m.width, m.height-2)
			}
			return m, nil
		}
	}

	return m, cmd
}

func (m Model) updateMenu(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	m.menu.list, cmd = m.menu.list.Update(msg)

	if key, ok := msg.(tea.KeyMsg); ok && key.String() == "enter" {
		if item, ok := m.menu.list.SelectedItem().(actionItem); ok {
			container := "openclaw-" + m.selected
			return m, m.execAction(item.id, container)
		}
	}

	return m, cmd
}

func (m Model) execAction(action string, container string) tea.Cmd {
	switch action {
	case "logs":
		return tea.ExecProcess(ssh.StreamCmd(m.cfg, container), func(err error) tea.Msg {
			return processFinishedMsg{err: err}
		})
	case "ssh":
		return tea.ExecProcess(ssh.InteractiveCmd(m.cfg, container), func(err error) tea.Msg {
			return processFinishedMsg{err: err}
		})
	}
	return nil
}

var titleStyle = lipgloss.NewStyle().
	Bold(true).
	Foreground(lipgloss.Color("39"))

func (m Model) View() string {
	if m.err != nil {
		return fmt.Sprintf("Error: %v\n", m.err)
	}

	switch m.state {
	case statePicking:
		return m.picker.list.View()
	case stateMenu:
		return m.menu.list.View()
	default:
		return ""
	}
}
