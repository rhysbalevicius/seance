variable "artifact_bucket_name" {
  description = "Globally-unique name for the artifacts bucket."
  type        = string
}

variable "secrets_bucket_name" {
  description = "Globally-unique name for the secrets bucket. Kept separate from the artifacts bucket so agent-facing grants can never reach credentials."
  type        = string
}

variable "secrets_kms_alias" {
  description = "Alias for the sops key, without the 'alias/' prefix."
  type        = string
  default     = "seance-secrets"
}

variable "secrets_dir" {
  description = <<-EOT
    Local directory holding the sops-encrypted secrets, relative to the stack that calls this module. Expected layout: shared.sops.yaml plus an optional boxes/<box-name>.sops.yaml per box. Every *.sops.yaml under boxes/ is uploaded automatically, so a new box's secrets need no terraform change.
  EOT
  type        = string
}

variable "allow_missing_secrets" {
  description = "Set true for the very first apply, before the KMS key exists and there is anything to encrypt. Any other time, a missing secrets/ directory means an incomplete working copy, and applying would delete the live secrets from the bucket."
  type        = bool
  default     = false
}

variable "trusted_account_ids" {
  description = <<-EOT
    AWS account IDs allowed to assume the seance access role. Add every account you intend to run a box in. Trusting the account root means any principal in that account that ALSO has an IAM policy granting sts:AssumeRole on this role can assume it -- the box instance role is the only one we grant that to.
  EOT
  type        = list(string)
}

variable "external_id" {
  description = <<-EOT
    ExternalId the box must present when assuming the role. Not confidential (it lands in the target account's terraform.tfvars), but it prevents confused-deputy mistakes. Pick a random string.
  EOT
  type        = string
}
