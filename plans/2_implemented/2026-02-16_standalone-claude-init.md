> we're going to create a new CLAUDE_INSTALL.md file that's designed to assist users in setting up all the
>requirements to launch the openclaw vps.
>
> read the openclaw-config.env.example and plan out the steps required to walk users through setting things up to
> deploy to the vps. the CLAUDE_INSTALL.md will live in a separate repo as a standalone project.
>
> these are the required config settings:
>
> ```bash
> # === REQUIRED TO START DEPLOYMENT ===
> VPS1_IP=
> CF_TUNNEL_TOKEN=                   # Create tunnel first: see docs/CLOUDFLARE-TUNNEL.md
> YOUR_TELEGRAM_ID=                  # Required — send message to @userinfobot to get your numeric user ID
> OPENCLAW_TELEGRAM_BOT_TOKEN=       # Required — create via @BotFather (see docs/TELEGRAM.md). Can reuse for host alerter below.
>
> # === SSH ===
> SSH_KEY_PATH=
> SSH_USER=root                    # Initial SSH user — set to match your VPS provider (ubuntu, root, debian, etc.)
> SSH_PORT=22                        # Current SSH port, updated to SSH_HARDENED_PORT value after hardening
>
>
> # === DOMAIN CONFIGURATION (required — set up tunnel routes + Cloudflare Access first) ===
> # Configure your Cloudflare Tunnel public hostname routes and Cloudflare Access
> # application BEFORE starting deployment. See docs/CLOUDFLARE-TUNNEL.md.
> OPENCLAW_DOMAIN=
> ```
>
> the first step is to ask the user if they have already setup a VPS and have root access to it.
>
> - if no, tell them to first setup the VPS
>
> ask them if the IP address and the root user of the VPS
> ask if they setup passwordless SSH access already or have a password for the root user
>
> - if they only have a password, create a ssh key for them and ssh into the server to setup passwordless ssh
> - if they already have passwordless ssh, try to ssh into the server, then work with the user to debug if it doesn't work or they have > more than one ssh keys in ~/.ssh/
>
> Next, ask them if they already have a domain setup on Cloudflare that can be used to setup as subdomain for openclaw
>
> Next, walk them through how to setup the Cloudflare Tunnel with Cloudflare Access configured.
> You'll need to embed all the necessary instructions from docs/CLOUDFLARE-TUNNEL.md since we're creating
> a single standalone instruction file here.
>
> Test the tunnel token and test the domain to make sure Cloudflare Access is properly protected the domain.
>
> Next, help the user setup a telegram bot and get the telegram ID.
>
> Once all the required env vars have been collected, it's time to prepare for deploy.
>
> 1. Check to see if git is intalled, if not `brew install git` if user is on a mac
> 2. Clone this repo from github to a openclaw-stack dir and cd into it
> 3. Copy openclaw-config.env.example from the cloned repo to openclaw-config.env
> 4. Populate the env vars you already collected into the openclaw-config.env
>
> Next, we want to hand off the process to a new claude session that will read the CLAUDE.md
> in the cloned repo.
>
> Clear the session.
> Read CLAUDE.md and ask the user if they want to start the deploy

---
