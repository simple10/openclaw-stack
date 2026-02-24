package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Config holds SSH connection details and project paths.
type Config struct {
	VPS1IP     string
	SSHKeyPath string
	SSHUser    string
	SSHPort    string
	ProjectRoot string
}

// LoadConfig parses openclaw-config.env from the given project root.
func LoadConfig(projectRoot string) (Config, error) {
	envPath := filepath.Join(projectRoot, "openclaw-config.env")
	f, err := os.Open(envPath)
	if err != nil {
		return Config{}, fmt.Errorf("cannot open %s: %w", envPath, err)
	}
	defer f.Close()

	vars := make(map[string]string)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		// Strip surrounding quotes
		if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}
		vars[key] = val
	}
	if err := scanner.Err(); err != nil {
		return Config{}, fmt.Errorf("reading %s: %w", envPath, err)
	}

	cfg := Config{
		VPS1IP:      vars["VPS1_IP"],
		SSHKeyPath:  vars["SSH_KEY_PATH"],
		SSHUser:     vars["SSH_USER"],
		SSHPort:     vars["SSH_PORT"],
		ProjectRoot: projectRoot,
	}

	// Resolve ~ in SSH key path
	if strings.HasPrefix(cfg.SSHKeyPath, "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			cfg.SSHKeyPath = filepath.Join(home, cfg.SSHKeyPath[2:])
		}
	}

	// Defaults
	if cfg.SSHPort == "" {
		cfg.SSHPort = "22"
	}

	// Validate required fields
	if cfg.VPS1IP == "" {
		return Config{}, fmt.Errorf("VPS1_IP is required in %s", envPath)
	}
	if cfg.SSHKeyPath == "" {
		return Config{}, fmt.Errorf("SSH_KEY_PATH is required in %s", envPath)
	}
	if cfg.SSHUser == "" {
		return Config{}, fmt.Errorf("SSH_USER is required in %s", envPath)
	}

	return cfg, nil
}

// DiscoverClaws returns sorted claw names from deploy/openclaws/.
// Directories prefixed with _ are skipped (e.g., _defaults, _example).
func DiscoverClaws(projectRoot string) ([]string, error) {
	clawsDir := filepath.Join(projectRoot, "deploy", "openclaws")
	entries, err := os.ReadDir(clawsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading %s: %w", clawsDir, err)
	}

	var claws []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, "_") {
			continue
		}
		// Verify it has a config.env
		configPath := filepath.Join(clawsDir, name, "config.env")
		if _, err := os.Stat(configPath); err != nil {
			continue
		}
		claws = append(claws, name)
	}
	sort.Strings(claws)
	return claws, nil
}

// FindProjectRoot walks up from the current directory looking for openclaw-config.env.
func FindProjectRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "openclaw-config.env")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("openclaw-config.env not found (searched from working directory to /)")
		}
		dir = parent
	}
}
