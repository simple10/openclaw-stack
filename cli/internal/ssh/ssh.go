package ssh

import (
	"os/exec"

	"github.com/openclaw/vps-beast/cli/internal/config"
)

// sshArgs returns the common SSH arguments for connecting to the VPS.
func sshArgs(cfg config.Config) []string {
	return []string{
		"-i", cfg.SSHKeyPath,
		"-p", cfg.SSHPort,
		"-o", "ConnectTimeout=10",
		"-o", "StrictHostKeyChecking=accept-new",
		cfg.SSHUser + "@" + cfg.VPS1IP,
	}
}

// StreamCmd returns a command that streams docker logs from the named container.
// Usage: docker logs --tail 100 -f openclaw-<name>
func StreamCmd(cfg config.Config, container string) *exec.Cmd {
	args := sshArgs(cfg)
	args = append(args, "sudo docker logs --tail 100 -f "+container)

	cmd := exec.Command("ssh", args...)
	cmd.Env = append(cmd.Environ(), "TERM=xterm-256color")
	return cmd
}

// InteractiveCmd returns a command that opens an interactive bash shell
// inside the named container as the node user.
func InteractiveCmd(cfg config.Config, container string) *exec.Cmd {
	args := []string{"-t"}
	args = append(args, sshArgs(cfg)...)
	args = append(args, "sudo docker exec -it -u node "+container+" bash")

	cmd := exec.Command("ssh", args...)
	cmd.Env = append(cmd.Environ(), "TERM=xterm-256color")
	return cmd
}
