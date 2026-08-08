# The box itself. Its only cross-account coupling is the instance role's
# permission to assume the sanctum account's seance-access role, which can push
# artifacts and read the encrypted secrets, and nothing else.
#
# Network posture: ZERO ingress. The security group admits nothing; Tailscale
# establishes connectivity outbound (direct via NAT traversal or relayed over
# DERP), SSH is key-based over the tailnet against keys you generate off-box
# (var.ssh_authorized_keys), and web apps are exposed via nginx on the vanity
# domain (a manual wildcard record at the registrar pointing at the Tailscale
# IP -- publicly resolvable, tailnet-only routable) with certs from a private
# CA generated on the box. No public attack surface.
#
# Secrets do NOT travel through here. They sit sops-encrypted in the sanctum
# account's secrets bucket and the box fetches and decrypts them at first boot
# using the role it already assumes, so user_data -- which is readable via
# DescribeInstanceAttribute by anyone with EC2 read access in this account --
# carries only configuration. Rotating a credential is 'sops <file>', apply the
# sanctum stack, then 'sudo seance-secrets pull' on the box: no rebuild, and
# nothing to taint.

data "aws_ami" "ubuntu" {
  count       = var.ami_id == "" ? 1 : 0
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# --- Network ----------------------------------------------------------------

data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

data "aws_subnets" "available" {
  count = var.subnet_id == "" ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

locals {
  vpc_id = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id
  ami_id = var.ami_id != "" ? var.ami_id : data.aws_ami.ubuntu[0].id

  # sort() because DescribeSubnets ordering is not contractual: taking the raw
  # first element makes subnet_id -- a ForceNew attribute -- shift whenever a
  # subnet is added to or removed from the VPC.
  subnet_id = var.subnet_id != "" ? var.subnet_id : sort(data.aws_subnets.available[0].ids)[0]

  tags = merge(var.tags, { Name = var.box_name })
}

resource "aws_security_group" "box" {
  name_prefix = "${var.box_name}-"
  description = "seance: no ingress, all egress (Tailscale-only access)"
  vpc_id      = local.vpc_id

  egress {
    description = "all egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

# --- Instance role: assume sanctum (artifacts), nothing else ----------------

data "aws_iam_policy_document" "instance_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "assume_sanctum" {
  statement {
    effect    = "Allow"
    actions   = ["sts:AssumeRole"]
    resources = [var.sanctum_role_arn]
  }
}

resource "aws_iam_role" "box" {
  name_prefix        = "${var.box_name}-"
  assume_role_policy = data.aws_iam_policy_document.instance_trust.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "assume_sanctum" {
  name   = "assume-sanctum"
  role   = aws_iam_role.box.id
  policy = data.aws_iam_policy_document.assume_sanctum.json
}

resource "aws_iam_instance_profile" "box" {
  name_prefix = "${var.box_name}-"
  role        = aws_iam_role.box.name
  tags        = local.tags
}

# --- Instance ---------------------------------------------------------------

resource "aws_instance" "box" {
  ami                    = local.ami_id
  instance_type          = var.instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.box.id]
  iam_instance_profile   = aws_iam_instance_profile.box.name

  # No key_name on purpose: SSH keys are yours, generated off-box and installed
  # into the dev user's authorized_keys via user_data. Nothing AWS-managed.

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
    # AWS defaults this to 1, which is one hop short of the docker bridge:
    # containerised agents would silently lose the instance role, and with
    # it the only path to the sanctum account.
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  # Base64-wrapped so arbitrary content survives the shell heredocs; none of
  # it is sensitive (authorized_keys are public keys).
  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    box_name            = var.box_name
    sanctum_role_arn    = var.sanctum_role_arn
    sanctum_bucket      = var.sanctum_bucket
    sanctum_region      = var.sanctum_region
    sanctum_external_id = var.sanctum_external_id
    secrets_bucket      = var.secrets_bucket
    vanity_domain       = var.vanity_domain
    agents              = join(" ", var.agents)
    repo_url            = var.repo_url
    repo_ref            = var.repo_ref
    sops_version        = var.sops_version

    ssh_authorized_keys_b64 = base64encode(join("\n", var.ssh_authorized_keys))
    projects_b64            = base64encode(jsonencode(var.projects))
  })

  lifecycle {
    precondition {
      condition     = var.subnet_id != "" ? true : length(data.aws_subnets.available[0].ids) > 0
      error_message = "No subnets found in the target VPC. Set subnet_id explicitly, or point vpc_id at a VPC that has one."
    }

    # Everything here is ForceNew, and a replacement destroys the root volume
    # with whatever uncommitted agent work is on it. All three are pinned at
    # first apply so a routine plan can never propose one:
    #   user_data -- first-boot material; rotate on the box instead
    #   ami       -- Canonical republishes noble every few weeks
    #   subnet_id -- see the sort() note in locals
    # To move or rebuild deliberately: taint the instance, then apply.
    ignore_changes = [user_data, ami, subnet_id]
  }

  # The instance role is useless until its inline policy exists; without this
  # they are parallel branches off the role and can apply in either order.
  depends_on = [aws_iam_role_policy.assume_sanctum]

  tags = local.tags
}
