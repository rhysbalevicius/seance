# Sanctum account side of the seance topology. Applied ONCE, in the account that
# owns the two durable things: the artifacts bucket and the secrets store.
# Target accounts never need anything from this module except its outputs,
# which go into the boxes stack's tfvars.
#
# The cross-account role exists for exactly three capabilities: push artifacts,
# read the encrypted secrets, decrypt them.

# --- Artifacts bucket -------------------------------------------------------

resource "aws_s3_bucket" "artifacts" {
  bucket = var.artifact_bucket_name
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- Secrets: KMS key -------------------------------------------------------
# Secrets are sops-encrypted on your laptop before terraform ever sees them, so
# what passes through here -- and what lands in terraform state -- is
# ciphertext. The box decrypts with kms:Decrypt through the role it already
# assumes, which is why no passphrase has to reach it and why this works on the
# very first boot. A passphrase-based scheme (ansible-vault and friends) cannot:
# the passphrase would have to ride in user_data, which is the thing we are
# getting away from.
#
# No key policy is set, so the default applies: the sanctum account's root
# delegates to IAM. Your admin identity gets Encrypt through its own policy,
# the seance-access role gets Decrypt through the policy below, and the box --
# a sanctum-account principal once it has assumed that role -- needs no
# cross-account grant on the key itself.

resource "aws_kms_key" "secrets" {
  description             = "seance: sops key for box secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { project = "seance" }
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.secrets_kms_alias}"
  target_key_id = aws_kms_key.secrets.key_id
}

# --- Secrets: bucket --------------------------------------------------------
# Deliberately not the artifacts bucket. Agents write artifacts, so that bucket
# accumulates broad grants over time; keeping credentials out of its blast
# radius costs nothing. Versioned, so a bad secrets push is one rollback away.

resource "aws_s3_bucket" "secrets" {
  bucket = var.secrets_bucket_name

  lifecycle {
    # The uploads below are driven by what is on the applier's disk, and
    # secrets/ is gitignored. Without this, a fresh clone or a second laptop
    # plans "0 to add, N to destroy" and quietly removes the live secrets from
    # the bucket -- every box's next pull then fails. The check block above
    # only warns; this stops the plan.
    precondition {
      condition     = var.allow_missing_secrets || fileexists(local.shared_secrets_file)
      error_message = "No secrets file at ${local.shared_secrets_file}. If this is the first apply and you have not encrypted anything yet, set allow_missing_secrets = true; otherwise your working copy is incomplete and applying would delete the live secrets from the bucket."
    }
  }
}

resource "aws_s3_bucket_versioning" "secrets" {
  bucket = aws_s3_bucket.secrets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "secrets" {
  bucket = aws_s3_bucket.secrets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.secrets.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "secrets" {
  bucket                  = aws_s3_bucket.secrets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- Secrets: uploads -------------------------------------------------------
# `source` rather than `content`: terraform streams the file and keeps only a
# hash in state. With `content` the bytes themselves would be stored, which for
# an aws_ssm_parameter is unavoidable and is why Parameter Store was the wrong
# home for this.
#
# The per-box overlay set comes from a directory listing, so adding a box's
# secrets is "drop in secrets/boxes/<name>.sops.yaml and apply" -- no variable
# to keep in sync with the boxes stack.

locals {
  shared_secrets_file = "${var.secrets_dir}/shared.sops.yaml"
  box_secrets_files   = try(fileset("${var.secrets_dir}/boxes", "*.sops.yaml"), toset([]))
}

check "shared_secrets_present" {
  assert {
    condition     = fileexists(local.shared_secrets_file)
    error_message = "No secrets file at ${local.shared_secrets_file}, so nothing was uploaded and boxes will fail to bootstrap. Expected on the first apply only: take secrets_kms_key_arn from the outputs, write .sops.yaml, seed the file from config/secrets.example.yaml, then apply again."
  }
}

resource "aws_s3_object" "shared_secrets" {
  count = fileexists(local.shared_secrets_file) ? 1 : 0

  bucket      = aws_s3_bucket.secrets.id
  key         = "secrets/shared.sops.yaml"
  source      = local.shared_secrets_file
  source_hash = try(filemd5(local.shared_secrets_file), null)
  kms_key_id  = aws_kms_key.secrets.arn
}

resource "aws_s3_object" "box_secrets" {
  for_each = local.box_secrets_files

  bucket      = aws_s3_bucket.secrets.id
  key         = "secrets/boxes/${each.value}"
  source      = "${var.secrets_dir}/boxes/${each.value}"
  source_hash = filemd5("${var.secrets_dir}/boxes/${each.value}")
  kms_key_id  = aws_kms_key.secrets.arn
}

# --- Cross-account access role ----------------------------------------------

data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [for id in var.trusted_account_ids : "arn:aws:iam::${id}:root"]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.external_id]
    }
  }
}

data "aws_iam_policy_document" "access" {
  statement {
    sid    = "PushArtifacts"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]
  }

  # Read-only: the box consumes secrets, it never writes them. Pushing is your
  # laptop's job, through terraform.
  statement {
    sid       = "ReadSecrets"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.secrets.arn}/*"]
  }

  statement {
    sid       = "DecryptSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role" "seance" {
  name                 = "seance-access"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600

  tags = { project = "seance" }
}

resource "aws_iam_role_policy" "seance" {
  name   = "seance-access"
  role   = aws_iam_role.seance.id
  policy = data.aws_iam_policy_document.access.json
}
