# One aws provider per (account, region) a box can land in. Terraform cannot
# for_each a provider block, so each target is declared by hand -- but that is
# the only per-account work: boxes themselves are just entries in var.boxes.
#
# Adding an account or a region takes three edits, all marked "TARGETS":
#   1. an aws provider block here with a new alias
#   2. the matching name in the `target` validation in variables.tf
#   3. a module block in main.tf and a line in the merge() in outputs.tf
#
# Region is a provider setting, so two boxes in different regions need two
# aliases even in the same account.

provider "aws" {
  alias  = "primary"
  region = "eu-north-1"

  default_tags {
    tags = { project = "seance" }
  }
}

# TARGETS: copy the block above for each additional account or region. Point
# it at the other account with an assume_role block or a named profile.
#
# provider "aws" {
#   alias  = "secondary"
#   region = "us-east-1"
#   assume_role {
#     role_arn = "arn:aws:iam::OTHER_ACCOUNT:role/YourTerraformRole"
#   }
#   default_tags {
#     tags = { project = "seance" }
#   }
# }

provider "tls" {}
