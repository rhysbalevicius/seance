locals {
  # TARGETS: add each module block here, or its boxes vanish from the outputs.
  all = merge(module.primary)
}

output "boxes" {
  description = "Per box: instance id, VPC-internal IP, key pair name, and what to do next."
  value = { for name, m in local.all : name => {
    instance_id = m.instance_id
    private_ip  = m.private_ip
    key_name    = m.key_name
    next_step   = m.next_step
  } }
}

output "ssh_public_keys" {
  description = "Public half of each box's key pair, in authorized_keys format."
  value       = { for name, m in local.all : name => m.ssh_public_key }
}

output "ssh_private_keys" {
  description = <<-EOT
    Private half of each box's key pair, keyed by box name. Save one to disk with:
      terraform output -json ssh_private_keys | jq -r '."agent1"' > ~/.ssh/seance-agent1
      chmod 600 ~/.ssh/seance-agent1
    These also live in terraform state, so keep state private.
  EOT
  value       = { for name, m in local.all : name => m.ssh_private_key }
  sensitive   = true
}
