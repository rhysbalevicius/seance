locals {
  # TARGETS: add each module block here, or its boxes vanish from the outputs.
  all = merge(module.primary)
}

output "boxes" {
  description = "Per box: instance id, VPC-internal IP, and what to do next."
  value = { for name, m in local.all : name => {
    instance_id = m.instance_id
    private_ip  = m.private_ip
    next_step   = m.next_step
  } }
}
