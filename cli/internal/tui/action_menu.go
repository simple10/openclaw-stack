package tui

import (
	"fmt"
	"io"

	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// actionItem represents a menu action.
type actionItem struct {
	id   string
	name string
	desc string
}

func (a actionItem) FilterValue() string { return a.name }

// actionDelegate renders action items in the list.
type actionDelegate struct{}

func (d actionDelegate) Height() int                             { return 2 }
func (d actionDelegate) Spacing() int                            { return 0 }
func (d actionDelegate) Update(_ tea.Msg, _ *list.Model) tea.Cmd { return nil }

func (d actionDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	ai, ok := item.(actionItem)
	if !ok {
		return
	}

	if index == m.Index() {
		nameStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("39")).
			Bold(true).
			PaddingLeft(2)
		descStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("241")).
			PaddingLeft(4)
		fmt.Fprintf(w, "%s\n%s", nameStyle.Render("> "+ai.name), descStyle.Render(ai.desc))
	} else {
		nameStyle := lipgloss.NewStyle().
			PaddingLeft(4)
		descStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("241")).
			PaddingLeft(4)
		fmt.Fprintf(w, "%s\n%s", nameStyle.Render(ai.name), descStyle.Render(ai.desc))
	}
}

// actionMenu wraps a bubbles/list for the action menu.
type actionMenu struct {
	list list.Model
}

func newActionMenu(clawName string) actionMenu {
	actions := []list.Item{
		actionItem{id: "logs", name: "Logs", desc: "Stream container logs (tail -f)"},
		actionItem{id: "ssh", name: "SSH", desc: "Open interactive shell in container"},
	}

	l := list.New(actions, actionDelegate{}, 50, 12)
	l.Title = fmt.Sprintf("openclaw-%s", clawName)
	l.SetShowStatusBar(false)
	l.SetShowHelp(true)
	l.SetFilteringEnabled(false)
	l.DisableQuitKeybindings()
	l.Styles.Title = titleStyle

	return actionMenu{list: l}
}
