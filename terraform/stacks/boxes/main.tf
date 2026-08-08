# Every box, in one state. Boxes sharing an account and region come from the
# for_each below; a second account or region means a second provider alias and
# a second module block, because Terraform cannot for_each a provider.

locals {
  # Resolve each box against the shared defaults here rather than inside the
  # module blocks, so the result stays usable as a for_each key set.
  boxes = { for name, b in var.boxes : name => {
    target         = b.target
    vanity_domain  = b.vanity_domain != null ? b.vanity_domain : ""
    agents         = b.agents != null ? b.agents : var.shared.agents
    instance_type  = b.instance_type != null ? b.instance_type : var.shared.instance_type
    root_volume_gb = b.root_volume_gb != null ? b.root_volume_gb : var.shared.root_volume_gb
    projects       = b.projects != null ? b.projects : var.shared.projects
    vpc_id         = b.vpc_id != null ? b.vpc_id : ""
    subnet_id      = b.subnet_id != null ? b.subnet_id : ""
    ami_id         = b.ami_id != null ? b.ami_id : ""
    dev_user       = b.dev_user != null ? b.dev_user : var.shared.dev_user
    tags           = merge(var.shared.tags, b.tags != null ? b.tags : {})
    # authorized_keys are additive: shared keys (e.g. your laptop) on every box,
    # plus any per-box keys.
    ssh_authorized_keys = concat(var.shared.ssh_authorized_keys, b.ssh_authorized_keys != null ? b.ssh_authorized_keys : [])
  } }
}

module "primary" {
  source    = "../../modules/box"
  for_each  = { for name, b in local.boxes : name => b if b.target == "primary" }
  providers = { aws = aws.primary }

  box_name            = each.key
  vanity_domain       = each.value.vanity_domain
  agents              = each.value.agents
  instance_type       = each.value.instance_type
  root_volume_gb      = each.value.root_volume_gb
  projects            = each.value.projects
  vpc_id              = each.value.vpc_id
  subnet_id           = each.value.subnet_id
  ami_id              = each.value.ami_id
  tags                = each.value.tags
  dev_user            = each.value.dev_user
  ssh_authorized_keys = each.value.ssh_authorized_keys

  repo_url            = var.shared.repo_url
  repo_ref            = var.shared.repo_ref
  sops_version        = var.shared.sops_version
  sanctum_role_arn    = var.shared.sanctum_role_arn
  sanctum_bucket      = var.shared.sanctum_bucket
  secrets_bucket      = var.shared.secrets_bucket
  sanctum_region      = var.shared.sanctum_region
  sanctum_external_id = var.shared.sanctum_external_id
}

# TARGETS: copy the block above for each additional provider alias. Only the
# module name, the for_each filter and the providers map change.
#
# module "secondary" {
#   source    = "../../modules/box"
#   for_each  = { for name, b in local.boxes : name => b if b.target == "secondary" }
#   providers = { aws = aws.secondary }
#   ... identical argument list ...
# }
