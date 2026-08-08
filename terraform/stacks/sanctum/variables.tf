variable "region" {
  description = "Region for the artifacts bucket, the secrets bucket and the sops key."
  type        = string
  default     = "eu-north-1"
}

variable "artifact_bucket_name" {
  description = "Globally-unique name for the artifacts bucket."
  type        = string
}

variable "secrets_bucket_name" {
  description = "Globally-unique name for the secrets bucket."
  type        = string
}

variable "secrets_dir" {
  description = "Local directory holding the sops-encrypted secrets. Empty string = secrets/ in the repo root, which is gitignored. Anchored on path.root, so it does not depend on where you run terraform from."
  type        = string
  default     = ""
}

variable "allow_missing_secrets" {
  description = "Set true for the first apply only, when there is no encrypted secrets file yet. Guards against a fresh clone wiping the live secrets."
  type        = bool
  default     = false
}

variable "trusted_account_ids" {
  description = "AWS account IDs allowed to assume the seance access role. Add every account you intend to run a box in."
  type        = list(string)
}

variable "external_id" {
  description = "ExternalId the box must present when assuming the role. Pick a random string."
  type        = string
}
