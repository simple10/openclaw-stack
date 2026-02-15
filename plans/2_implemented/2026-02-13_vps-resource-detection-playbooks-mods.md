# Plan: Add VPS Resource Check Step to Fresh Deploy Playbook

## Context

The `docker-compose.override.yml` has hardcoded gateway resource limits (`cpus: "6"`, `memory: 10.5G`) with comments explaining they should match the VPS hardware. Currently there's no playbook step that checks the actual VPS resources and reconciles them with the config. If someone deploys to a different-sized VPS, the limits will be wrong — either wasting resources or risking OOM kills.

## Approach

Add a new step **0.6 VPS Resource Check** to `playbooks/00-fresh-deploy-setup.md` (after SSH check, before deployment overview). This step:

1. SSHes into the VPS and queries `nproc` and `free` to get available CPUs and total memory
2. Reads the current limits from `deploy/docker-compose.override.yml`
3. Compares them and prompts the user if they don't match the expected values:
   - **CPUs:** gateway `limits.cpus` should equal `nproc` output
   - **Memory:** gateway `limits.memory` should be total memory minus 500M–1GB (accounting for Vector ~128M + system ~500M)
4. If mismatch detected, Claude prompts the user whether to adjust up or down, showing current vs recommended values
5. If user confirms, Claude updates the values in `deploy/docker-compose.override.yml`

## Files to Modify

### 1. `playbooks/00-fresh-deploy-setup.md`

Add new section **0.6 VPS Resource Check** between current 0.3 (SSH Check) and 0.4 (Worker Placeholder Detection). Renumber existing 0.4 → 0.5 and 0.5 → 0.6.

New step content:

```markdown
## 0.4 VPS Resource Check

After SSH is confirmed working, query the VPS hardware to verify gateway container resource limits match the host.

### Query VPS Resources

```bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> "nproc && free -b | awk '/^Mem:/{print \$2}'"
```

This returns two lines: CPU count (e.g., `6`) and total memory in bytes (e.g., `11811160064`).

### Compare Against Config

Read current gateway resource limits from `deploy/docker-compose.override.yml`:

- `deploy.resources.limits.cpus` (currently `"6"`)
- `deploy.resources.limits.memory` (currently `10.5G`)

### Expected Values

- **CPUs:** `limits.cpus` should equal the VPS CPU count from `nproc`
- **Memory:** `limits.memory` should be total VPS memory minus 500M–1GB
  - Vector uses ~128M, system/kernel needs ~500M
  - Formula: `total_memory - 750M` (midpoint) is a good default
  - Acceptable range: `total - 1G` to `total - 500M`

### Action

**If values match** (CPUs equal, memory within the 500M–1G buffer range): Report that resource limits look correct and continue.

**If mismatch detected:** Show the user a comparison:

```
VPS Resources:
  CPUs:   <nproc result>
  Memory: <total from free, human-readable>

Current gateway limits (docker-compose.override.yml):
  CPUs:   <current cpus value>
  Memory: <current memory value>

Recommended gateway limits:
  CPUs:   <nproc result>
  Memory: <total - 750M, rounded to nearest 0.5G>
```

Ask the user if they want to adjust the limits. They may choose:

- Accept the recommended values
- Enter custom values
- Keep the current values (skip)

If the user confirms changes, update `deploy/docker-compose.override.yml` with the new `limits.cpus` and `limits.memory` values. Also update `reservations.cpus` if it exceeds the new limit (reservation cannot exceed limit).

```

### Renumber existing sections

- Current 0.4 (Worker Placeholder Detection) → **0.5**
- Current 0.5 (Deployment Overview) → **0.6**

## Verification

1. Read the modified playbook and confirm step numbering is sequential (0.1–0.6)
2. Confirm the SSH command in 0.4 works with the existing SSH config variables
3. Confirm the step references the correct fields in `docker-compose.override.yml` (lines 26-28 for cpus, lines 29-33 for memory)
