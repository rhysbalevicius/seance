output "sanctum_role_arn" {
  description = "Goes into the boxes stack's tfvars as shared.sanctum_role_arn."
  value       = module.sanctum.sanctum_role_arn
}

output "artifact_bucket" {
  description = "Goes into the boxes stack's tfvars as shared.sanctum_bucket."
  value       = module.sanctum.artifact_bucket
}

output "secrets_bucket" {
  description = "Goes into the boxes stack's tfvars as shared.secrets_bucket."
  value       = module.sanctum.secrets_bucket
}

output "secrets_kms_key_arn" {
  description = "Goes into .sops.yaml. Needed before you can encrypt the first secrets file."
  value       = module.sanctum.secrets_kms_key_arn
}
