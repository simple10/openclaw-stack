# 08c - Deployment Report

Generate and display the final deployment report.

## Prerequisites

- All previous playbooks completed
- Device pairing confirmed working (`08b-pair-devices.md`)
- `npm run pre-deploy` has been run (`.deploy/stack.json` must exist)

---

## Generate the report

Run the deploy report generator:

```bash
npm run deploy-report:save
```

This reads `.deploy/stack.json` + `.env`, SSHs to the VPS to retrieve gateway tokens, and renders the report from `build/templates/deploy-report.md.hbs`.

The report is saved to `.deploy/report.md` and printed to stdout.

**Display** the full report output to the user in the conversation.

**Reference the file** at the end:

> Deployment report saved to `.deploy/report.md`

## Customizing the report

The report template is at `build/templates/deploy-report.md.hbs` (Handlebars). Edit it to add or remove sections. Available context variables are built in `build/generate-deploy-report.mjs`.

## AI proxy status

After displaying the report, check with the user:

**If the user added credentials during `08a`:**
> Update the report: AI Proxy shows "Provider credentials configured."

**If skipped:**
> The report already shows the default: "Deployed but no provider credentials configured yet."

To toggle this, re-run with the `--ai-proxy-configured` flag (or manually edit the saved report).
