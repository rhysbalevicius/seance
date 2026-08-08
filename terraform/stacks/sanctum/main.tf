locals {
  # file functions resolve relative paths against the root module directory,
  # so anchor on path.root to stay independent of which stack calls the module.
  secrets_dir = var.secrets_dir != "" ? var.secrets_dir : "${path.root}/../../../secrets"
}

module "sanctum" {
  source = "../../modules/sanctum"

  artifact_bucket_name  = var.artifact_bucket_name
  secrets_bucket_name   = var.secrets_bucket_name
  secrets_dir           = local.secrets_dir
  allow_missing_secrets = var.allow_missing_secrets
  trusted_account_ids   = var.trusted_account_ids
  external_id           = var.external_id
}
