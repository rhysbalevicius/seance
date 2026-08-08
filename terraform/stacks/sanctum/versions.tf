terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # State for the sanctum stack is small and long-lived. Local state is fine to
  # start; move to an S3 backend later if more than one machine applies it.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = { project = "seance" }
  }
}
