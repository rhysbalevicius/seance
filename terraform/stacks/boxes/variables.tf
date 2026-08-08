# Config splits two ways:
#   shared -- defaults every box inherits
#   boxes  -- per-box config; the map key is the box name
# A null field in a box entry means "inherit from shared".
#
# Neither holds credentials. Those live sops-encrypted under secrets/ and are
# uploaded by the sanctum stack, so this stack's state and the boxes' user_data
# contain no secret material at all.

variable "shared" {
  description = "Configuration every box inherits unless it overrides."
  type = object({
    repo_url            = string
    repo_ref            = optional(string, "main")
    sanctum_role_arn    = string
    sanctum_bucket      = string
    secrets_bucket      = string
    sanctum_region      = optional(string, "eu-north-1")
    sanctum_external_id = string
    agents              = optional(list(string), ["claude"])
    instance_type       = optional(string, "m7i.xlarge")
    root_volume_gb      = optional(number, 200)
    sops_version        = optional(string, "v3.13.1")
    tags                = optional(map(string), {})
    # Public SSH keys put on every box (e.g. your laptop). Per-box keys add to
    # these; you generate the private halves yourself, nothing is AWS-managed.
    ssh_authorized_keys = optional(list(string), [])
    projects = optional(list(object({
      profile    = string
      url        = string
      dir        = string
      ref        = optional(string)
      setup_hint = optional(string)
    })), [])
  })
}

variable "boxes" {
  description = <<-EOT
    One entry per box; the map key becomes the hostname, the Tailscale machine name, and the name of the optional per-box secrets overlay at secrets/boxes/<name>.sops.yaml. `target` names the aws provider alias -- and therefore the account and region -- the box lands in. Every other field is optional and falls back to var.shared. ssh_authorized_keys adds box-specific public keys on top of shared.ssh_authorized_keys.
  EOT
  type = map(object({
    target              = string
    vanity_domain       = optional(string)
    agents              = optional(list(string))
    instance_type       = optional(string)
    root_volume_gb      = optional(number)
    vpc_id              = optional(string)
    subnet_id           = optional(string)
    ami_id              = optional(string)
    tags                = optional(map(string))
    ssh_authorized_keys = optional(list(string))
    projects = optional(list(object({
      profile    = string
      url        = string
      dir        = string
      ref        = optional(string)
      setup_hint = optional(string)
    })))
  }))
  default = {}

  validation {
    # TARGETS: extend this list when you add a provider alias, or the box will
    # be silently skipped -- nothing else would tell you it was never created.
    condition     = alltrue([for b in var.boxes : contains(["primary"], b.target)])
    error_message = "Every box's target must name a wired aws provider alias. Add the provider block in providers.tf, the module block in main.tf, the merge() entry in outputs.tf, and the alias name here."
  }

  validation {
    condition     = alltrue([for name, b in var.boxes : can(regex("^[a-z0-9]([a-z0-9-]{0,35}[a-z0-9])?$", name))])
    error_message = "Box names must be DNS labels of at most 37 characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen."
  }
}
