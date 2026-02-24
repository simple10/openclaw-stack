package tui

import (
	"fmt"
	"io"

	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// clawItem is a claw name that implements list.Item.
type clawItem string

func (c clawItem) FilterValue() string { return string(c) }

// clawDelegate renders claw items in the list.
type clawDelegate struct{}

func (d clawDelegate) Height() int                             { return 1 }
func (d clawDelegate) Spacing() int                            { return 0 }
func (d clawDelegate) Update(_ tea.Msg, _ *list.Model) tea.Cmd { return nil }

func (d clawDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	ci, ok := item.(clawItem)
	if !ok {
		return
	}

	name := string(ci)
	var style lipgloss.Style

	if index == m.Index() {
		style = lipgloss.NewStyle().
			Foreground(lipgloss.Color("39")).
			Bold(true).
			PaddingLeft(2)
		fmt.Fprintf(w, style.Render("> "+name))
	} else {
		style = lipgloss.NewStyle().
			PaddingLeft(4)
		fmt.Fprintf(w, style.Render(name))
	}
}

// clawPicker wraps a bubbles/list for claw selection.
type clawPicker struct {
	list list.Model
}

func newClawPicker(claws []string) clawPicker {
	items := make([]list.Item, len(claws))
	for i, c := range claws {
		items[i] = clawItem(c)
	}

	l := list.New(items, clawDelegate{}, 40, 10)
	l.Title = "Select a claw"
	l.SetShowStatusBar(false)
	l.SetShowHelp(true)
	l.SetFilteringEnabled(len(claws) > 5)
	l.DisableQuitKeybindings()
	l.Styles.Title = titleStyle

	return clawPicker{list: l}
}
