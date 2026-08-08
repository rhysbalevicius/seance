# seance

An always-on EC2 box for running Claude Code and other agent CLIs remotely. Access is Tailscale-only (Tailscale SSH, no inbound ports). Credentials live sops-encrypted in a central "sanctum" AWS account, so neither terraform state nor a box's user-data holds anything sensitive.

```
   sanctum AWS account                    target AWS account
 ┌──────────────────────────┐    ┌──────────────────────────────────┐
 │ S3 artifacts bucket      │    │ EC2 m7i.xlarge (Ubuntu 24)       │
 │ S3 secrets (sops + KMS)  │◄───┤ instance role ──assume──►        │
 │ IAM role seance-access   │STS │ SG: no ingress, all egress       │
 └──────────────────────────┘    │ secrets: /etc/seance/secrets/*   │
                                 │ tailscaled · nginx · private CA  │
   registrar (one-time):         │ herdr · claude · playwright      │
   A agent1   -> 100.x.y.z       └────────────────┬─────────────────┘
   A *.agent1 -> 100.x.y.z                        │ tailnet (WireGuard)
                                   you: ssh dev@agent1
                                   https://webapp.agent1.example.com
```

## Layout

```
terraform/modules/box/     one box: EC2 + zero-ingress SG + key pair + cloud-init shim
terraform/modules/sanctum/   artifacts bucket, secrets bucket, KMS key, cross-account role
terraform/stacks/sanctum/    root, applied once in the sanctum account
terraform/stacks/boxes/    root, every box across every account, one state
secrets/                   sops-encrypted credentials (gitignored; uploaded by the sanctum stack)
scripts/                   bootstrap + the seance-* helpers installed onto the box
config/                    bootstrap-agent prompt, secrets schema
```

Two roots, two state files: `sanctum` is applied once, `boxes` is the one you touch.

## Secrets

Credentials are kept in `secrets/shared.sops.yaml`, encrypted with [sops](https://getsops.io) against a KMS key in the sanctum account. Terraform uploads the ciphertext to S3 (`aws_s3_object` with `source`, so only a hash lands in state). The box fetches and decrypts it at first boot using the sanctum role it assumes — no passphrase, because the role is the key.

A per-box overlay at `secrets/boxes/<name>.sops.yaml` is merged over the shared file on that box: objects merge key by key, lists replace wholesale. Every file under `secrets/boxes/` is uploaded automatically. The overlay gives a box different values, not isolation — every box assumes the same role and can read any file in the bucket.

Rotate: `sops secrets/shared.sops.yaml`, `terraform apply` the sanctum stack, `sudo seance-secrets pull` on the box. Schema is in `config/secrets.example.yaml`.

## 1. Sanctum account (once)

Prereqs: terraform >= 1.5, sops, AWS CLI authenticated against the sanctum account, a Tailscale account with MagicDNS, this repo pushed somewhere public, and a deploy key (`ssh-keygen -t ed25519 -f ~/.ssh/seance_deploy_ed25519`) added to GitHub.

Two-pass, because the KMS key has to exist before you can encrypt against it.

```bash
cd terraform/stacks/sanctum
cp terraform.tfvars.example terraform.tfvars   # bucket names, account ids, external id
terraform init && terraform apply -var allow_missing_secrets=true
terraform output    # -> sanctum_role_arn, artifact_bucket, secrets_bucket, secrets_kms_key_arn
```

`allow_missing_secrets` is only for this first apply. The uploads are driven by what's on disk and `secrets/` is gitignored, so without the flag a fresh clone would plan `0 to add, N to destroy` and wipe the live secrets from the bucket.

Then seed and apply again:

```bash
cd ../../..
cp .sops.yaml.example .sops.yaml               # paste in secrets_kms_key_arn
mkdir -p secrets
cp config/secrets.example.yaml secrets/shared.sops.yaml
$EDITOR secrets/shared.sops.yaml               # fill in, still plaintext
sops -e -i secrets/shared.sops.yaml            # encrypt in place
cd terraform/stacks/sanctum && terraform apply
```

## 2. Boxes

```bash
cd terraform/stacks/boxes
cp terraform.tfvars.example terraform.tfvars   # sanctum outputs + repo URL + the boxes map
terraform init && terraform apply
```

tfvars has two sections. `shared` is the defaults every box inherits; `boxes` is one entry per box, keyed by hostname, overriding `shared`:

```hcl
boxes = {
  agent1 = { target = "primary", vanity_domain = "agent1.example.com" }
  agent2 = { target = "primary", instance_type = "m7i.large", projects = [ ... ] }
}
```

Adding a box in a wired account is those two lines. Adding an account or region takes three edits, because Terraform can't `for_each` a provider: a `provider` alias in `providers.tf`, a `module` block in `main.tf`, and a `merge()` entry in `outputs.tf`, all marked `TARGETS`. The `target` validation fails the plan if you name an unwired alias.

`user_data`, `ami`, `subnet_id` and `key_name` are in `ignore_changes`, so a routine apply won't replace a box (a replacement destroys the root volume). Force a rebuild with `terraform taint 'module.primary["agent1"].aws_instance.box'`.

Each box gets an EC2 key pair. Save the private half:

```bash
terraform output -json ssh_private_keys | jq -r '."agent1"' > ~/.ssh/seance-agent1
chmod 600 ~/.ssh/seance-agent1
```

The SG has no ingress, so this key is not a live door — it's for reaching the root volume via a rescue instance if the tailnet is unreachable. `seance-nuke` reinstalls it after a wipe.

Boot runs `scripts/bootstrap.sh`: Docker, Node 22, AWS CLI v2, sops, secrets pull, the agent CLIs, herdr, Playwright + Chromium, Tailscale, nginx + private-CA cert, git identities, project clones. Then:

```bash
ssh dev@agent1                        # Tailscale SSH
tail -f /var/log/seance-bootstrap.log
cat /var/lib/seance/bootstrapped      # exists when bootstrap finished
seance-secrets status
```

### Vanity hostnames

Apps get `<name>.agent1.example.com` behind nginx, with a wildcard cert from a private CA on the box. Two one-time steps:

1. DNS: `seance-ca status` prints the box's Tailscale IP. At your registrar, add `A agent1` and `A *.agent1` pointing at it. Stable for the node's lifetime.
2. Trust: `ssh dev@agent1 seance-ca root > seance-root.crt`, then import — macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain seance-root.crt`; iOS: AirDrop, install, enable in Certificate Trust Settings.

Then `seance-expose add <name> <port>` serves an app immediately. Without a vanity domain, exposure falls back to `tailscale serve`.

## Agent auth

`agents` in tfvars picks which CLIs bootstrap installs. Install is automated; login is a one-time interactive step per box:

- **Claude Code (Max subscription):** `claude setup-token` on your laptop, put the result in the secrets `env` as `CLAUDE_CODE_OAUTH_TOKEN`. Don't also set `ANTHROPIC_API_KEY`, or billing switches to API credits. Or `ssh dev@agent1`, run `claude`, finish the login URL in your browser.
- **Codex (ChatGPT subscription):** `ssh -L 1455:localhost:1455 dev@agent1`, `codex login`, finish in browser. Or copy `~/.codex/auth.json` across.
- **Gemini:** `NO_BROWSER=true gemini` for a paste-URL flow, or `GEMINI_API_KEY` in secrets.
- **Cursor:** `cursor-agent login`, or `CURSOR_API_KEY` in secrets.

`seance-agents status` shows install/auth state. Credentials survive re-provisioning; the nuke shreds them.

## Project setup

`seance-setup-project <dir>` runs a headless Claude Code session (`config/setup-project.prompt.md`) that reads the repo's docs, installs/builds, verifies, and writes `AGENT_SETUP.md`. Repos come from `projects` in tfvars, the deploy key from `git_profiles` in secrets, per-project hints from the `setup_hint` field. Spends tokens; never runs automatically.

## Daily use

```bash
ssh dev@agent1
herdr        # one workspace per project; panes running `claude`
```

Sessions live in herdr/tmux, so disconnecting doesn't kill an agent. For long runs, launch detached (`nohup … > run.log &`) and poll the log.

Concurrent agents on one repo use git worktrees — each gets its own checkout and branch over one object store:

```bash
seance-worktree add /srv/projects/personal/webapp feat/pricing   # -> /srv/worktrees/webapp__feat-pricing
seance-worktree add /srv/projects/personal/webapp fix/auth main
seance-worktree ls; seance-worktree rm /srv/worktrees/webapp__fix-auth
```

One herdr pane per worktree. Preview two at once: `seance-expose add pricing 3000` and `seance-expose add auth 3001`.

### Helpers

| command | purpose |
|---|---|
| `seance-expose add <name> <port>` | serve a local port at `https://<name>.agent1.example.com/` (vhost write + nginx reload; WebSocket/HMR-safe) |
| `seance-expose ls` / `rm <name>` | list / remove |
| `seance-worktree add/ls/rm` | concurrent-agent checkouts |
| `seance-setup-project [--agent codex] <dir> [hint]` | bootstrap-agent session; any installed agent CLI |
| `seance-agents status` / `sudo seance-agents install <name>` | install/auth state of the agent CLIs |
| `seance-screenshot <url> [out.png] [--full]` | headless-Chromium screenshot; point at `localhost` |
| `seance-push-artifact <path> [prefix]` | copy to the sanctum account's S3 bucket |
| `sudo seance-secrets pull` / `seance-secrets status` | re-fetch and decrypt credentials after a rotation |
| `seance-fetch-secrets` | refresh the dev shell env after a pull |
| `seance-clone-projects` | clone newly added repos (existing clones untouched) |
| `seance-ca status/root` / `sudo seance-ca ensure` | cert + DNS info; print root; (re)issue |
| `sudo seance-nuke` | passphrase-gated wipe: secrets, CA, deploy keys, homes, worktrees, projects, Docker, tailnet identity; box stays up |

Re-provision after editing this repo: `cd /opt/seance && sudo git pull && sudo scripts/bootstrap.sh`.

## Security notes

- No inbound: the SG has no ingress rules; the vanity DNS records point at a 100.64/10 Tailscale address only your tailnet routes.
- The EC2 key pair is recovery-only — with no ingress there's nothing to connect to. It's for mounting the root volume elsewhere if the tailnet is down. An Instance Connect Endpoint would keep the zero-ingress property; an `emergency_ssh_cidr` rule would not.
- No static AWS keys. The instance role can only assume the sanctum role; that role can only push artifacts, read the secrets, and decrypt them. A compromised box can read every box's artifacts and the shared secrets (the role has no per-box condition), nothing else.
- Credentials are ciphertext everywhere outside the box: repo tree, terraform state, S3, transit. Plaintext exists only in your editor during a sops session and on the box's encrypted EBS volume.
- `ExternalId` blocks confused-deputy assumption from an unexpected principal in a trusted account. It does not restrict which principal inside that account can assume the role.
- On the box, decrypted secrets are root-only files, readable by the sudo-capable agent. Volume encryption, not `shred`, protects them at rest.
- The private CA root key never leaves the box. Nuking shreds it, so a rebuilt box needs re-trusting.
- The nuke passphrase stops an accidental trigger, not a determined process: the dev user has passwordless sudo.
- Agents have unrestricted egress. API-key spend caps are the backstop.

## Teardown

Drop a box: remove its `boxes` entry and apply, or `terraform destroy -target='module.primary["agent1"]'`; then remove it from the Tailscale console. The sanctum stack stays. Wipe a box but keep it running: `sudo seance-nuke`, then re-provision with `git clone <repo> /opt/seance && sudo /opt/seance/scripts/bootstrap.sh` — it re-pulls the secrets and rejoins the tailnet, and mints a new CA root that devices must re-trust.
