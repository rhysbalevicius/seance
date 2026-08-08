output "sanctum_role_arn" {
  description = "Goes into the boxes stack's tfvars as shared.sanctum_role_arn."
  value       = aws_iam_role.seance.arn
}

output "artifact_bucket" {
  description = "Goes into the boxes stack's tfvars as shared.sanctum_bucket."
  value       = aws_s3_bucket.artifacts.bucket
}

output "secrets_bucket" {
  description = "Goes into the boxes stack's tfvars as shared.secrets_bucket."
  value       = aws_s3_bucket.secrets.bucket
}

output "secrets_kms_key_arn" {
  description = "Goes into .sops.yaml as the kms key for the creation rule. Needed before you can encrypt the first secrets file."
  value       = aws_kms_key.secrets.arn
}
